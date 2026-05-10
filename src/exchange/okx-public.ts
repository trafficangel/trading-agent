import { request } from 'undici';
import { logger } from '../lib/logger.js';
import { normalizeSymbol, splitSymbol } from './symbols.js';
import type {
  ExchangeKline,
  ExchangeOrderbook,
  ExchangeTicker,
  OiHistoryPoint,
  OrderbookLevel,
} from './types.js';

const BASE = 'https://www.okx.com';
const HEADERS_TIMEOUT = 5_000;
const BODY_TIMEOUT = 5_000;

/**
 * OKX-specific quirks vs Bybit/Binance:
 * - Symbol format: BASE-QUOTE-SWAP for perpetuals
 * - All numeric fields are strings in JSON
 * - Timestamps are strings in ms
 * - Orderbook quantities are in CONTRACTS, not base coin. Each contract for
 *   USDT-margined SWAPs equals a fixed amount of base coin (the "ctVal" of
 *   the instrument). For TON-USDT-SWAP that's 1 TON. For BTC-USDT-SWAP,
 *   0.01 BTC. We multiply by ctVal to normalize.
 */

type OkxResp<T> = { code: string; msg: string; data: T };

const ctValCache = new Map<string, { ctVal: number; ts: number }>();
const CT_VAL_TTL_MS = 60 * 60 * 1000; // contract values rarely change

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      headersTimeout: HEADERS_TIMEOUT,
      bodyTimeout: BODY_TIMEOUT,
    });
    if (res.statusCode >= 400) {
      logger.warn({ url, status: res.statusCode }, 'okx non-OK status');
      return null;
    }
    const body = (await res.body.json()) as OkxResp<T>;
    if (body.code !== '0') {
      logger.warn({ url, code: body.code, msg: body.msg }, 'okx error code');
      return null;
    }
    return body.data;
  } catch (err) {
    logger.error({ err, url }, 'okx request failed');
    return null;
  }
}

/** Fetch instrument's contract value (multiplier from contracts to base coin). */
async function getCtVal(canonical: string): Promise<number | null> {
  const cached = ctValCache.get(canonical);
  if (cached && Date.now() - cached.ts < CT_VAL_TTL_MS) return cached.ctVal;

  const sym = normalizeSymbol(canonical, 'okx');
  const data = await getJson<{ ctVal: string }[]>(
    `${BASE}/api/v5/public/instruments?instType=SWAP&instId=${sym}`,
  );
  if (!data || !data[0]) return null;
  const ctVal = Number(data[0].ctVal);
  if (!Number.isFinite(ctVal) || ctVal <= 0) return null;
  ctValCache.set(canonical, { ctVal, ts: Date.now() });
  return ctVal;
}

// === Ticker ===
type OkxTickerData = {
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  ts: string;
};

type OkxFundingData = {
  fundingRate: string;
  nextFundingTime: string;
};

type OkxOiData = {
  instId: string;
  oi: string; // in contracts
  oiCcy: string; // in base coin
  ts: string;
};

export async function getOkxTicker(canonical: string): Promise<ExchangeTicker | null> {
  const sym = normalizeSymbol(canonical, 'okx');
  const [ticker, funding, oi] = await Promise.all([
    getJson<OkxTickerData[]>(`${BASE}/api/v5/market/ticker?instId=${sym}`),
    getJson<OkxFundingData[]>(`${BASE}/api/v5/public/funding-rate?instId=${sym}`),
    getJson<OkxOiData[]>(`${BASE}/api/v5/public/open-interest?instType=SWAP&instId=${sym}`),
  ]);

  if (!ticker || !ticker[0]) return null;
  const lastPrice = Number(ticker[0].last);
  const open24 = Number(ticker[0].open24h);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

  const fundingRate = funding?.[0]?.fundingRate ? Number(funding[0].fundingRate) : null;
  const openInterest = oi?.[0]?.oiCcy ? Number(oi[0].oiCcy) : null;
  const priceChange24hPct =
    Number.isFinite(open24) && open24 > 0
      ? Math.round(((lastPrice - open24) / open24) * 10000) / 100
      : null;

  return {
    exchange: 'okx',
    symbol: canonical,
    lastPrice,
    fundingRate: Number.isFinite(fundingRate ?? NaN) ? fundingRate : null,
    openInterest: openInterest && Number.isFinite(openInterest) ? openInterest : null,
    openInterestUsd:
      openInterest && Number.isFinite(openInterest) ? openInterest * lastPrice : null,
    priceChange24hPct,
    fetchedAt: Date.now(),
  };
}

// === OI history ===
type OkxOiHistData = { instId: string; oi: string; oiCcy: string; ts: string };

export async function getOkxOiHistory(
  canonical: string,
  period: '5m' | '1H' | '4H' | '1D',
  limit: number,
): Promise<OiHistoryPoint[] | null> {
  const sym = normalizeSymbol(canonical, 'okx');
  // OKX uses "open-interest-history" with bar=<period>&limit=<n>
  const data = await getJson<OkxOiHistData[]>(
    `${BASE}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${splitSymbol(canonical)[0]}&begin=&end=&period=${period.toLowerCase()}`,
  );
  // Note: OKX's per-symbol historical OI is not as cleanly exposed as Bybit's.
  // For aggregator purposes we'll fall back to current OI snapshots compared
  // across calls. Returning null gracefully so aggregator skips OKX dimension
  // for delta calculations.
  if (!data) return null;
  return data
    .slice(0, limit)
    .map((r) => ({ ts: Number(r.ts), openInterest: Number(r.oiCcy ?? r.oi) }))
    .filter((p) => Number.isFinite(p.openInterest))
    .sort((a, b) => b.ts - a.ts);
}

// === Orderbook ===
type OkxBooksData = {
  bids: [string, string, string, string][]; // [price, qty(contracts), liq, orders]
  asks: [string, string, string, string][];
  ts: string;
};

export async function getOkxOrderbook(
  canonical: string,
  size: 5 | 10 | 20 | 50 | 100 | 400 = 400,
): Promise<ExchangeOrderbook | null> {
  const sym = normalizeSymbol(canonical, 'okx');
  const ctVal = await getCtVal(canonical);
  if (ctVal === null) {
    logger.warn({ symbol: canonical }, 'okx: ctVal lookup failed, skipping orderbook');
    return null;
  }

  const data = await getJson<OkxBooksData[]>(
    `${BASE}/api/v5/market/books?instId=${sym}&sz=${size}`,
  );
  if (!data || !data[0]) return null;

  const parseLevel = (l: [string, string, string, string]): OrderbookLevel | null => {
    const price = Number(l[0]);
    const contracts = Number(l[1]);
    if (!Number.isFinite(price) || !Number.isFinite(contracts) || price <= 0 || contracts <= 0) {
      return null;
    }
    const qty = contracts * ctVal; // contracts → base coin
    return { price, qty, usd: price * qty };
  };

  const bids = data[0].bids
    .map(parseLevel)
    .filter((x): x is OrderbookLevel => x !== null)
    .sort((a, b) => b.price - a.price);
  const asks = data[0].asks
    .map(parseLevel)
    .filter((x): x is OrderbookLevel => x !== null)
    .sort((a, b) => a.price - b.price);

  if (!bids[0] || !asks[0]) return null;
  const midPrice = (bids[0].price + asks[0].price) / 2;

  return { exchange: 'okx', symbol: canonical, midPrice, bids, asks, fetchedAt: Date.now() };
}

// === Klines ===
type OkxCandleRow = [
  string, // ts
  string, // o
  string, // h
  string, // l
  string, // c
  string, // vol (contracts)
  string, // volCcy (base coin)
  string, // volCcyQuote (USDT quote)
  string, // confirm
];

const OKX_BAR_MAP: Record<string, string> = {
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

export async function getOkxKlines(
  canonical: string,
  interval: '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
  limit: number,
): Promise<ExchangeKline[] | null> {
  const sym = normalizeSymbol(canonical, 'okx');
  const bar = OKX_BAR_MAP[interval];
  const data = await getJson<OkxCandleRow[]>(
    `${BASE}/api/v5/market/candles?instId=${sym}&bar=${bar}&limit=${limit}`,
  );
  if (!data) return null;
  // OKX returns newest-first. Reverse to oldest-first to match Binance.
  return [...data]
    .reverse()
    .map((k): ExchangeKline => ({
      start: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[6]), // base coin volume
      turnover: Number(k[7]), // USDT
    }))
    .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.volume));
}

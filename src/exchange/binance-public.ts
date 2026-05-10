import { request } from 'undici';
import { logger } from '../lib/logger.js';
import { normalizeSymbol } from './symbols.js';
import type {
  ExchangeKline,
  ExchangeOrderbook,
  ExchangeTicker,
  OiHistoryPoint,
  OrderbookLevel,
} from './types.js';

const BASE = 'https://fapi.binance.com';
const HEADERS_TIMEOUT = 5_000;
const BODY_TIMEOUT = 5_000;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      headersTimeout: HEADERS_TIMEOUT,
      bodyTimeout: BODY_TIMEOUT,
    });
    if (res.statusCode >= 400) {
      logger.warn({ url, status: res.statusCode }, 'binance non-OK status');
      return null;
    }
    return (await res.body.json()) as T;
  } catch (err) {
    logger.error({ err, url }, 'binance request failed');
    return null;
  }
}

// === Ticker (mark price + funding + 24h change) ===
type PremiumIndexResp = {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
};

type Ticker24Resp = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string; // e.g. "-1.27"
};

type OpenInterestResp = {
  symbol: string;
  openInterest: string;
  time: number;
};

/**
 * Fetch ticker + funding + OI in parallel and merge into a normalized shape.
 * Three Binance endpoints are needed because they live in separate routes.
 */
export async function getBinanceTicker(canonical: string): Promise<ExchangeTicker | null> {
  const sym = normalizeSymbol(canonical, 'binance');

  const [premium, ticker24, oi] = await Promise.all([
    getJson<PremiumIndexResp>(`${BASE}/fapi/v1/premiumIndex?symbol=${sym}`),
    getJson<Ticker24Resp>(`${BASE}/fapi/v1/ticker/24hr?symbol=${sym}`),
    getJson<OpenInterestResp>(`${BASE}/fapi/v1/openInterest?symbol=${sym}`),
  ]);

  if (!premium || !ticker24) {
    logger.warn({ symbol: canonical }, 'binance: ticker fetch incomplete');
    return null;
  }

  const lastPrice = Number(ticker24.lastPrice);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

  const fundingRate = Number(premium.lastFundingRate);
  const openInterest = oi ? Number(oi.openInterest) : null;
  const priceChange24hPct = Number(ticker24.priceChangePercent);

  return {
    exchange: 'binance',
    symbol: canonical,
    lastPrice,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
    openInterest: openInterest && Number.isFinite(openInterest) ? openInterest : null,
    openInterestUsd:
      openInterest && Number.isFinite(openInterest) ? openInterest * lastPrice : null,
    priceChange24hPct: Number.isFinite(priceChange24hPct) ? priceChange24hPct : null,
    fetchedAt: Date.now(),
  };
}

// === Open Interest history ===
type OiHistResp = { symbol: string; sumOpenInterest: string; timestamp: number }[];

export async function getBinanceOiHistory(
  canonical: string,
  period: '5m' | '15m' | '30m' | '1h' | '4h',
  limit: number,
): Promise<OiHistoryPoint[] | null> {
  const sym = normalizeSymbol(canonical, 'binance');
  const data = await getJson<OiHistResp>(
    `${BASE}/futures/data/openInterestHist?symbol=${sym}&period=${period}&limit=${limit}`,
  );
  if (!data) return null;
  // Binance returns oldest-first by default, but normalize anyway: we want
  // newest-first for consistency with Bybit.
  return data
    .map((r) => ({ ts: r.timestamp, openInterest: Number(r.sumOpenInterest) }))
    .filter((p) => Number.isFinite(p.openInterest))
    .sort((a, b) => b.ts - a.ts);
}

// === Orderbook ===
type DepthResp = {
  lastUpdateId: number;
  E: number; // event time
  T: number; // transaction time
  bids: [string, string][];
  asks: [string, string][];
};

export async function getBinanceOrderbook(
  canonical: string,
  limit: 5 | 10 | 20 | 50 | 100 | 500 | 1000 = 500,
): Promise<ExchangeOrderbook | null> {
  const sym = normalizeSymbol(canonical, 'binance');
  const data = await getJson<DepthResp>(`${BASE}/fapi/v1/depth?symbol=${sym}&limit=${limit}`);
  if (!data || !data.bids || !data.asks) return null;
  if (data.bids.length === 0 || data.asks.length === 0) return null;

  const parseLevel = (l: [string, string]): OrderbookLevel | null => {
    const price = Number(l[0]);
    const qty = Number(l[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return null;
    return { price, qty, usd: price * qty };
  };

  const bids = data.bids
    .map(parseLevel)
    .filter((x): x is OrderbookLevel => x !== null)
    .sort((a, b) => b.price - a.price);
  const asks = data.asks
    .map(parseLevel)
    .filter((x): x is OrderbookLevel => x !== null)
    .sort((a, b) => a.price - b.price);

  if (!bids[0] || !asks[0]) return null;
  const midPrice = (bids[0].price + asks[0].price) / 2;

  return { exchange: 'binance', symbol: canonical, midPrice, bids, asks, fetchedAt: Date.now() };
}

// === Klines ===
type KlineRow = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume (turnover in USDT for USDT-M)
  number, // number of trades
  string, // taker buy base
  string, // taker buy quote
  string, // ignore
];

export async function getBinanceKlines(
  canonical: string,
  interval: '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
  limit: number,
): Promise<ExchangeKline[] | null> {
  const sym = normalizeSymbol(canonical, 'binance');
  const data = await getJson<KlineRow[]>(
    `${BASE}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`,
  );
  if (!data) return null;
  // Binance returns oldest-first.
  return data
    .map((k): ExchangeKline => ({
      start: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      turnover: Number(k[7]),
    }))
    .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.volume));
}

/** Long/short account ratio (top traders). Returns ratio or null. */
type LsRatioResp = { symbol: string; longShortRatio: string; timestamp: number }[];

export async function getBinanceLsRatio(canonical: string): Promise<number | null> {
  const sym = normalizeSymbol(canonical, 'binance');
  const data = await getJson<LsRatioResp>(
    `${BASE}/futures/data/topLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`,
  );
  if (!data || !data[0]) return null;
  const r = Number(data[0].longShortRatio);
  return Number.isFinite(r) ? Math.round(r * 100) / 100 : null;
}

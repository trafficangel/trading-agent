import { request } from 'undici';
import { logger } from '../lib/logger.js';
import { normalizeSymbol } from './symbols.js';
import type { ExchangeKline, ExchangeOrderbook, ExchangeTicker, OrderbookLevel } from './types.js';

const BASE = 'https://api.bybit.com';

const tickerCache = new Map<string, { price: number; ts: number }>();
const CACHE_TTL_MS = 5_000;

const sentimentCache = new Map<string, { data: MarketSentiment; ts: number }>();
const SENTIMENT_TTL_MS = 30_000;

type TickerResp = {
  retCode: number;
  retMsg: string;
  result?: {
    list?: {
      symbol: string;
      lastPrice: string;
      markPrice?: string;
      fundingRate?: string;
      nextFundingTime?: string;
      openInterest?: string;
      openInterestValue?: string;
      prevPrice24h?: string;
      price24hPcnt?: string;
    }[];
  };
};

type OiHistoryResp = {
  retCode: number;
  retMsg: string;
  result?: { list?: { timestamp: string; openInterest: string }[] };
};

type LsRatioResp = {
  retCode: number;
  retMsg: string;
  result?: { list?: { timestamp: string; buyRatio: string; sellRatio: string }[] };
};

export type MarketSentiment = {
  symbol: string;
  lastPrice: number;
  /** funding rate for the *next* 8h window, e.g. 0.00018 == 0.018% */
  fundingRate: number | null;
  /** open interest in contracts/coins (Bybit returns symbol-base units) */
  openInterest: number | null;
  /** OI percent change vs 4 hours ago, e.g. +12.4 means OI grew 12.4% */
  oiDelta4hPct: number | null;
  /** OI percent change vs 24 hours ago */
  oiDelta24hPct: number | null;
  /** account-level long/short ratio, > 1 means more long accounts than short */
  longShortRatio: number | null;
  /** percent price change over the last 24h, side-agnostic (raw) */
  priceChange24hPct: number | null;
  fetchedAt: number;
};

/**
 * Public Bybit tickers endpoint — no API key, no rate-limit concerns at our
 * volume (1 symbol every 60s).
 */
export async function getLastPrice(symbol: string): Promise<number | null> {
  const cached = tickerCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.price;

  try {
    const res = await request(`${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`, {
      method: 'GET',
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    const body = (await res.body.json()) as TickerResp;
    if (body.retCode !== 0 || !body.result?.list?.[0]?.lastPrice) {
      logger.warn({ retCode: body.retCode, msg: body.retMsg, symbol }, 'bybit ticker non-OK');
      return null;
    }
    const price = Number(body.result.list[0].lastPrice);
    if (!Number.isFinite(price) || price <= 0) {
      logger.warn({ symbol, raw: body.result.list[0].lastPrice }, 'bybit ticker bad price');
      return null;
    }
    tickerCache.set(symbol, { price, ts: Date.now() });
    return price;
  } catch (err) {
    logger.error({ err, symbol }, 'bybit ticker request failed');
    return null;
  }
}

async function fetchTickerFull(symbol: string): Promise<TickerResp['result'] extends infer R ? R extends { list?: infer L } ? L extends (infer X)[] | undefined ? X | null : null : null : null> {
  try {
    const res = await request(`${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`, {
      method: 'GET',
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    const body = (await res.body.json()) as TickerResp;
    if (body.retCode !== 0) return null;
    return (body.result?.list?.[0] ?? null) as never;
  } catch {
    return null;
  }
}

async function fetchOiSeries(
  symbol: string,
  intervalTime: '1h' | '4h',
  limit: number,
): Promise<number[] | null> {
  try {
    const res = await request(
      `${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${intervalTime}&limit=${limit}`,
      { method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000 },
    );
    const body = (await res.body.json()) as OiHistoryResp;
    if (body.retCode !== 0 || !body.result?.list) return null;
    // Bybit returns newest-first.
    return body.result.list.map((r) => Number(r.openInterest)).filter((n) => Number.isFinite(n));
  } catch {
    return null;
  }
}

async function fetchLsRatio(symbol: string): Promise<number | null> {
  try {
    const res = await request(
      `${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=1`,
      { method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000 },
    );
    const body = (await res.body.json()) as LsRatioResp;
    if (body.retCode !== 0 || !body.result?.list?.[0]) return null;
    const buy = Number(body.result.list[0].buyRatio);
    const sell = Number(body.result.list[0].sellRatio);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || sell === 0) return null;
    return Math.round((buy / sell) * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Fetch a snapshot of Bybit market sentiment for a symbol — funding rate,
 * open interest deltas (4h and 24h), and long/short account ratio.
 * Cached for 30 seconds; safe to call from every LLM decision.
 */
export async function getMarketSentiment(symbol: string): Promise<MarketSentiment | null> {
  const cached = sentimentCache.get(symbol);
  if (cached && Date.now() - cached.ts < SENTIMENT_TTL_MS) return cached.data;

  const [ticker, oi1h, oi4h, lsRatio] = await Promise.all([
    fetchTickerFull(symbol),
    fetchOiSeries(symbol, '1h', 5), // 5 hourly snapshots → covers 4h delta
    fetchOiSeries(symbol, '4h', 7), // 7 × 4h = 24h delta
    fetchLsRatio(symbol),
  ]);

  if (!ticker || !ticker.lastPrice) {
    logger.warn({ symbol }, 'sentiment: ticker fetch failed');
    return null;
  }

  const lastPrice = Number(ticker.lastPrice);
  const fundingRate = ticker.fundingRate ? Number(ticker.fundingRate) : null;
  const openInterest = ticker.openInterest ? Number(ticker.openInterest) : null;
  const priceChange24hPct = ticker.price24hPcnt
    ? Math.round(Number(ticker.price24hPcnt) * 10000) / 100
    : null;

  const oiDelta4hPct =
    oi1h && oi1h.length >= 5 && oi1h[0] && oi1h[4] && oi1h[4]! > 0
      ? Math.round(((oi1h[0]! - oi1h[4]!) / oi1h[4]!) * 10000) / 100
      : null;
  const oiDelta24hPct =
    oi4h && oi4h.length >= 7 && oi4h[0] && oi4h[6] && oi4h[6]! > 0
      ? Math.round(((oi4h[0]! - oi4h[6]!) / oi4h[6]!) * 10000) / 100
      : null;

  const data: MarketSentiment = {
    symbol,
    lastPrice,
    fundingRate,
    openInterest,
    oiDelta4hPct,
    oiDelta24hPct,
    longShortRatio: lsRatio,
    priceChange24hPct,
    fetchedAt: Date.now(),
  };

  sentimentCache.set(symbol, { data, ts: Date.now() });
  return data;
}

// ============================================================
// Multi-exchange adapter API (matches binance-public + okx-public shapes).
// Internally reuses fetchTickerFull / fetchOiSeries / fetchLsRatio above.
// ============================================================

/**
 * Bybit ticker normalized to the cross-exchange shape. Used by the
 * multi-exchange aggregator alongside binance/okx variants.
 */
export async function getBybitTicker(canonical: string): Promise<ExchangeTicker | null> {
  const ticker = await fetchTickerFull(canonical);
  if (!ticker || !ticker.lastPrice) return null;

  const lastPrice = Number(ticker.lastPrice);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

  const fundingRate = ticker.fundingRate ? Number(ticker.fundingRate) : null;
  const openInterest = ticker.openInterest ? Number(ticker.openInterest) : null;
  const priceChange24hPct = ticker.price24hPcnt
    ? Math.round(Number(ticker.price24hPcnt) * 10000) / 100
    : null;

  return {
    exchange: 'bybit',
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

type OrderbookResp = {
  retCode: number;
  retMsg: string;
  result?: {
    s: string;
    a: [string, string][];
    b: [string, string][];
    ts: number;
    u: number;
  };
};

/**
 * Bybit orderbook (linear perp). max limit=200.
 */
export async function getBybitOrderbook(
  canonical: string,
  limit: 1 | 50 | 200 = 200,
): Promise<ExchangeOrderbook | null> {
  const sym = normalizeSymbol(canonical, 'bybit');
  try {
    const res = await request(
      `${BASE}/v5/market/orderbook?category=linear&symbol=${sym}&limit=${limit}`,
      { method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000 },
    );
    const body = (await res.body.json()) as OrderbookResp;
    if (body.retCode !== 0 || !body.result) {
      logger.warn(
        { retCode: body.retCode, msg: body.retMsg, symbol: canonical },
        'bybit orderbook non-OK',
      );
      return null;
    }
    const r = body.result;
    if (!r.b || !r.a || r.b.length === 0 || r.a.length === 0) return null;

    const parseLevel = (l: [string, string]): OrderbookLevel | null => {
      const price = Number(l[0]);
      const qty = Number(l[1]);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return null;
      return { price, qty, usd: price * qty };
    };

    const bids = r.b
      .map(parseLevel)
      .filter((x): x is OrderbookLevel => x !== null)
      .sort((a, b) => b.price - a.price);
    const asks = r.a
      .map(parseLevel)
      .filter((x): x is OrderbookLevel => x !== null)
      .sort((a, b) => a.price - b.price);

    if (!bids[0] || !asks[0]) return null;
    return {
      exchange: 'bybit',
      symbol: canonical,
      midPrice: (bids[0].price + asks[0].price) / 2,
      bids,
      asks,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.error({ err, symbol: canonical }, 'bybit orderbook request failed');
    return null;
  }
}

type BybitKlineResp = {
  retCode: number;
  retMsg: string;
  result?: { list?: string[][] };
};

const BYBIT_INTERVAL_MAP: Record<string, string> = {
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

/**
 * Bybit klines in normalized ExchangeKline shape. Used as fallback when
 * Binance is unreachable (e.g. for stop-cluster detection). Returns
 * oldest-first (matching Binance / OKX adapters) so callers can use a
 * single algorithm regardless of source.
 */
export async function getBybitKlines(
  canonical: string,
  interval: '5m' | '15m' | '30m' | '1h' | '4h' | '1d',
  limit: number,
): Promise<ExchangeKline[] | null> {
  const sym = normalizeSymbol(canonical, 'bybit');
  const bybitInterval = BYBIT_INTERVAL_MAP[interval];
  if (!bybitInterval) return null;
  try {
    const res = await request(
      `${BASE}/v5/market/kline?category=linear&symbol=${sym}&interval=${bybitInterval}&limit=${limit}`,
      { method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000 },
    );
    const body = (await res.body.json()) as BybitKlineResp;
    if (body.retCode !== 0 || !body.result?.list) return null;
    // Bybit returns newest-first; reverse to oldest-first.
    return [...body.result.list]
      .reverse()
      .map((k): ExchangeKline => ({
        start: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        turnover: Number(k[6]),
      }))
      .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.volume));
  } catch (err) {
    logger.error({ err, symbol: canonical, interval }, 'bybit kline request failed');
    return null;
  }
}

export function formatSentiment(s: MarketSentiment | null): string {
  if (!s) return '  (sentiment data unavailable)';
  const fr = s.fundingRate !== null ? `${(s.fundingRate * 100).toFixed(4)}%` : 'n/a';
  const oi = s.openInterest !== null ? s.openInterest.toLocaleString('en-US') : 'n/a';
  const o4 = s.oiDelta4hPct !== null ? `${s.oiDelta4hPct >= 0 ? '+' : ''}${s.oiDelta4hPct}%` : 'n/a';
  const o24 = s.oiDelta24hPct !== null ? `${s.oiDelta24hPct >= 0 ? '+' : ''}${s.oiDelta24hPct}%` : 'n/a';
  const ls = s.longShortRatio !== null ? s.longShortRatio.toFixed(2) : 'n/a';
  const p24 = s.priceChange24hPct !== null ? `${s.priceChange24hPct >= 0 ? '+' : ''}${s.priceChange24hPct}%` : 'n/a';
  return [
    `  funding rate (next 8h):  ${fr}`,
    `  open interest:           ${oi}`,
    `  OI 4h Δ:                 ${o4}`,
    `  OI 24h Δ:                ${o24}`,
    `  long/short account:      ${ls}`,
    `  price 24h Δ:             ${p24}`,
  ].join('\n');
}

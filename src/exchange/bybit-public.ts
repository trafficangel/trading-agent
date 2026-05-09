import { request } from 'undici';
import { logger } from '../lib/logger.js';

const BASE = 'https://api.bybit.com';

const tickerCache = new Map<string, { price: number; ts: number }>();
const CACHE_TTL_MS = 5_000;

type TickerResp = {
  retCode: number;
  retMsg: string;
  result?: { list?: { symbol: string; lastPrice: string; markPrice?: string }[] };
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

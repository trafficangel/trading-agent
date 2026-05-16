/**
 * Live active-positions feed — powers the "В работе прямо сейчас" card
 * on the home page + the JSON endpoint `/api/active-positions` that the
 * client polls every 10 seconds for fresh PnL.
 *
 * Each entry combines:
 *   - a row from the `decisions` table (entry, SL, side, open time)
 *   - the live last-price from Bybit's public ticker
 *   - the strategy's metadata from STRATEGY_CONFIGS
 * and computes the in-flight PnL (pct, USD on $1000 notional, R-multiple).
 *
 * Server-side cached for 8 seconds — clients poll every 10s, so we
 * never hit Bybit more than ~8 times per minute even with hundreds of
 * concurrent visitors. The home-page SSR also reads this cache for
 * its first paint so we don't double-fetch on load.
 */

import type { FastifyInstance } from 'fastify';
import { getStrategyActiveTrades } from '../strategies/live-stats.js';
import {
  STRATEGY_CONFIGS,
  formatStrategyTradeId,
  TRACK_C_NOTIONAL_USD,
} from '../strategies/track-c-config.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { logger } from '../lib/logger.js';

export type ActivePositionView = {
  /** Pre-formatted trade ID (e.g. "BNB#001") */
  tradeId: string;
  strategyCode: string;
  strategyName: string;
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  sl: number;
  slPct: number; // percent, e.g. 2.5
  openedAt: number; // unix ms
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
  pnlR: number;
  ageMs: number;
};

type Cache = { data: ActivePositionView[]; expires: number };
let cache: Cache | null = null;
const CACHE_TTL_MS = 8_000;

async function compute(): Promise<ActivePositionView[]> {
  const out: ActivePositionView[] = [];
  for (const [id, cfg] of Object.entries(STRATEGY_CONFIGS)) {
    if (!cfg.enabled) continue;
    const actives = getStrategyActiveTrades(id);
    if (actives.length === 0) continue;
    // Fetch current price once per strategy (all its open positions
    // share a symbol).
    const symbol = cfg.symbol ?? actives[0]?.side ?? null;
    if (!symbol) continue;
    let current: number | null = null;
    try {
      current = await getLastPrice(symbol);
    } catch (err) {
      logger.warn({ err, symbol }, 'active-positions: getLastPrice failed');
    }
    if (current == null) continue;
    for (const t of actives) {
      const num = t.strategyTradeNum ?? t.id;
      const sign = t.side === 'long' ? 1 : -1;
      const pnlPct = (sign * (current - t.entryPrice) / t.entryPrice) * 100;
      const pnlUsd = (pnlPct / 100) * TRACK_C_NOTIONAL_USD;
      const slDistPct = t.sl !== null
        ? Math.abs(t.sl - t.entryPrice) / t.entryPrice * 100
        : 0;
      const pnlR = slDistPct > 0 ? pnlPct / slDistPct : 0;
      out.push({
        tradeId: formatStrategyTradeId(cfg, num),
        strategyCode: cfg.code,
        strategyName: cfg.name ?? `${cfg.symbol ?? id} ${cfg.timeframe}m`,
        symbol,
        side: t.side,
        entry: t.entryPrice,
        sl: t.sl ?? t.entryPrice,
        slPct: cfg.slPct * 100,
        openedAt: t.entryAt,
        currentPrice: current,
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlUsd: Math.round(pnlUsd * 100) / 100,
        pnlR: Math.round(pnlR * 100) / 100,
        ageMs: Date.now() - t.entryAt,
      });
    }
  }
  // Sort newest-open first.
  out.sort((a, b) => b.openedAt - a.openedAt);
  return out;
}

/**
 * Cached read — same data the JSON endpoint serves. SSR uses this so
 * the home page's first paint doesn't double-fetch.
 */
export async function getActivePositionsCached(): Promise<ActivePositionView[]> {
  if (cache && Date.now() < cache.expires) return cache.data;
  const data = await compute();
  cache = { data, expires: Date.now() + CACHE_TTL_MS };
  return data;
}

export async function activePositionsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/active-positions', async (_req, reply) => {
    const data = await getActivePositionsCached();
    reply.header('Cache-Control', 'public, max-age=8');
    return { positions: data, fetchedAt: Date.now() };
  });
}

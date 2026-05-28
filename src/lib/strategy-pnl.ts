/**
 * Per-strategy expected monthly PnL on a $1000 notional, computed from
 * the SL-capped backtest simulation (Phase Q methodology).
 *
 * This is the "honest" expected return under OUR safety SL — it runs
 * the same simulateAtCap() used by the audit, normalised to a 30-day
 * month. Used by the Prof-cabinet target-profit calculator.
 *
 * Cached at module load (trade logs are static files shipped with the
 * repo; they only change on a new import + deploy).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { simulateAtCap, type AnalyzableTrade } from './sl-distribution.js';
import { STRATEGY_CONFIGS } from '../strategies/track-c-config.js';
import { logger } from './logger.js';

export type StrategyPnlEstimate = {
  strategyId: string;
  code: string;
  /** Display symbol e.g. "BCH". */
  coin: string;
  /** slPct used in the simulation (fraction). */
  slPct: number;
  /** Safe leverage for this strategy. */
  leverage: number;
  /** Expected monthly PnL in USD on a $1000 notional, SL-capped. */
  monthlyPnlPer1000: number;
};

type TradeLogFile = {
  tradesLog?: Array<AnalyzableTrade & { entryAt: number; exitAt: number; maePct?: number }>;
};

let cache: StrategyPnlEstimate[] | null = null;

function compute(): StrategyPnlEstimate[] {
  const out: StrategyPnlEstimate[] = [];
  for (const [id, cfg] of Object.entries(STRATEGY_CONFIGS)) {
    if (!cfg.enabled) continue;
    const path = resolve('src/strategies/data', `${id}.json`);
    if (!existsSync(path)) continue;
    let data: TradeLogFile;
    try {
      data = JSON.parse(readFileSync(path, 'utf8')) as TradeLogFile;
    } catch (err) {
      logger.warn({ err, id }, 'strategy-pnl: failed to read trade log');
      continue;
    }
    const trades = data.tradesLog;
    if (!Array.isArray(trades) || trades.length === 0) continue;

    const sim = simulateAtCap(
      trades.map((t) => ({ side: t.side, entryPrice: t.entryPrice, exitPrice: t.exitPrice, maePct: t.maePct })),
      cfg.slPct,
    );
    // period in days = first entry → last exit
    const firstAt = Math.min(...trades.map((t) => t.entryAt));
    const lastAt = Math.max(...trades.map((t) => t.exitAt));
    const days = Math.max(1, (lastAt - firstAt) / 86_400_000);
    // sim.netPnlPct is % of $1000 over the whole period. Normalise to month.
    const monthlyPnlPer1000 = (sim.netPnlPct / 100) * 1000 * (30 / days);

    out.push({
      strategyId: id,
      code: cfg.code,
      coin: (cfg.symbol ?? id).replace(/USDT$/, ''),
      slPct: cfg.slPct,
      leverage: cfg.maxSafeLeverage ?? 8,
      monthlyPnlPer1000: Math.round(monthlyPnlPer1000 * 100) / 100,
    });
  }
  // Sort by contribution desc.
  out.sort((a, b) => b.monthlyPnlPer1000 - a.monthlyPnlPer1000);
  return out;
}

/** All enabled strategies' monthly-PnL-per-$1000 estimates (cached). */
export function getStrategyPnlEstimates(): StrategyPnlEstimate[] {
  if (cache === null) cache = compute();
  return cache;
}

/** Sum of monthly PnL per $1000 across all enabled strategies. */
export function getTotalMonthlyPnlPer1000(): number {
  return getStrategyPnlEstimates().reduce((acc, s) => acc + s.monthlyPnlPer1000, 0);
}

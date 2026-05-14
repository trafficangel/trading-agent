import { db } from '../db/client.js';
import { TRACK_C_NOTIONAL_USD } from './track-c-config.js';

/**
 * Live performance stats for a single Track C strategy, computed from
 * the `decisions` table at request time. Pure read-only — does not mutate.
 *
 * The landing page renders these alongside the static backtest snapshot
 * so visitors see "here's the backtest, here's what's actually happening
 * since launch".
 */

export type StrategyLiveStats = {
  /** When the first decision was inserted (or null if none yet). */
  firstTradeAt: number | null;
  /** Closed trades (status='closed' with non-null pnl). */
  closed: number;
  wins: number;
  losses: number;
  /** Win-rate 0..1, undefined when closed=0. */
  winRate: number | null;
  /** Net realised PnL in USD (based on $1000 notional per trade). */
  netPnlUsd: number;
  /** Net realised PnL as % of $1000 notional (i.e. average return × N). */
  netPnlPct: number;
  /** Largest single winning trade USD. */
  largestWinUsd: number;
  /** Largest single losing trade USD. */
  largestLossUsd: number;
  /** Currently open Track C positions on this strategy. */
  open: number;
  /** Avg trade duration in minutes (closed trades only). */
  avgDurationMin: number | null;
  /** Exit-reason breakdown (closed trades only). */
  exitsStrategy: number;
  exitsSafetySL: number;
  exitsTimeGuard: number;
};

type Row = {
  status: string;
  pnl_pct: number | null;
  close_reason: string | null;
  force_close_reason: string | null;
  created_at: number;
  filled_at: number | null;
  closed_at: number | null;
};

const stmt = db.prepare<[string], Row>(`
  SELECT status, pnl_pct, close_reason, force_close_reason,
         created_at, filled_at, closed_at
  FROM decisions
  WHERE track = 'strategy' AND strategy_id = ?
`);

const firstAtStmt = db.prepare<[string], { created_at: number }>(`
  SELECT MIN(created_at) AS created_at
  FROM decisions
  WHERE track = 'strategy' AND strategy_id = ?
`);

export function getStrategyLiveStats(strategyId: string): StrategyLiveStats {
  const rows = stmt.all(strategyId);
  const first = firstAtStmt.get(strategyId);

  const stats: StrategyLiveStats = {
    firstTradeAt: first?.created_at ?? null,
    closed: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    netPnlUsd: 0,
    netPnlPct: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
    open: 0,
    avgDurationMin: null,
    exitsStrategy: 0,
    exitsSafetySL: 0,
    exitsTimeGuard: 0,
  };

  let sumPnlPct = 0;
  let sumDurMs = 0;
  let durCount = 0;
  let maxWinUsd = 0;
  let maxLossUsd = 0;

  for (const r of rows) {
    if (r.status === 'active' || r.status === 'pending') {
      stats.open++;
      continue;
    }
    if (r.status !== 'closed' || r.pnl_pct === null) continue;

    stats.closed++;
    sumPnlPct += r.pnl_pct;
    const usd = (r.pnl_pct / 100) * TRACK_C_NOTIONAL_USD;
    if (usd > 0) {
      stats.wins++;
      if (usd > maxWinUsd) maxWinUsd = usd;
    } else if (usd < 0) {
      stats.losses++;
      if (usd < maxLossUsd) maxLossUsd = usd;
    }

    // Exit reason buckets
    if (r.close_reason === 'sl_hit') stats.exitsSafetySL++;
    else if (r.force_close_reason === 'strategy_exit') stats.exitsStrategy++;
    else if (r.force_close_reason === 'time_guard') stats.exitsTimeGuard++;

    if (r.closed_at && (r.filled_at ?? r.created_at)) {
      sumDurMs += r.closed_at - (r.filled_at ?? r.created_at);
      durCount++;
    }
  }

  stats.netPnlPct = Math.round(sumPnlPct * 100) / 100;
  stats.netPnlUsd = Math.round((sumPnlPct / 100) * TRACK_C_NOTIONAL_USD * 100) / 100;
  stats.largestWinUsd = Math.round(maxWinUsd * 100) / 100;
  stats.largestLossUsd = Math.round(maxLossUsd * 100) / 100;
  if (stats.closed > 0) stats.winRate = stats.wins / stats.closed;
  if (durCount > 0) stats.avgDurationMin = Math.round(sumDurMs / durCount / 60000);

  return stats;
}

/** A closed Track C trade ready for landing-page rendering. */
export type LiveTradeRow = {
  id: number;
  side: 'long' | 'short';
  entryAt: number;       // unix ms (filled_at or created_at)
  entryPrice: number;
  exitAt: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  closeReason: string | null;       // 'sl_hit' | 'manual' | etc.
  forceCloseReason: string | null;  // 'strategy_exit' | 'time_guard' | etc.
};

type TradeRow = {
  id: number;
  side: string | null;
  entry: number | null;
  close_price: number | null;
  pnl_pct: number | null;
  close_reason: string | null;
  force_close_reason: string | null;
  filled_at: number | null;
  created_at: number;
  closed_at: number | null;
};

const recentTradesStmt = db.prepare<[string, number], TradeRow>(`
  SELECT id, side, entry, close_price, pnl_pct, close_reason,
         force_close_reason, filled_at, created_at, closed_at
  FROM decisions
  WHERE track = 'strategy' AND strategy_id = ?
    AND status = 'closed' AND pnl_pct IS NOT NULL
  ORDER BY closed_at DESC
  LIMIT ?
`);

/** Most recent N closed trades for the landing-page "Recent live trades"
 *  table. Includes only fully-closed decisions with a recorded pnl_pct. */
export function getStrategyRecentTrades(strategyId: string, limit = 50): LiveTradeRow[] {
  const rows = recentTradesStmt.all(strategyId, limit);
  const out: LiveTradeRow[] = [];
  for (const r of rows) {
    if (!r.side || (r.side !== 'long' && r.side !== 'short')) continue;
    if (r.entry === null || r.close_price === null) continue;
    if (r.closed_at === null || r.pnl_pct === null) continue;
    out.push({
      id: r.id,
      side: r.side,
      entryAt: r.filled_at ?? r.created_at,
      entryPrice: r.entry,
      exitAt: r.closed_at,
      exitPrice: r.close_price,
      pnlPct: r.pnl_pct,
      pnlUsd: (r.pnl_pct / 100) * TRACK_C_NOTIONAL_USD,
      closeReason: r.close_reason,
      forceCloseReason: r.force_close_reason,
    });
  }
  return out;
}

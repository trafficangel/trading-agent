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
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id = ?
`);

const firstAtStmt = db.prepare<[string], { created_at: number }>(`
  SELECT MIN(created_at) AS created_at
  FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id = ?
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
  /** Per-strategy sequential counter (T#001 ... T#NNN). Falls back
   *  to global id if NULL (legacy rows before migration 012). */
  strategyTradeNum: number | null;
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
  strategy_trade_num: number | null;
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
  SELECT id, strategy_trade_num, side, entry, close_price, pnl_pct, close_reason,
         force_close_reason, filled_at, created_at, closed_at
  FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id = ?
    AND status = 'closed' AND pnl_pct IS NOT NULL
  ORDER BY closed_at DESC
  LIMIT ?
`);

/** Currently-open Track C position for the strategy. Returned in the
 *  same row shape as recent trades (without exit price / close reason).
 *  Used on the landing page to show "позиция в работе" with a pulsing
 *  green dot, distinct from closed trades. */
export type ActiveTradeRow = {
  id: number;
  strategyTradeNum: number | null;
  side: 'long' | 'short';
  entryAt: number;
  entryPrice: number;
  sl: number | null;
};

type ActiveRow = {
  id: number;
  strategy_trade_num: number | null;
  side: string | null;
  entry: number | null;
  sl: number | null;
  filled_at: number | null;
  created_at: number;
};

const activeTradesStmt = db.prepare<[string], ActiveRow>(`
  SELECT id, strategy_trade_num, side, entry, sl, filled_at, created_at
  FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id = ?
    AND status IN ('active', 'pending')
  ORDER BY created_at DESC
`);

export function getStrategyActiveTrades(strategyId: string): ActiveTradeRow[] {
  const rows = activeTradesStmt.all(strategyId);
  const out: ActiveTradeRow[] = [];
  for (const r of rows) {
    if (r.side !== 'long' && r.side !== 'short') continue;
    if (r.entry === null) continue;
    out.push({
      id: r.id,
      strategyTradeNum: r.strategy_trade_num,
      side: r.side,
      entryAt: r.filled_at ?? r.created_at,
      entryPrice: r.entry,
      sl: r.sl,
    });
  }
  return out;
}

/** Aggregate stats for a strategy over a specific time window — used
 *  by the daily wrap report to show "today's" performance vs cumulative
 *  since launch. dayStartMs is the UTC midnight cutoff. */
export type StrategyDailyStats = {
  closed: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  netPnlPct: number;
  exitsStrategy: number;
  exitsSafetySL: number;
};

const dailyClosedStmt = db.prepare<[string, number], {
  pnl_pct: number;
  close_reason: string | null;
  force_close_reason: string | null;
}>(`
  SELECT pnl_pct, close_reason, force_close_reason
  FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id = ?
    AND status = 'closed' AND pnl_pct IS NOT NULL
    AND closed_at >= ?
`);

export function getStrategyDailyStats(strategyId: string, dayStartMs: number): StrategyDailyStats {
  const rows = dailyClosedStmt.all(strategyId, dayStartMs);
  const stats: StrategyDailyStats = {
    closed: 0, wins: 0, losses: 0,
    netPnlUsd: 0, netPnlPct: 0,
    exitsStrategy: 0, exitsSafetySL: 0,
  };
  let sumPct = 0;
  for (const r of rows) {
    stats.closed++;
    sumPct += r.pnl_pct;
    if (r.pnl_pct > 0) stats.wins++;
    else if (r.pnl_pct < 0) stats.losses++;
    if (r.close_reason === 'sl_hit') stats.exitsSafetySL++;
    else if (r.force_close_reason === 'strategy_exit') stats.exitsStrategy++;
  }
  stats.netPnlPct = Math.round(sumPct * 100) / 100;
  stats.netPnlUsd = Math.round((sumPct / 100) * TRACK_C_NOTIONAL_USD * 100) / 100;
  return stats;
}

/** All-strategies feed for the /strategies index page. Same row shape
 *  as the per-strategy table but with an extra `strategyId` so the UI
 *  can decorate each row with the coin / timeframe / name. */
export type LiveTradeFeedRow = LiveTradeRow & { strategyId: string };
export type ActiveTradeFeedRow = ActiveTradeRow & { strategyId: string };

const allActiveTradesStmt = db.prepare<[], ActiveRow & { strategy_id: string }>(`
  SELECT id, strategy_id, strategy_trade_num, side, entry, sl, filled_at, created_at
  FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id IS NOT NULL
    AND status IN ('active', 'pending')
  ORDER BY COALESCE(filled_at, created_at) DESC
`);

export function getAllActiveShadowTrades(): ActiveTradeFeedRow[] {
  const rows = allActiveTradesStmt.all();
  const out: ActiveTradeFeedRow[] = [];
  for (const r of rows) {
    if (r.side !== 'long' && r.side !== 'short') continue;
    if (r.entry === null) continue;
    out.push({
      id: r.id,
      strategyId: r.strategy_id,
      strategyTradeNum: r.strategy_trade_num,
      side: r.side,
      entryAt: r.filled_at ?? r.created_at,
      entryPrice: r.entry,
      sl: r.sl,
    });
  }
  return out;
}

const allClosedCountStmt = db.prepare<[], { n: number }>(`
  SELECT COUNT(*) AS n FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id IS NOT NULL
    AND status = 'closed' AND pnl_pct IS NOT NULL
`);
export function countAllClosedShadowTrades(): number {
  return allClosedCountStmt.get()?.n ?? 0;
}

const earliestShadowTradeStmt = db.prepare<[], { ts: number | null }>(`
  SELECT MIN(created_at) AS ts FROM decisions
  WHERE track = 'strategy' AND user_id IS NULL AND strategy_id IS NOT NULL
`);
/** Earliest shadow trade timestamp ever recorded — used by the
 *  /autotrading hero «работает с MMM YYYY» social-proof line so the
 *  date moves with the actual data instead of being a hardcoded string
 *  the operator has to remember to update. */
export function earliestShadowTradeAt(): number | null {
  return earliestShadowTradeStmt.get()?.ts ?? null;
}

/** Sort modes for the /strategies live feed. Default `close_desc` =
 *  newest closed at top (matches what most users expect). */
export type FeedSort = 'close_desc' | 'close_asc' | 'entry_desc' | 'entry_asc' | 'pnl_desc' | 'pnl_asc';

const FEED_ORDER_BY: Record<FeedSort, string> = {
  close_desc: 'closed_at DESC',
  close_asc:  'closed_at ASC',
  entry_desc: 'COALESCE(filled_at, created_at) DESC',
  entry_asc:  'COALESCE(filled_at, created_at) ASC',
  pnl_desc:   'pnl_pct DESC',
  pnl_asc:    'pnl_pct ASC',
};

// Pre-prepared statements per sort key — better-sqlite3 needs the
// ORDER BY clause at prepare-time so we build them once at module load.
const allClosedPageStmts: Record<FeedSort, ReturnType<typeof db.prepare<[number, number], TradeRow & { strategy_id: string }>>> =
  Object.fromEntries(
    (Object.entries(FEED_ORDER_BY) as [FeedSort, string][]).map(([key, orderBy]) => [
      key,
      db.prepare<[number, number], TradeRow & { strategy_id: string }>(`
        SELECT id, strategy_id, strategy_trade_num, side, entry, close_price, pnl_pct,
               close_reason, force_close_reason, filled_at, created_at, closed_at
        FROM decisions
        WHERE track = 'strategy' AND user_id IS NULL AND strategy_id IS NOT NULL
          AND status = 'closed' AND pnl_pct IS NOT NULL
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `),
    ]),
  ) as Record<FeedSort, ReturnType<typeof db.prepare<[number, number], TradeRow & { strategy_id: string }>>>;

export function getAllClosedShadowTrades(
  limit: number,
  offset: number,
  sort: FeedSort = 'close_desc',
): LiveTradeFeedRow[] {
  const stmt = allClosedPageStmts[sort] ?? allClosedPageStmts.close_desc;
  const rows = stmt.all(limit, offset);
  const out: LiveTradeFeedRow[] = [];
  for (const r of rows) {
    if (!r.side || (r.side !== 'long' && r.side !== 'short')) continue;
    if (r.entry === null || r.close_price === null) continue;
    if (r.closed_at === null || r.pnl_pct === null) continue;
    out.push({
      id: r.id,
      strategyId: r.strategy_id,
      strategyTradeNum: r.strategy_trade_num,
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

/* =====================================================================
 *  USER feed — per-user equivalents of getAll*ShadowTrades, used by the
 *  /account/trades page. The shape mirrors the shadow feed so the
 *  renderer can use the exact same table layout, but row notional comes
 *  from the user's own fill (bybit_qty × bybit_avg_price) instead of the
 *  constant shadow notional. PnL USD is recomputed from pnl_pct × that
 *  notional so display matches the user's actual wallet movement.
 * ===================================================================== */

export type UserActiveFeedRow = ActiveTradeFeedRow & { notionalUsd: number | null };
export type UserClosedFeedRow = LiveTradeFeedRow & { notionalUsd: number | null };

type UserActiveDbRow = ActiveRow & {
  strategy_id: string;
  bybit_qty: number | null;
  bybit_avg_price: number | null;
};

const userActiveTradesStmt = db.prepare<[number], UserActiveDbRow>(`
  SELECT id, strategy_id, strategy_trade_num, side, entry, sl,
         filled_at, created_at, bybit_qty, bybit_avg_price
  FROM decisions
  WHERE track = 'strategy' AND user_id = ? AND strategy_id IS NOT NULL
    AND status IN ('active', 'pending')
  ORDER BY COALESCE(filled_at, created_at) DESC
`);

export function getUserActiveTrades(userId: number): UserActiveFeedRow[] {
  const rows = userActiveTradesStmt.all(userId);
  const out: UserActiveFeedRow[] = [];
  for (const r of rows) {
    if (r.side !== 'long' && r.side !== 'short') continue;
    if (r.entry === null) continue;
    const notional =
      r.bybit_qty !== null && r.bybit_avg_price !== null
        ? r.bybit_qty * r.bybit_avg_price
        : null;
    out.push({
      id: r.id,
      strategyId: r.strategy_id,
      strategyTradeNum: r.strategy_trade_num,
      side: r.side,
      entryAt: r.filled_at ?? r.created_at,
      entryPrice: r.entry,
      sl: r.sl,
      notionalUsd: notional,
    });
  }
  return out;
}

const userClosedCountStmt = db.prepare<[number], { n: number }>(`
  SELECT COUNT(*) AS n FROM decisions
  WHERE track = 'strategy' AND user_id = ? AND strategy_id IS NOT NULL
    AND status = 'closed' AND pnl_pct IS NOT NULL
`);
export function countUserClosedTrades(userId: number): number {
  return userClosedCountStmt.get(userId)?.n ?? 0;
}

type UserClosedDbRow = TradeRow & {
  strategy_id: string;
  bybit_qty: number | null;
  bybit_avg_price: number | null;
};

const userClosedPageStmts: Record<FeedSort, ReturnType<typeof db.prepare<[number, number, number], UserClosedDbRow>>> =
  Object.fromEntries(
    (Object.entries(FEED_ORDER_BY) as [FeedSort, string][]).map(([key, orderBy]) => [
      key,
      db.prepare<[number, number, number], UserClosedDbRow>(`
        SELECT id, strategy_id, strategy_trade_num, side, entry, close_price, pnl_pct,
               close_reason, force_close_reason, filled_at, created_at, closed_at,
               bybit_qty, bybit_avg_price
        FROM decisions
        WHERE track = 'strategy' AND user_id = ? AND strategy_id IS NOT NULL
          AND status = 'closed' AND pnl_pct IS NOT NULL
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `),
    ]),
  ) as Record<FeedSort, ReturnType<typeof db.prepare<[number, number, number], UserClosedDbRow>>>;

export function getUserClosedTrades(
  userId: number,
  limit: number,
  offset: number,
  sort: FeedSort = 'close_desc',
): UserClosedFeedRow[] {
  const stmt = userClosedPageStmts[sort] ?? userClosedPageStmts.close_desc;
  const rows = stmt.all(userId, limit, offset);
  const out: UserClosedFeedRow[] = [];
  for (const r of rows) {
    if (!r.side || (r.side !== 'long' && r.side !== 'short')) continue;
    if (r.entry === null || r.close_price === null) continue;
    if (r.closed_at === null || r.pnl_pct === null) continue;
    const notional =
      r.bybit_qty !== null && r.bybit_avg_price !== null
        ? r.bybit_qty * r.bybit_avg_price
        : null;
    out.push({
      id: r.id,
      strategyId: r.strategy_id,
      strategyTradeNum: r.strategy_trade_num,
      side: r.side,
      entryAt: r.filled_at ?? r.created_at,
      entryPrice: r.entry,
      exitAt: r.closed_at,
      exitPrice: r.close_price,
      pnlPct: r.pnl_pct,
      // PnL USD on a user trade is anchored to the user's real notional,
      // not the $1000 shadow constant. Falls back to the shadow constant
      // for legacy rows that pre-date bybit_qty / bybit_avg_price columns.
      pnlUsd: (r.pnl_pct / 100) * (notional ?? TRACK_C_NOTIONAL_USD),
      closeReason: r.close_reason,
      forceCloseReason: r.force_close_reason,
      notionalUsd: notional,
    });
  }
  return out;
}

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
      strategyTradeNum: r.strategy_trade_num,
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

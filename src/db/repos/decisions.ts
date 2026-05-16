import { db } from '../client.js';

/**
 * decisions table — Track C (LuxAlgo Strategy Builder) trade records.
 *
 * Tracks A (LLM) and B (signal-trader) were removed in May 2026. The
 * `track` column is kept (for migration safety + historical data),
 * but only the value 'strategy' is written going forward. Other rows
 * remain readable for audit / debugging.
 *
 * Many columns (tp_json, screenshot_path, llm_input_tokens, confidence,
 * spider/limit fields, etc.) are legacy — populated as NULL for Track C.
 * They live on so that historical rows remain queryable and so that the
 * raw schema doesn't need a destructive migration.
 */

export type DecisionRow = {
  id: number;
  created_at: number;
  symbol: string;
  confluence_score: number;
  signal_ids: string;
  screenshot_path: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
  decision: string;
  side: string | null;
  entry: number | null;
  sl: number | null;
  tp_json: string | null;
  size_pct: number | null;
  confidence: number | null;
  reasoning_short: string | null;
  reasoning_full: string | null;
  raw_response: string;
  status: string;
  parent_decision_id: number | null;
  closed_at: number | null;
  sl_reason: string | null;
  tp_reason: string | null;
  invalidation: string | null;
  close_price: number | null;
  close_reason: string | null;
  pnl_pct: number | null;
  pnl_r: number | null;
  features_json: string | null;
  pending_until: number | null;
  filled_at: number | null;
  /** Always 'strategy' for new rows. Historical rows may be 'llm' / 'signal'. */
  track: string;
  /** Track C: strategy_id from LuxAlgo Strategy Builder. */
  strategy_id: string | null;
  /** The SL at the moment the trade was opened. Stable — never modified. */
  original_sl: number | null;
  /** Legacy (Track A multi-TP). Always 0/null for Track C. */
  partial_closed_pct: number;
  partial_close_price: number | null;
  partial_closed_at: number | null;
  tp1_price: number | null;
  /** Force-close reason ('strategy_exit' / 'reverse_signal' / 'time_guard'). */
  force_close_reason: string | null;
  /** Per-strategy sequential counter (1, 2, 3, ... within each strategy_id). */
  strategy_trade_num: number | null;
};

export type CloseReason = 'tp_hit' | 'sl_hit' | 'llm_close' | 'manual';

const insertStmt = db.prepare(`
  INSERT INTO decisions (
    created_at, symbol, confluence_score, signal_ids,
    screenshot_path, llm_input_tokens, llm_output_tokens,
    decision, side, entry, sl, tp_json, size_pct,
    confidence, reasoning_short, reasoning_full, raw_response,
    status, parent_decision_id,
    sl_reason, tp_reason, invalidation, features_json,
    pending_until, filled_at, track, original_sl, tp1_price, strategy_id,
    strategy_trade_num
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Per-strategy sequential counter for the post prefix ('T#001').
 *  Atomic when called inside the same Node event-loop tick as the
 *  subsequent INSERT (better-sqlite3 is sync). */
const maxStrategyNumStmt = db.prepare<[string], { n: number | null }>(`
  SELECT MAX(strategy_trade_num) AS n FROM decisions
  WHERE track = 'strategy' AND strategy_id = ?
`);

const findActiveStmt = db.prepare<[], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'active' AND decision = 'OPEN'
  ORDER BY created_at ASC
`);

const findByIdStmt = db.prepare<[number], DecisionRow>(
  'SELECT * FROM decisions WHERE id = ?',
);

const closePositionWithStatsStmt = db.prepare<[number, number, string, number, number, number]>(`
  UPDATE decisions
  SET status = 'closed', closed_at = ?, close_price = ?, close_reason = ?,
      pnl_pct = ?, pnl_r = ?
  WHERE id = ? AND status = 'active'
`);

const findActiveByStrategyStmt = db.prepare<[string, string], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'active' AND decision = 'OPEN'
    AND track = 'strategy' AND symbol = ? AND strategy_id = ?
  ORDER BY created_at DESC LIMIT 1
`);

/**
 * Minimal input for a Track C insert. All Track A/B-only fields
 * (LLM tokens, screenshots, spider setups, multi-TP, etc.) are
 * persisted as NULL — kept in the table schema for back-compat with
 * historical rows but no longer populated.
 */
export type InsertDecisionInput = {
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  sl: number;
  reasoningShort: string;
  reasoningFull: string;
  rawResponse: string;
  features?: Record<string, unknown> | null;
  strategyId: string;
};

export function insertDecision(input: InsertDecisionInput): number {
  // Track C: assign per-strategy sequential counter for the post prefix.
  // 1-based: first trade of STRAT-001 → strategy_trade_num=1, displayed
  // as T#001. Global decision.id remains the foreign-key primary key.
  const maxNum = maxStrategyNumStmt.get(input.strategyId)?.n ?? 0;
  const strategyTradeNum = maxNum + 1;

  const result = insertStmt.run(
    Date.now(),
    input.symbol,
    0, // confluence_score — legacy, Track C has no aggregator score
    JSON.stringify([]), // signal_ids — Track C has no upstream signal rows
    null, // screenshot_path
    null, // llm_input_tokens
    null, // llm_output_tokens
    'OPEN',
    input.side,
    input.entry,
    input.sl,
    null, // tp_json — Track C has no TP (exit via webhook)
    null, // size_pct — Track C uses fixed $1000 notional
    null, // confidence — Track C has no LLM confidence
    input.reasoningShort,
    input.reasoningFull,
    input.rawResponse,
    'active',
    null, // parent_decision_id
    null, // sl_reason
    null, // tp_reason
    null, // invalidation
    input.features ? JSON.stringify(input.features) : null,
    null, // pending_until — Track C is market-entry only
    null, // filled_at — set later when limit fills (n/a Track C)
    'strategy',
    input.sl, // original_sl — frozen at open time
    null, // tp1_price
    input.strategyId,
    strategyTradeNum,
  );
  return Number(result.lastInsertRowid);
}

/** All currently-active OPEN positions (any track). tpsl-monitor uses
 *  this to scan every active row for safety-SL hits and time-guard. */
export function findActivePositions(): DecisionRow[] {
  return findActiveStmt.all();
}

export function findDecisionById(id: number): DecisionRow | null {
  return findByIdStmt.get(id) ?? null;
}

/** Find the open Track C position for a given (symbol, strategy_id) pair.
 *  Used by:
 *    - strategy-trader entry path: guard against duplicate entries
 *    - strategy-trader exit path: locate the position to close
 *  Returns null if no active position exists. */
export function findActiveByStrategy(
  symbol: string,
  strategyId: string,
): DecisionRow | null {
  return findActiveByStrategyStmt.get(symbol, strategyId) ?? null;
}

/**
 * Compute realised PnL for an OPEN trade given its SL and a fill price.
 * pnl_pct: side-adjusted percent move from entry to close.
 * pnl_r: in R-multiples (1R = SL distance from entry).
 */
export function calcPnl(
  side: 'long' | 'short',
  entry: number,
  sl: number,
  closePrice: number,
): { pnlPct: number; pnlR: number } {
  const dir = side === 'long' ? 1 : -1;
  const pnlPct = ((closePrice - entry) / entry) * 100 * dir;
  const slDist = Math.abs(entry - sl);
  if (slDist === 0) return { pnlPct, pnlR: 0 };
  const pnlDist = Math.abs(closePrice - entry);
  const sign = pnlPct >= 0 ? 1 : -1;
  const pnlR = sign * (pnlDist / slDist);
  return {
    pnlPct: Math.round(pnlPct * 100) / 100,
    pnlR: Math.round(pnlR * 100) / 100,
  };
}

export type ClosePositionInput = {
  id: number;
  closePrice: number;
  closeReason: CloseReason;
  pnlPct: number;
  pnlR: number;
};

/**
 * Close a position with full exit stats. Returns true if the row was
 * actually closed by THIS call, false if the row was already closed
 * (another path got there first). Callers should skip subsequent side
 * effects (Telegram post, etc.) when this returns false.
 */
export function closePositionWithStats(input: ClosePositionInput): boolean {
  const result = closePositionWithStatsStmt.run(
    Date.now(),
    input.closePrice,
    input.closeReason,
    input.pnlPct,
    input.pnlR,
    input.id,
  );
  return result.changes > 0;
}

const forceCloseStmt = db.prepare<[number, number, string, number, number, string, number]>(`
  UPDATE decisions
  SET status = 'closed', closed_at = ?, close_price = ?, close_reason = ?,
      pnl_pct = ?, pnl_r = ?, force_close_reason = ?
  WHERE id = ? AND status = 'active'
`);

/**
 * Force-close a position (strategy_exit / reverse_signal / time_guard).
 * Same as closePositionWithStats but records WHY in force_close_reason.
 */
export function forceClose(input: {
  id: number;
  closePrice: number;
  closeReason: CloseReason;
  pnlPct: number;
  pnlR: number;
  forceReason: string;
}): boolean {
  const r = forceCloseStmt.run(
    Date.now(),
    input.closePrice,
    input.closeReason,
    input.pnlPct,
    input.pnlR,
    input.forceReason,
    input.id,
  );
  return r.changes > 0;
}

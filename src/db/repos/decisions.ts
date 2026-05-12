import { db } from '../client.js';
import type { Decision } from '../../llm/decision.schema.js';
import type { AggregatedScore } from '../../signals/aggregator.js';

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
    pending_until, filled_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const findPendingLimitsStmt = db.prepare<[], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'pending' AND decision = 'OPEN'
  ORDER BY created_at ASC
`);

const activatePendingStmt = db.prepare<[number, number]>(`
  UPDATE decisions
  SET status = 'active', filled_at = ?
  WHERE id = ? AND status = 'pending'
`);

const cancelPendingStmt = db.prepare<[number, number]>(`
  UPDATE decisions
  SET status = 'cancelled', closed_at = ?
  WHERE id = ? AND status = 'pending'
`);

const findActiveStmt = db.prepare<[], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'active' AND decision = 'OPEN'
  ORDER BY created_at ASC
`);

const findActiveBySymbolStmt = db.prepare<[string], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'active' AND decision = 'OPEN' AND symbol = ?
  ORDER BY created_at DESC LIMIT 1
`);

const closePositionStmt = db.prepare<[number, number]>(`
  UPDATE decisions SET status = 'closed', closed_at = ? WHERE id = ?
`);

const closePositionWithStatsStmt = db.prepare<[number, number, string, number, number, number]>(`
  UPDATE decisions
  SET status = 'closed', closed_at = ?, close_price = ?, close_reason = ?,
      pnl_pct = ?, pnl_r = ?
  WHERE id = ? AND status = 'active'
`);

const updateSlStmt = db.prepare<[number, number]>(`
  UPDATE decisions SET sl = ? WHERE id = ?
`);

const findByIdStmt = db.prepare<[number], DecisionRow>(
  'SELECT * FROM decisions WHERE id = ?',
);

const lastDecisionStmt = db.prepare<[string, string, number], DecisionRow>(`
  SELECT * FROM decisions
  WHERE symbol = ? AND side = ? AND created_at >= ?
  ORDER BY created_at DESC LIMIT 1
`);

export type InsertDecisionInput = {
  symbol: string;
  agg: AggregatedScore;
  decision: Decision;
  screenshotPath: string | null;
  inputTokens: number;
  outputTokens: number;
  rawResponse: string;
  /** id of the parent OPEN decision when this is a CLOSE/MODIFY follow-up */
  parentDecisionId?: number;
  /** Structured features extracted at decision time. Optional (chop-SKIP
   *  and other early-exit branches may not provide them). */
  features?: Record<string, unknown> | null;
  /** Override the default status. For limit orders we pass 'pending';
   *  default behavior (status='active' for OPEN) handles market orders. */
  statusOverride?: 'pending' | 'active' | 'final';
  /** TTL for pending limit orders. After this wall-clock ms, the limit
   *  will be auto-cancelled by tpsl-monitor. Null for market/non-limit. */
  pendingUntil?: number | null;
};

export function insertDecision(input: InsertDecisionInput): number {
  const winning = input.agg.side === 'long' ? input.agg.bullish : input.agg.bearish;
  // OPEN normally starts 'active'. For limit-entry OPEN we pass
  // statusOverride='pending' so the order sits in the queue until price
  // touches entry; non-OPEN decisions are 'final'.
  const defaultStatus = input.decision.decision === 'OPEN' ? 'active' : 'final';
  const status = input.statusOverride ?? defaultStatus;
  const result = insertStmt.run(
    Date.now(),
    input.symbol,
    winning,
    JSON.stringify(input.agg.signals.map((s) => s.id)),
    input.screenshotPath,
    input.inputTokens,
    input.outputTokens,
    input.decision.decision,
    input.decision.side ?? null,
    input.decision.entry ?? null,
    input.decision.sl ?? null,
    input.decision.tp.length ? JSON.stringify(input.decision.tp) : null,
    input.decision.size_pct ?? null,
    input.decision.confidence,
    input.decision.reasoning_short,
    input.decision.reasoning_full,
    input.rawResponse,
    status,
    input.parentDecisionId ?? null,
    input.decision.sl_reason ?? null,
    input.decision.tp_reason ?? null,
    input.decision.invalidation ?? null,
    input.features ? JSON.stringify(input.features) : null,
    input.pendingUntil ?? null,
    null, // filled_at — set later when limit fills
  );
  const newId = Number(result.lastInsertRowid);

  // Note: we deliberately do NOT auto-close the parent here for CLOSE
  // decisions any more — callers (LLM monitor, TP/SL monitor) call
  // closePositionWithStats() so they can record close_price + PnL atomically.
  return newId;
}

/** Mark closed without stats (legacy fallback — prefer closePositionWithStats). */
/** All pending limit orders (regardless of symbol). */
export function findPendingLimits(): DecisionRow[] {
  return findPendingLimitsStmt.all();
}

/**
 * Promote a pending limit to active (i.e., the limit just got filled).
 * Returns true if THIS call did the activation; false if someone else
 * already activated (race protection — only one fill per limit).
 */
export function activatePendingLimit(id: number, filledAt: number): boolean {
  const r = activatePendingStmt.run(filledAt, id);
  return r.changes > 0;
}

/**
 * Cancel an unfilled pending limit (expired, or LLM explicitly cancelled).
 * Returns true if THIS call cancelled it.
 */
export function cancelPendingLimit(id: number): boolean {
  const r = cancelPendingStmt.run(Date.now(), id);
  return r.changes > 0;
}

/**
 * Update the SL field of a position in-place. Used by:
 *  - the auto-BE rule in tpsl-monitor (move SL to entry on 1R)
 *  - the LLM monitor when MODIFY decisions are accepted (so subsequent
 *    TPSL polling uses the new SL, not the stale original).
 */
export function updatePositionSl(id: number, newSl: number): void {
  updateSlStmt.run(newSl, id);
}

export function closePosition(id: number): void {
  closePositionStmt.run(Date.now(), id);
}

/** All currently active OPEN positions across all symbols. */
export function findActivePositions(): DecisionRow[] {
  return findActiveStmt.all();
}

/** Active position on (symbol, side) — used to decide if a new OPEN should add or skip. */
/**
 * Return the active position on this symbol regardless of side, or null.
 * If both sides are open (shouldn't happen in our pipeline), returns the
 * most recent.
 */
export function findActivePosition(symbol: string): DecisionRow | null {
  return findActiveBySymbolStmt.get(symbol) ?? null;
}

const findActiveOrPendingBySymbolStmt = db.prepare<[string], DecisionRow>(`
  SELECT * FROM decisions
  WHERE decision = 'OPEN' AND symbol = ?
    AND (status = 'active' OR status = 'pending')
  ORDER BY created_at DESC LIMIT 1
`);

const findAllActiveOrPendingBySymbolStmt = db.prepare<[string], DecisionRow>(`
  SELECT * FROM decisions
  WHERE decision = 'OPEN' AND symbol = ?
    AND (status = 'active' OR status = 'pending')
  ORDER BY created_at DESC
`);

/**
 * Active OR pending-limit position on this symbol — single LATEST row.
 * Used as the decide-cron PRIMARY guard: while a limit is waiting for
 * fill on TON, we should NOT open another market position on TON.
 * Otherwise we'd end up with double exposure.
 *
 * For spider-mode (multi-limit, 2026-05-12), use findAllActiveOrPending()
 * which returns the FULL list so we can count slots and apply the
 * max-3-per-symbol cap.
 */
export function findActiveOrPendingPosition(symbol: string): DecisionRow | null {
  return findActiveOrPendingBySymbolStmt.get(symbol) ?? null;
}

/** All active or pending OPEN rows on this symbol. Spider-mode counts
 *  these to enforce "max 3 pending/active per symbol". */
export function findAllActiveOrPending(symbol: string): DecisionRow[] {
  return findAllActiveOrPendingBySymbolStmt.all(symbol);
}

export function findDecisionById(id: number): DecisionRow | null {
  return findByIdStmt.get(id) ?? null;
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
 * Close a position with full exit stats. Used by TP/SL monitor and LLM-driven
 * close. Returns true if the row was actually closed by THIS call, false if
 * the row was already closed (another path got there first — TPSL hit
 * concurrent with LLM CLOSE, etc.). Callers should skip subsequent side
 * effects (Telegram post, etc.) when this returns false to avoid duplicate
 * notifications.
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

/**
 * Has the LLM already produced a non-SKIP decision for (symbol, side) within
 * the cooldown window? Used to suppress spam.
 */
export function recentNonSkipDecision(
  symbol: string,
  side: 'long' | 'short',
  cooldownMs: number,
): DecisionRow | null {
  const since = Date.now() - cooldownMs;
  const row = lastDecisionStmt.get(symbol, side, since);
  if (!row) return null;
  return row.decision === 'SKIP' ? null : row;
}

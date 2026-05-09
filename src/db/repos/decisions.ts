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
};

export type CloseReason = 'tp_hit' | 'sl_hit' | 'llm_close' | 'manual';

const insertStmt = db.prepare(`
  INSERT INTO decisions (
    created_at, symbol, confluence_score, signal_ids,
    screenshot_path, llm_input_tokens, llm_output_tokens,
    decision, side, entry, sl, tp_json, size_pct,
    confidence, reasoning_short, reasoning_full, raw_response,
    status, parent_decision_id,
    sl_reason, tp_reason, invalidation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const findActiveStmt = db.prepare<[], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'active' AND decision = 'OPEN'
  ORDER BY created_at ASC
`);

const findActiveBySymbolSideStmt = db.prepare<[string, string], DecisionRow>(`
  SELECT * FROM decisions
  WHERE status = 'active' AND decision = 'OPEN' AND symbol = ? AND side = ?
  ORDER BY created_at DESC LIMIT 1
`);

const closePositionStmt = db.prepare<[number, number]>(`
  UPDATE decisions SET status = 'closed', closed_at = ? WHERE id = ?
`);

const closePositionWithStatsStmt = db.prepare<[number, number, string, number, number, number]>(`
  UPDATE decisions
  SET status = 'closed', closed_at = ?, close_price = ?, close_reason = ?,
      pnl_pct = ?, pnl_r = ?
  WHERE id = ?
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
};

export function insertDecision(input: InsertDecisionInput): number {
  const winning = input.agg.side === 'long' ? input.agg.bullish : input.agg.bearish;
  // OPEN starts 'active' (alive position to monitor); everything else is 'final'.
  const status = input.decision.decision === 'OPEN' ? 'active' : 'final';
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
  );
  const newId = Number(result.lastInsertRowid);

  // Note: we deliberately do NOT auto-close the parent here for CLOSE
  // decisions any more — callers (LLM monitor, TP/SL monitor) call
  // closePositionWithStats() so they can record close_price + PnL atomically.
  return newId;
}

/** Mark closed without stats (legacy fallback — prefer closePositionWithStats). */
export function closePosition(id: number): void {
  closePositionStmt.run(Date.now(), id);
}

/** All currently active OPEN positions across all symbols. */
export function findActivePositions(): DecisionRow[] {
  return findActiveStmt.all();
}

/** Active position on (symbol, side) — used to decide if a new OPEN should add or skip. */
export function findActiveOnSide(symbol: string, side: 'long' | 'short'): DecisionRow | null {
  return findActiveBySymbolSideStmt.get(symbol, side) ?? null;
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

/** Close a position with full exit stats. Used by TP/SL monitor and LLM-driven close. */
export function closePositionWithStats(input: ClosePositionInput): void {
  closePositionWithStatsStmt.run(
    Date.now(),
    input.closePrice,
    input.closeReason,
    input.pnlPct,
    input.pnlR,
    input.id,
  );
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

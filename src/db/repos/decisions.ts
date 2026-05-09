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
};

const insertStmt = db.prepare(`
  INSERT INTO decisions (
    created_at, symbol, confluence_score, signal_ids,
    screenshot_path, llm_input_tokens, llm_output_tokens,
    decision, side, entry, sl, tp_json, size_pct,
    confidence, reasoning_short, reasoning_full, raw_response,
    status, parent_decision_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
  const newId = Number(result.lastInsertRowid);

  // CLOSE flips the parent to 'closed'.
  if (input.decision.decision === 'CLOSE' && input.parentDecisionId) {
    closePositionStmt.run(Date.now(), input.parentDecisionId);
  }
  return newId;
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

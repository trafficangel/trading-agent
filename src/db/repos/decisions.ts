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
};

const insertStmt = db.prepare(`
  INSERT INTO decisions (
    created_at, symbol, confluence_score, signal_ids,
    screenshot_path, llm_input_tokens, llm_output_tokens,
    decision, side, entry, sl, tp_json, size_pct,
    confidence, reasoning_short, reasoning_full, raw_response
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

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
};

export function insertDecision(input: InsertDecisionInput): number {
  const winning = input.agg.side === 'long' ? input.agg.bullish : input.agg.bearish;
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
  );
  return Number(result.lastInsertRowid);
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

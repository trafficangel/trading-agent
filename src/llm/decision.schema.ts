import { z } from 'zod';

export const DecisionType = z.enum(['OPEN', 'SKIP', 'CLOSE', 'MODIFY']);
export type DecisionType = z.infer<typeof DecisionType>;

export const DecisionSide = z.enum(['long', 'short']);
export type DecisionSide = z.infer<typeof DecisionSide>;

/**
 * Schema enforced on Claude's JSON response. We keep it tight: model MUST
 * return exactly this shape. Our retry logic catches violations and feeds the
 * issues back to the model.
 */
export const Decision = z.object({
  decision: DecisionType,
  side: DecisionSide.optional(),
  entry: z.number().positive().optional(),
  sl: z.number().positive().optional(),
  tp: z.array(z.number().positive()).max(5).default([]),
  size_pct: z.number().min(0).max(2).optional(),
  confidence: z.number().min(0).max(1),
  reasoning_short: z.string().min(1).max(220),
  reasoning_full: z.string().min(1).max(2000),
});
export type Decision = z.infer<typeof Decision>;

/** JSON-Schema string representation for inclusion in the system prompt. */
export const DECISION_JSON_SCHEMA = `{
  "decision": "OPEN" | "SKIP" | "CLOSE" | "MODIFY",
  "side": "long" | "short"  // required when decision == OPEN
  "entry": number > 0,       // required when decision == OPEN
  "sl": number > 0,          // required when decision == OPEN
  "tp": [number > 0, ...],   // 1-5 take-profit levels, ordered nearest first
  "size_pct": number 0..2,   // % of equity to risk; required when decision == OPEN
  "confidence": number 0..1, // your honest confidence in this trade
  "reasoning_short": string, // <=220 chars; goes to Telegram
  "reasoning_full":  string  // <=2000 chars; the why, in detail
}`;

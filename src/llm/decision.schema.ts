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
// Helper: accept null/undefined as "not provided" — Claude often emits null
// for inapplicable fields on SKIP decisions, which is fine for us.
const opt = <T extends z.ZodTypeAny>(s: T) =>
  s.nullable().optional().transform((v) => (v == null ? undefined : v));

export const Decision = z.object({
  decision: DecisionType,
  side: opt(DecisionSide),
  entry: opt(z.number().positive()),
  sl: opt(z.number().positive()),
  // Single TP for now (we keep an array shape so we can grow to TP1/TP2 later
  // without breaking the storage format).
  tp: z
    .array(z.number().positive())
    .max(1)
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  size_pct: opt(z.number().min(0).max(2)),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .transform((v) => v ?? 0),
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

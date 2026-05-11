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

// Numeric variant that also treats 0 / negatives as "not set". The model
// sometimes returns {entry: 0, sl: 0, ...} for SKIP decisions instead of
// {entry: null, sl: null, ...} — both should be valid. We can't use
// z.number().positive() inside opt() because .positive() throws BEFORE
// .nullable() / .optional() get a chance to handle null. So we accept
// any number and coerce non-positives to undefined.
const optPositive = () =>
  z
    .number()
    .nullable()
    .optional()
    .transform((v) => (v == null || v <= 0 ? undefined : v));

// Same for strings — model sometimes returns "" instead of null on SKIP.
const optString = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v == null || v.length === 0 ? undefined : v));

export const Decision = z.object({
  decision: DecisionType,
  side: opt(DecisionSide),
  entry: optPositive(),
  sl: optPositive(),
  // Single TP for now (we keep an array shape so we can grow to TP1/TP2 later
  // without breaking the storage format).
  tp: z
    .array(z.number())
    .max(1)
    .nullable()
    .optional()
    .transform((v) => (v ?? []).filter((n) => n > 0)),
  size_pct: z
    .number()
    .nullable()
    .optional()
    .transform((v) => (v == null || v <= 0 ? undefined : Math.min(v, 2))),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .transform((v) => v ?? 0),
  reasoning_short: z.string().min(1).max(220),
  reasoning_full: z.string().min(1).max(2000),
  /** brief Russian explanation of WHY the SL is exactly at d.sl */
  sl_reason: optString(120),
  /** brief Russian explanation of WHY the TP is exactly at d.tp[0] */
  tp_reason: optString(120),
  /** condition that fully invalidates the idea (stronger than SL alone) */
  invalidation: optString(160),
});
export type Decision = z.infer<typeof Decision>;

/** JSON-Schema string representation for inclusion in the system prompt. */
export const DECISION_JSON_SCHEMA = `{
  "decision": "OPEN" | "SKIP" | "CLOSE" | "MODIFY",
  "side": "long" | "short",   // required when decision == OPEN
  "entry": number > 0,        // required when decision == OPEN
  "sl":    number > 0,        // required when decision == OPEN
  "tp":    [number > 0],      // EXACTLY ONE take-profit level for OPEN; [] otherwise
  "size_pct":   number 0..2,  // % of equity to risk; required when decision == OPEN
  "confidence": number 0..1,  // your honest confidence in this trade
  "reasoning_short": string,  // <=220 chars; goes to Telegram
  "reasoning_full":  string,  // <=2000 chars; the why, in detail
  // For OPEN/MODIFY only — concrete justifications shown next to the levels:
  "sl_reason":     string,    // <=120 chars, Russian. Example: "за свинг-хаем 14:00, ликвидность зачищена"
  "tp_reason":     string,    // <=120 chars, Russian. Example: "equal lows на 1H, зона спроса 2.37"
  "invalidation":  string     // <=160 chars, Russian. Example: "пробой 2.4750 с закрытием 15m выше"
}`;

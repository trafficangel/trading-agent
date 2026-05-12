import { z } from 'zod';

export const DecisionType = z.enum(['OPEN', 'SKIP', 'CLOSE', 'MODIFY']);
export type DecisionType = z.infer<typeof DecisionType>;

export const DecisionSide = z.enum(['long', 'short']);
export type DecisionSide = z.infer<typeof DecisionSide>;

export const EntryType = z.enum(['market', 'limit']);
export type EntryType = z.infer<typeof EntryType>;

/**
 * Trade horizon — affects R:R floor, max SL distance and confidence floor.
 *
 * - `scalp`  = 1–3 свечи 15m, TP 0.8–1.5%, SL 0.4–0.9%, R:R floor 1.2.
 *              Requires confidence ≥ 0.50. Used for clean OB-retests / walls
 *              with tight invalidation and fast expected resolution.
 * - `swing`  = несколько часов, TP ≥ 2%, SL ≥ 0.8%, R:R floor 1.5.
 *              Confidence floor 0.40. Used when confluence aligns with the
 *              4H structural trend.
 *
 * Defaults to `swing` if model omits — keeps back-compat with old decisions
 * stored before this field existed.
 */
export const TpStrategy = z.enum(['scalp', 'swing']);
export type TpStrategy = z.infer<typeof TpStrategy>;

/**
 * "Spider" setups — additional limit orders the model places at structural
 * levels (OB / wall / VAH / VAL / swing high-low) ALONGSIDE the primary
 * decision. The idea is to cast a wider net: many small limits in both
 * directions at obvious technical levels, waiting for one to fire.
 *
 * Hard constraints (enforced by risk gate):
 *   - R:R MUST be ≥ 3.0 (the whole point — winners must cover losers)
 *   - SL distance: 0.3% to 2.0% (small enough to be cheap if wrong)
 *   - size_pct fixed at 0.25% (small — multiple may fill)
 *   - max 2 spider setups per decide call
 *   - max 3 total pending+active per symbol (1 primary + 2 spiders)
 *
 * Side can DIFFER from primary direction — that's the "web" point.
 */
export const SpiderSetup = z
  .object({
    side: DecisionSide,
    entry: z.number().positive(),
    sl: z.number().positive(),
    tp: z.number().positive(),
    /** Why this LEVEL specifically — must cite a structural anchor.
     *  Short form, ≤160 chars Russian. */
    level_reason: z.string().min(1).max(160),
  })
  .strict();
export type SpiderSetup = z.infer<typeof SpiderSetup>;

/**
 * Schema enforced on Claude's JSON response. We keep it tight: model MUST
 * return exactly this shape. Our retry logic catches violations and feeds the
 * issues back to the model.
 */
// Helper: accept null/undefined/empty-string as "not provided" — Claude
// emits any of these for inapplicable fields on SKIP decisions. We coerce
// at the preprocess stage so .enum(...) and other strict schemas never see
// '' or null.
const opt = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    s.optional(),
  );

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

// Same for strings — model sometimes returns "" instead of null on SKIP,
// or runs slightly over the char cap (Claude doesn't count characters
// reliably). We truncate-then-validate rather than reject so a 125-char
// sl_reason that exceeded the 120 cap doesn't blow up the whole parse.
const optString = (max: number) =>
  z.preprocess(
    (v) => {
      if (v == null) return undefined;
      if (typeof v !== 'string') return undefined;
      if (v.length === 0) return undefined;
      return v.length > max ? v.slice(0, max) : v;
    },
    z.string().min(1).max(max).optional(),
  );

export const Decision = z.object({
  decision: DecisionType,
  side: opt(DecisionSide),
  /** How the model wants this trade entered. 'market' = take it now at
   *  current price; 'limit' = wait for price to retest the `entry` level.
   *  Default 'market' when omitted (back-compat with old decisions).
   *  In Stage-2 shadow this field is metadata only — execution doesn't
   *  branch on it. In Stage-3 testnet the executor will use it to
   *  decide between market and limit order types. */
  entry_type: opt(EntryType),
  /** Trade horizon — scalp (tight, fast) or swing (wider, longer). See
   *  TpStrategy comment above. Defaults to 'swing' for OPEN decisions
   *  when omitted. */
  tp_strategy: opt(TpStrategy),
  entry: optPositive(),
  sl: optPositive(),
  // Single TP for now (we keep an array shape so we can grow to TP1/TP2 later
  // without breaking the storage format). If model returns multiple TPs we
  // silently keep the first valid one rather than throwing — extra TPs are
  // a hint not a contract violation.
  tp: z
    .array(z.number())
    .nullable()
    .optional()
    .transform((v) => (v ?? []).filter((n) => n > 0).slice(0, 1)),
  size_pct: z
    .number()
    .nullable()
    .optional()
    .transform((v) => (v == null || v <= 0 ? undefined : Math.min(v, 2))),
  // Clamp confidence to [0,1] rather than reject — model occasionally
  // produces 1.5 ("very high confidence") or -0.1 (typo). Either gets
  // pinned to the valid range.
  confidence: z
    .number()
    .nullable()
    .optional()
    .transform((v) => (v == null ? 0 : Math.max(0, Math.min(1, v)))),
  // Length caps generous enough that Claude's natural-length explanations
  // pass without truncation tricks. Previously 220/2000 — the model often
  // ran 1.5x over when given the new orderbook + stop-cluster context.
  // We truncate-on-overflow rather than reject (matches optString behavior).
  reasoning_short: z.preprocess(
    (v) => (typeof v === 'string' && v.length > 400 ? v.slice(0, 400) : v),
    z.string().min(1).max(400),
  ),
  reasoning_full: z.preprocess(
    (v) => (typeof v === 'string' && v.length > 5000 ? v.slice(0, 5000) : v),
    z.string().min(1).max(5000),
  ),
  /** brief Russian explanation of WHY the SL is exactly at d.sl */
  sl_reason: optString(120),
  /** brief Russian explanation of WHY the TP is exactly at d.tp[0] */
  tp_reason: optString(120),
  /** condition that fully invalidates the idea (stronger than SL alone) */
  invalidation: optString(160),
  /** Optional array of additional limit setups at structural levels.
   *  Up to 2. Independent from the primary decision — can be opposite
   *  direction. All must satisfy R:R ≥ 3.0. See SpiderSetup. Callers
   *  should normalize via `decision.spider_setups ?? []` since this is
   *  `optional` (kept optional rather than transformed so old/missing
   *  decisions stay type-compatible). */
  spider_setups: z.array(SpiderSetup).max(2).optional(),
});
export type Decision = z.infer<typeof Decision>;

/** JSON-Schema string representation for inclusion in the system prompt. */
export const DECISION_JSON_SCHEMA = `{
  "decision": "OPEN" | "SKIP" | "CLOSE" | "MODIFY",
  "side": "long" | "short",   // required when decision == OPEN
  "entry_type": "market" | "limit",  // market = take now at current; limit = wait for retest at "entry"
  "tp_strategy": "scalp" | "swing",  // required when decision == OPEN — see Scalp vs Swing section
  "entry": number > 0,        // required when decision == OPEN; the price level (for limit) or roughly-current (for market)
  "sl":    number > 0,        // required when decision == OPEN
  "tp":    [number > 0],      // EXACTLY ONE take-profit level for OPEN; [] otherwise
  "size_pct":   number 0..2,  // % of equity to risk; required when decision == OPEN
  "confidence": number 0..1,  // your honest confidence in this trade
  "reasoning_short": string,  // <=400 chars; goes to Telegram
  "reasoning_full":  string,  // <=5000 chars; the why, in detail
  // For OPEN/MODIFY only — concrete justifications shown next to the levels:
  "sl_reason":     string,    // <=120 chars, Russian. Example: "за свинг-хаем 14:00, ликвидность зачищена"
  "tp_reason":     string,    // <=120 chars, Russian. Example: "equal lows на 1H, зона спроса 2.37"
  "invalidation":  string,    // <=160 chars, Russian. Example: "пробой 2.4750 с закрытием 15m выше"
  // Optional: up to 2 additional limit setups at structural levels.
  // Independent of primary — can be opposite direction (spider web idea).
  // R:R MUST be >= 3.0. Each placed as a 6h-TTL pending limit @ 0.25% size.
  // Cite a concrete level (OB / wall / VAH / VAL / swing) in level_reason.
  "spider_setups": [
    {
      "side": "long" | "short",
      "entry": number > 0,
      "sl":    number > 0,
      "tp":    number > 0,
      "level_reason": string  // <=160 chars Russian, cite level
    }
  ]
}`;

import type { TpStrategy } from '../llm/decision.schema.js';

/**
 * Confidence-tiered position sizing.
 *
 * The LLM picks size_pct freely (0..2). After self-critique we have a
 * calibrated confidence. We override the LLM-proposed size with a fixed
 * tier based on confidence — removes the "robust OPEN with full 2% size"
 * anti-pattern Claude likes when it's confident, and downgrades very low
 * confidence calls to SKIP entirely.
 *
 * Tiers (per-strategy):
 *   swing:
 *     < 0.50 → DOWNGRADE_TO_SKIP
 *     0.50-0.60 → 0.5%
 *     0.60-0.70 → 1.0%
 *     0.70-0.80 → 1.5%
 *     ≥ 0.80   → 2.0%
 *   scalp (same floor — R:R tighter):
 *     < 0.50 → DOWNGRADE_TO_SKIP
 *     0.50-0.60 → 0.5%
 *     0.60-0.70 → 1.0%
 *     ≥ 0.70   → 1.5%   (scalp never gets 2.0% — tight R:R doesn't deserve max size)
 *
 * History:
 *   2026-05-11 swing floor lowered 0.45 → 0.40 because Claude rarely
 *     produces > 0.55 confidence with all the context layers.
 *   2026-05-12 swing floor RAISED back 0.40 → 0.50 after 4 days of trades
 *     showed 0/7 win rate and PnL −4.41R. Of 4 SL-hits, three had
 *     confidence in [0.41, 0.48] — exactly the borderline tier we should
 *     never trade. Raising the floor would have skipped 3 of 4 SL-hits
 *     (≈+3R for the period). Tier ladder shifted up to match — 0.5%
 *     starts at 0.50 instead of 0.40, max 2% reserved for ≥0.80.
 *   2026-05-12 scalp tier added with the same 0.50 floor.
 */

export type SizingResult =
  | { action: 'SIZE'; sizePct: number; tier: string }
  | { action: 'SKIP'; reason: string };

export const SIZING_FLOOR_SWING = 0.5;
/** Default scalp floor. The EFFECTIVE floor is read at runtime from
 *  `runtime_config['scalp.confidence_floor']` so the self-review job can
 *  auto-tune ±0.05 within [0.40, 0.55] without a deploy. Falls back to
 *  this default if no row in DB.
 *  See effectiveScalpFloor() below + src/jobs/self-review.ts. */
export const SIZING_FLOOR_SCALP_DEFAULT = 0.5;
/** Hard bounds for auto-tuning — the self-review job will never set
 *  scalp.confidence_floor outside this range. Lower than 0.40 = same as
 *  swing floor, no value in distinguishing. Higher than 0.55 = scalps
 *  too rare to be useful. */
export const SIZING_FLOOR_SCALP_MIN = 0.4;
export const SIZING_FLOOR_SCALP_MAX = 0.55;

/** Back-compat exports for old callers / tests. */
export const SIZING_FLOOR_CONFIDENCE = SIZING_FLOOR_SWING;
/** Default scalp floor as a const. The auto-tunable EFFECTIVE floor lives
 *  in src/risk/scalp-floor.ts (which depends on the DB). Keep this module
 *  pure for unit tests + import safety. */
export const SIZING_FLOOR_SCALP = SIZING_FLOOR_SCALP_DEFAULT;

export function sizeFromConfidence(
  confidence: number,
  strategy: TpStrategy = 'swing',
  /** Optional override for scalp floor — passed by decide.ts after reading
   *  from runtime_config (DB). Tests / callers omit this and get the
   *  compile-time default. Ignored when strategy='swing'. */
  scalpFloorOverride?: number,
): SizingResult {
  if (!Number.isFinite(confidence)) {
    return { action: 'SKIP', reason: `non-finite confidence: ${confidence}` };
  }

  if (strategy === 'scalp') {
    // Clamp override to bounds in case a stale/bad value is passed.
    const floor =
      scalpFloorOverride !== undefined
        ? Math.max(SIZING_FLOOR_SCALP_MIN, Math.min(SIZING_FLOOR_SCALP_MAX, scalpFloorOverride))
        : SIZING_FLOOR_SCALP_DEFAULT;
    if (confidence < floor) {
      return {
        action: 'SKIP',
        reason: `scalp confidence ${confidence.toFixed(2)} < ${floor.toFixed(2)} floor`,
      };
    }
    // Tiers scale from floor: floor..(+0.10) = 0.5%, (+0.10)..(+0.20) = 1.0%, (+0.20)+ = 1.5%.
    // Anchoring tiers to the floor means lowering the floor doesn't suddenly
    // promote borderline trades into a higher size tier.
    if (confidence < floor + 0.1) return { action: 'SIZE', sizePct: 0.5, tier: `scalp:[${floor.toFixed(2)},+0.10)` };
    if (confidence < floor + 0.2) return { action: 'SIZE', sizePct: 1.0, tier: `scalp:[+0.10,+0.20)` };
    return { action: 'SIZE', sizePct: 1.5, tier: 'scalp:≥+0.20' };
  }

  // swing (default)
  if (confidence < SIZING_FLOOR_SWING) {
    return {
      action: 'SKIP',
      reason: `swing confidence ${confidence.toFixed(2)} < ${SIZING_FLOOR_SWING} floor`,
    };
  }
  if (confidence < 0.6) return { action: 'SIZE', sizePct: 0.5, tier: 'swing:0.50-0.60' };
  if (confidence < 0.7) return { action: 'SIZE', sizePct: 1.0, tier: 'swing:0.60-0.70' };
  if (confidence < 0.8) return { action: 'SIZE', sizePct: 1.5, tier: 'swing:0.70-0.80' };
  return { action: 'SIZE', sizePct: 2.0, tier: 'swing:≥0.80' };
}

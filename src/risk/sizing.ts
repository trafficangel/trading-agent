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
 *   swing (default):
 *     < 0.40 → DOWNGRADE_TO_SKIP
 *     0.40-0.50 → 0.5%
 *     0.50-0.60 → 1.0%
 *     0.60-0.70 → 1.5%
 *     ≥ 0.70   → 2.0%
 *   scalp (tighter floor — R:R is small, errors are expensive):
 *     < 0.50 → DOWNGRADE_TO_SKIP
 *     0.50-0.60 → 0.5%
 *     0.60-0.70 → 1.0%
 *     ≥ 0.70   → 1.5%   (scalp never gets 2.0% — tight R:R doesn't deserve max size)
 *
 * History: 2026-05-11 swing floor lowered 0.45 → 0.40 because Claude rarely
 * produces > 0.55 confidence with all the context layers. Scalp tier added
 * 2026-05-12 — scalp needs a higher floor BECAUSE its R:R is tight, so
 * low-conviction scalps lose money faster than low-conviction swings.
 */

export type SizingResult =
  | { action: 'SIZE'; sizePct: number; tier: string }
  | { action: 'SKIP'; reason: string };

export const SIZING_FLOOR_SWING = 0.4;
export const SIZING_FLOOR_SCALP = 0.5;

/** Back-compat export — old callers reference SIZING_FLOOR_CONFIDENCE. */
export const SIZING_FLOOR_CONFIDENCE = SIZING_FLOOR_SWING;

export function sizeFromConfidence(
  confidence: number,
  strategy: TpStrategy = 'swing',
): SizingResult {
  if (!Number.isFinite(confidence)) {
    return { action: 'SKIP', reason: `non-finite confidence: ${confidence}` };
  }

  if (strategy === 'scalp') {
    if (confidence < SIZING_FLOOR_SCALP) {
      return {
        action: 'SKIP',
        reason: `scalp confidence ${confidence.toFixed(2)} < ${SIZING_FLOOR_SCALP} floor`,
      };
    }
    if (confidence < 0.6) return { action: 'SIZE', sizePct: 0.5, tier: 'scalp:0.50-0.60' };
    if (confidence < 0.7) return { action: 'SIZE', sizePct: 1.0, tier: 'scalp:0.60-0.70' };
    return { action: 'SIZE', sizePct: 1.5, tier: 'scalp:≥0.70' };
  }

  // swing (default)
  if (confidence < SIZING_FLOOR_SWING) {
    return {
      action: 'SKIP',
      reason: `swing confidence ${confidence.toFixed(2)} < ${SIZING_FLOOR_SWING} floor`,
    };
  }
  if (confidence < 0.5) return { action: 'SIZE', sizePct: 0.5, tier: 'swing:0.40-0.50' };
  if (confidence < 0.6) return { action: 'SIZE', sizePct: 1.0, tier: 'swing:0.50-0.60' };
  if (confidence < 0.7) return { action: 'SIZE', sizePct: 1.5, tier: 'swing:0.60-0.70' };
  return { action: 'SIZE', sizePct: 2.0, tier: 'swing:≥0.70' };
}

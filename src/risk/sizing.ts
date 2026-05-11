/**
 * Confidence-tiered position sizing.
 *
 * The LLM picks size_pct freely (0..2). After self-critique we have a
 * calibrated confidence. We override the LLM-proposed size with a fixed
 * tier based on confidence — removes the "robust OPEN with full 2% size"
 * anti-pattern Claude likes when it's confident, and downgrades very low
 * confidence calls to SKIP entirely.
 *
 * Tiers (updated 2026-05-11: floor lowered 0.45 → 0.40 after observation
 * that Claude rarely produces > 0.55 confidence due to its conservatism
 * with all the new context layers; 0.45 floor was killing borderline
 * setups that LLM was willing to take with 0.42-0.44):
 *   < 0.40 → DOWNGRADE_TO_SKIP (too uncertain to put real risk on)
 *   0.40-0.50 → 0.5%
 *   0.50-0.60 → 1.0%
 *   0.60-0.70 → 1.5%
 *   ≥ 0.70   → 2.0%
 */

export type SizingResult =
  | { action: 'SIZE'; sizePct: number; tier: string }
  | { action: 'SKIP'; reason: string };

export const SIZING_FLOOR_CONFIDENCE = 0.4;

export function sizeFromConfidence(confidence: number): SizingResult {
  if (!Number.isFinite(confidence)) {
    return { action: 'SKIP', reason: `non-finite confidence: ${confidence}` };
  }
  if (confidence < SIZING_FLOOR_CONFIDENCE) {
    return {
      action: 'SKIP',
      reason: `confidence ${confidence.toFixed(2)} < ${SIZING_FLOOR_CONFIDENCE} floor`,
    };
  }
  if (confidence < 0.5) return { action: 'SIZE', sizePct: 0.5, tier: '0.40-0.50' };
  if (confidence < 0.6) return { action: 'SIZE', sizePct: 1.0, tier: '0.50-0.60' };
  if (confidence < 0.7) return { action: 'SIZE', sizePct: 1.5, tier: '0.60-0.70' };
  return { action: 'SIZE', sizePct: 2.0, tier: '≥0.70' };
}

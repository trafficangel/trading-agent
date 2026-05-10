/**
 * Confidence-tiered position sizing.
 *
 * The LLM picks size_pct freely (0..2). After self-critique we have a
 * calibrated confidence. We override the LLM-proposed size with a fixed
 * tier based on confidence — removes the "robust OPEN with full 2% size"
 * anti-pattern Claude likes when it's confident, and downgrades very low
 * confidence calls to SKIP entirely.
 *
 * Tiers:
 *   < 0.45 → DOWNGRADE_TO_SKIP (too uncertain to put real risk on)
 *   0.45-0.55 → 0.5%
 *   0.55-0.65 → 1.0%
 *   0.65-0.75 → 1.5%
 *   ≥ 0.75   → 2.0%
 */

export type SizingResult =
  | { action: 'SIZE'; sizePct: number; tier: string }
  | { action: 'SKIP'; reason: string };

export const SIZING_FLOOR_CONFIDENCE = 0.45;

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
  if (confidence < 0.55) return { action: 'SIZE', sizePct: 0.5, tier: '0.45-0.55' };
  if (confidence < 0.65) return { action: 'SIZE', sizePct: 1.0, tier: '0.55-0.65' };
  if (confidence < 0.75) return { action: 'SIZE', sizePct: 1.5, tier: '0.65-0.75' };
  return { action: 'SIZE', sizePct: 2.0, tier: '≥0.75' };
}

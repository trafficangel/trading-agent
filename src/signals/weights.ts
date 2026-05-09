/**
 * Confluence scoring weights per LuxAlgo event type and timeframe.
 *
 * Rules:
 * - Weights are added separately for bullish vs bearish direction within
 *   a 10-minute window per symbol.
 * - Higher TF (1H) signals get a multiplier (×1.5) since they reflect
 *   stronger structural context.
 * - 5m timing-only confirmations get ×0.7 (less weight; they exist only
 *   to refine entry, not drive the decision).
 */

export type EventWeight = {
  /** Base score awarded when this event type fires within the window. */
  base: number;
  /** Optional notes for documentation. */
  note?: string;
};

export const EVENT_WEIGHTS: Record<string, EventWeight> = {
  // Signals & Overlays — primary momentum signals
  bullish_plus: { base: 4 },
  bearish_plus: { base: 4 },
  bullish_confirmation: { base: 2, note: 'weaker than +' },
  bearish_confirmation: { base: 2 },
  smart_trail_flip_up: { base: 3 },
  smart_trail_flip_down: { base: 3 },

  // Price Action Concepts — structural
  bos_swing_up: { base: 3, note: 'major break of structure' },
  bos_swing_down: { base: 3 },
  bos_internal_up: { base: 1, note: 'minor — noisy on 5m' },
  bos_internal_down: { base: 1 },
  choch_swing_plus_up: { base: 3, note: 'confirmed swing CHoCH' },
  choch_swing_plus_down: { base: 3 },
  choch_swing_up: { base: 2 },
  choch_swing_down: { base: 2 },
  choch_internal_up: { base: 1 },
  choch_internal_down: { base: 1 },
  choch_internal_plus_up: { base: 1 },
  choch_internal_plus_down: { base: 1 },
  ob_bullish_created: { base: 2 },
  ob_bearish_created: { base: 2 },
  fvg_up: { base: 1 },
  fvg_down: { base: 1 },
  equal_highs: { base: 1, note: 'liquidity above' },
  equal_lows: { base: 1, note: 'liquidity below' },

  // Oscillator Matrix
  mf_extreme_up: { base: 3 },
  mf_extreme_down: { base: 3 },
  reversal_signal_up: { base: 2 },
  reversal_signal_down: { base: 2 },
  divergence_bullish: { base: 2 },
  divergence_bearish: { base: 2 },

  // Legacy event names (kept for backwards compat with old alerts)
  bos_up: { base: 3 },
  bos_down: { base: 3 },
  choch_up: { base: 2 },
  choch_down: { base: 2 },
};

const TF_MULTIPLIER: Record<string, number> = {
  '1': 0.5,
  '3': 0.6,
  '5': 0.7, // 5m: timing only
  '15': 1.0, // 15m: primary
  '30': 1.2,
  '60': 1.5, // 1H: context
  '240': 1.8, // 4H: stronger context
  D: 2.0,
};

const BULLISH_DIRECTIONS: Set<string | null | undefined> = new Set(['up', undefined, null]);
const BEARISH_DIRECTIONS: Set<string | null | undefined> = new Set(['down']);

/**
 * Compute scores for an event. Returns separate bullish/bearish contributions
 * (some events like equal_highs/lows are direction-agnostic — we treat them
 * as bias signals based on direction field if present, else neutral).
 */
export function scoreEvent(
  event: string,
  timeframe: string,
  direction?: string | null,
): { bullish: number; bearish: number } {
  const w = EVENT_WEIGHTS[event];
  if (!w) return { bullish: 0, bearish: 0 };

  const tfMult = TF_MULTIPLIER[timeframe] ?? 1.0;
  const score = w.base * tfMult;

  if (BULLISH_DIRECTIONS.has(direction)) return { bullish: score, bearish: 0 };
  if (BEARISH_DIRECTIONS.has(direction)) return { bullish: 0, bearish: score };
  return { bullish: 0, bearish: 0 };
}

/** Threshold above which the LLM is invoked. */
export const SCORE_THRESHOLD = 6;

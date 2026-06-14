/**
 * Phase V — pure allocation math, no I/O (unit-testable without loading
 * config/db, same pattern as lib/risk-rules.ts).
 *
 * Tilt-factor weighting: each strategy gets a multiplier t in [floor,cap]
 * from its edge score, then weight = t / Σt. This ALWAYS sums to 1 and
 * keeps every weight bounded (relative tilt ≤ cap/floor), with no
 * infeasibility edge cases — unlike a clamp+renormalise, which lets the
 * top score breach the cap, or a naive water-fill, which can leave the
 * pool under-allocated when one strategy dominates.
 *
 * score semantics:
 *   null  → no data yet           → neutral (t=1)
 *   ≤ 0   → negative/zero edge     → floored (t=floor)
 *   > 0   → positive edge          → scaled 1..cap by score / maxScore
 */
export function tiltWeights(scores: (number | null)[], floor: number, cap: number): number[] {
  const n = scores.length;
  if (n === 0) return [];
  const positive = scores.filter((s): s is number => s !== null && s > 0);
  const maxS = positive.length ? Math.max(...positive) : 0;
  const t = scores.map((s) => {
    if (s === null) return 1;
    if (s <= 0) return floor;
    return maxS > 0 ? 1 + (s / maxS) * (cap - 1) : 1;
  });
  const sum = t.reduce((a, b) => a + b, 0) || n;
  return t.map((x) => x / sum);
}

/**
 * Phase V (Jun 14, 2026) — Kelly-tilt margin allocation.
 *
 * Until now a tier's margin pool was split EQUALLY across its strategies
 * (pool / N). This module tilts that split toward strategies that are
 * actually working in LIVE shadow data and away from ones that bleed —
 * a fractional-Kelly portfolio weighting. It improves the aggregate for
 * ANY dispersion in edge, independent of guessing which strategy is good.
 *
 * Honesty guards (so we tilt on signal, not noise):
 *   - MIN_SAMPLE: a strategy needs ≥ N closed live trades before its own
 *     edge is trusted; below that it gets a NEUTRAL weight.
 *   - Kelly score uses LIVE net returns (incl. 0.11% commission). A
 *     negative-edge strategy scores 0 → it's floored, not zeroed.
 *   - FLOOR/CAP: every weight stays within [0.4×, 1.8×] of equal, so no
 *     single strategy dominates and none is starved while it proves out.
 *   - Cached 10 min; recomputed from the decisions table (crash-safe).
 *
 * Takes strategyIds as input (no tier-config import) to avoid a cycle.
 */

import { db } from '../db/client.js';
import { TRACK_C_COMMISSION_RT_PCT } from './track-c-config.js';
import { tiltWeights } from '../lib/kelly-math.js';

const COMM = TRACK_C_COMMISSION_RT_PCT / 100;
const MIN_SAMPLE = 15;
const FLOOR = 0.4;   // ≥ 0.4× equal
const CAP = 1.8;     // ≤ 1.8× equal
const CACHE_MS = 10 * 60_000;

const liveReturnsStmt = db.prepare<[string], { pnl_pct: number }>(`
  SELECT pnl_pct FROM decisions
   WHERE user_id IS NULL AND track = 'strategy' AND status = 'closed'
     AND strategy_id = ? AND pnl_pct IS NOT NULL
`);

/** Kelly-ish score for one strategy from its live net returns:
 *  f* ≈ mean / variance, clamped ≥ 0. null when sample too small. */
function strategyScore(strategyId: string): number | null {
  const rs = liveReturnsStmt.all(strategyId).map((r) => r.pnl_pct / 100 - COMM);
  if (rs.length < MIN_SAMPLE) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  if (mean <= 0) return 0; // negative edge → floored
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length || 1e-9;
  return mean / variance;
}

let cache: { key: string; at: number; map: Map<string, number> } | null = null;

/**
 * Weights (summing to 1) for distributing a tier's margin pool across
 * `strategyIds`. Equal-weight until live data engages, then Kelly-tilted
 * within the floor/cap band.
 */
export function computeWeights(strategyIds: string[], now = Date.now()): Map<string, number> {
  const ids = [...strategyIds];
  const key = ids.slice().sort().join('|');
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.map;

  const scores = ids.map((id) => strategyScore(id));
  // tilt-factor weights: t∈[FLOOR,CAP] from edge, weight = t/Σt. Always
  // sums to 1, always bounded; null (no data) → neutral, ≤0 → floored.
  const weights = tiltWeights(scores, FLOOR, CAP);
  const map = new Map<string, number>();
  ids.forEach((id, i) => map.set(id, weights[i]!));
  cache = { key, at: now, map };
  return map;
}

/** Test/diagnostic hook — drop the cache. */
export function _resetWeightCache(): void {
  cache = null;
}

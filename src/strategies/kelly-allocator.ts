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

  const n = ids.length;
  const equal = n > 0 ? 1 / n : 0;
  const scores = new Map<string, number | null>();
  for (const id of ids) scores.set(id, strategyScore(id));

  const qualified = ids.map((id) => scores.get(id)).filter((s): s is number => s !== null);
  const map = new Map<string, number>();

  if (qualified.length === 0) {
    // nobody has enough data yet → equal split.
    for (const id of ids) map.set(id, equal);
    cache = { key, at: now, map };
    return map;
  }

  // Strategies without enough sample get the MEDIAN qualified score
  // (neutral — neither favoured nor punished).
  const sortedQ = [...qualified].sort((a, b) => a - b);
  const neutral = sortedQ[sortedQ.length >> 1]!;
  const raw: number[] = ids.map((id) => {
    const s = scores.get(id);
    return s == null ? neutral : s; // == null catches null AND undefined
  });
  const sumRaw = raw.reduce((a, b) => a + b, 0) || 1;

  // normalize, clamp to [FLOOR,CAP]×equal, renormalize once.
  let weights = raw.map((r) => r / sumRaw);
  weights = weights.map((w) => Math.min(CAP * equal, Math.max(FLOOR * equal, w)));
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  weights = weights.map((w) => w / sumW);

  ids.forEach((id, i) => map.set(id, weights[i]!));
  cache = { key, at: now, map };
  return map;
}

/** Test/diagnostic hook — drop the cache. */
export function _resetWeightCache(): void {
  cache = null;
}

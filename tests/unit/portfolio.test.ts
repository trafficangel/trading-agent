/**
 * allocatePortfolio — risk-parity weighting + cluster cap (waterfill).
 */

import { describe, it, expect } from 'vitest';
import { allocatePortfolio } from '../../src/lib/portfolio.js';

const sum = (a: { weight: number }[]) => a.reduce((x, y) => x + y.weight, 0);
const byId = (a: { id: string; weight: number }[]) => Object.fromEntries(a.map((x) => [x.id, x.weight]));

describe('allocatePortfolio', () => {
  it('empty → empty', () => {
    expect(allocatePortfolio([])).toEqual([]);
  });

  it('risk-parity within one cluster: weight ∝ 1/risk', () => {
    const a = allocatePortfolio([
      { id: 'a', cluster: 'x', riskPct: 10 },
      { id: 'b', cluster: 'x', riskPct: 20 },
    ]);
    const w = byId(a);
    expect(w.a).toBeCloseTo(2 / 3, 5); // 1/10 vs 1/20 → 2:1
    expect(w.b).toBeCloseTo(1 / 3, 5);
    expect(sum(a)).toBeCloseTo(1, 6);
  });

  it('cluster cap waterfills the excess to the other cluster', () => {
    // cluster A: 3 low-risk (raw 0.2 each = 0.6); cluster B: 1 (raw 0.05).
    // Uncapped A≈0.92 > 0.6 → A capped to 0.6, B gets the remaining 0.4.
    // (cap 0.6 is feasible for 2 clusters; cap 0.35 here would be degenerate.)
    const a = allocatePortfolio([
      { id: 'a1', cluster: 'A', riskPct: 5 },
      { id: 'a2', cluster: 'A', riskPct: 5 },
      { id: 'a3', cluster: 'A', riskPct: 5 },
      { id: 'b1', cluster: 'B', riskPct: 20 },
    ], { clusterCap: 0.6 });
    const w = byId(a);
    const aTotal = (w.a1 ?? 0) + (w.a2 ?? 0) + (w.a3 ?? 0);
    expect(aTotal).toBeCloseTo(0.6, 4);
    expect(w.b1 ?? 0).toBeCloseTo(0.4, 4);
    expect(w.a1 ?? 0).toBeCloseTo(0.6 / 3, 4); // equal within cluster
    expect(sum(a)).toBeCloseTo(1, 6);
  });

  it('weights always sum to 1', () => {
    const a = allocatePortfolio([
      { id: 'a', cluster: 'x', riskPct: 5 },
      { id: 'b', cluster: 'y', riskPct: 10 },
      { id: 'c', cluster: 'z', riskPct: 40 },
    ], { clusterCap: 0.35 });
    expect(sum(a)).toBeCloseTo(1, 6);
  });
});

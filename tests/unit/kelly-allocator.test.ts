import { describe, it, expect } from 'vitest';
import { tiltWeights } from '../../src/lib/kelly-math.js';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const FLOOR = 0.4;
const CAP = 1.8;

describe('tiltWeights', () => {
  it('always sums to 1 — incl. the degenerate "one dominant score" case (the bug)', () => {
    expect(sum(tiltWeights([5, 0, 0, 0, 0, 0], FLOOR, CAP))).toBeCloseTo(1, 9);
    expect(sum(tiltWeights([null, null, 0, 0, null, 9], FLOOR, CAP))).toBeCloseTo(1, 9);
    expect(sum(tiltWeights([1, 1, 1, 1], FLOOR, CAP))).toBeCloseTo(1, 9);
    expect(sum(tiltWeights([null, null], FLOOR, CAP))).toBeCloseTo(1, 9);
  });

  it('all-neutral (no data) → equal split', () => {
    const w = tiltWeights([null, null, null, null], FLOOR, CAP);
    for (const x of w) expect(x).toBeCloseTo(0.25, 9);
  });

  it('relative tilt bounded by cap/floor; winner up, negative-edge floored', () => {
    const w = tiltWeights([9, 0, null, null], FLOOR, CAP); // winner, bleeder, 2 neutral
    // winner has the largest weight, bleeder the smallest
    expect(w[0]).toBeGreaterThan(w[2]!); // winner > neutral
    expect(w[1]).toBeLessThan(w[2]!);    // bleeder < neutral
    // relative tilt winner:bleeder ≈ CAP:FLOOR = 4.5, never beyond
    expect(w[0]! / w[1]!).toBeLessThanOrEqual(CAP / FLOOR + 1e-9);
  });

  it('zero-edge strategies floored, not zeroed (still get allocation)', () => {
    const w = tiltWeights([0, 0, 9, null], FLOOR, CAP);
    expect(w[0]).toBeGreaterThan(0);
    expect(w[1]).toBeGreaterThan(0);
  });
});

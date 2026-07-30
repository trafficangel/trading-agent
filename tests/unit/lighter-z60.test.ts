import { describe, expect, it } from 'vitest';
import {
  evaluateZ60Reclaim,
  evaluateZ60Touch,
  type Z60Bar,
} from '../../src/lib/lighter-z60.js';

function bars(closes: number[]): Z60Bar[] {
  return closes.map((close, index) => ({ time: index * 300_000, close }));
}

describe('evaluateZ60Reclaim', () => {
  it('detects a symmetric long reclaim', () => {
    const baseline = Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Reclaim(bars([...baseline, 90, 99]), 60, 3);
    expect(result?.previousZ).toBeLessThan(-3);
    expect(result?.currentZ).toBeGreaterThanOrEqual(-3);
    expect(result?.signal).toBe('long');
  });

  it('detects a symmetric short reclaim', () => {
    const baseline = Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Reclaim(bars([...baseline, 110, 101]), 60, 3);
    expect(result?.previousZ).toBeGreaterThan(3);
    expect(result?.currentZ).toBeLessThanOrEqual(3);
    expect(result?.signal).toBe('short');
  });

  it('does not turn a continuing excursion into a signal', () => {
    const baseline = Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Reclaim(bars([...baseline, 90, 89]), 60, 3);
    expect(result?.signal).toBeNull();
  });

  it('supports the fixed 50-bar AVAX reclaim period', () => {
    const baseline = Array.from({ length: 49 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const long = evaluateZ60Reclaim(bars([...baseline, 90, 99]), 50, 3);
    const short = evaluateZ60Reclaim(bars([...baseline, 110, 101]), 50, 3);
    expect(long?.signal).toBe('long');
    expect(short?.signal).toBe('short');
  });
});

describe('evaluateZ60Touch', () => {
  it('enters long while the completed candle is below the lower band', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Touch(bars([...baseline, 90]), 60, 3);
    expect(result?.currentZ).toBeLessThan(-3);
    expect(result?.signal).toBe('long');
  });

  it('enters short while the completed candle is above the upper band', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Touch(bars([...baseline, 110]), 60, 3);
    expect(result?.currentZ).toBeGreaterThan(3);
    expect(result?.signal).toBe('short');
  });

  it('stays flat inside the three-sigma band', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Touch(bars([...baseline, 100]), 60, 3);
    expect(result?.signal).toBeNull();
  });

  it('honors a lower two-sigma threshold without changing direction symmetry', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const long = evaluateZ60Touch(bars([...baseline, 94]), 60, 2);
    const short = evaluateZ60Touch(bars([...baseline, 106]), 60, 2);
    expect(long?.currentZ).toBeLessThan(-2);
    expect(long?.signal).toBe('long');
    expect(short?.currentZ).toBeGreaterThan(2);
    expect(short?.signal).toBe('short');
  });
});

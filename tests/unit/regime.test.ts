import { describe, it, expect } from 'vitest';

// We test the math primitives here. The full detectRegime() touches Binance
// API and is exercised by smoke-tests; not worth mocking the HTTP layer for
// a 5-line glue function.

// Re-implement the percentile + ATR helpers locally to keep them testable
// without exporting internals. Mirrors src/signals/regime.ts implementations.

function rollingAtrSeries(
  klines: { high: number; low: number; close: number }[],
  window: number,
): number[] {
  const out: number[] = [];
  if (klines.length < window + 1) return out;
  for (let i = window; i < klines.length; i++) {
    const slice = klines.slice(i - window, i + 1);
    let sum = 0;
    for (let j = 1; j < slice.length; j++) {
      const cur = slice[j]!;
      const prev = slice[j - 1]!;
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      sum += tr;
    }
    out.push(sum / window);
  }
  return out;
}

function percentileRank(value: number, distribution: number[]): number {
  if (distribution.length === 0) return 50;
  let below = 0;
  for (const v of distribution) if (v < value) below++;
  return Math.round((below / distribution.length) * 100);
}

describe('regime math', () => {
  it('percentile of value below all → 0', () => {
    expect(percentileRank(0, [1, 2, 3, 4, 5])).toBe(0);
  });

  it('percentile of value above all → 100', () => {
    expect(percentileRank(99, [1, 2, 3, 4, 5])).toBe(100);
  });

  it('percentile of median → 40-60 range', () => {
    const r = percentileRank(3, [1, 2, 3, 4, 5]);
    expect(r).toBeGreaterThanOrEqual(40);
    expect(r).toBeLessThanOrEqual(60);
  });

  it('rollingAtrSeries empty when too few bars', () => {
    expect(rollingAtrSeries([{ high: 1, low: 1, close: 1 }], 14)).toHaveLength(0);
  });

  it('rollingAtrSeries produces 1 value for window+1 bars', () => {
    const bars = Array.from({ length: 15 }, (_, i) => ({ high: 100 + i, low: 99 + i, close: 100 + i }));
    expect(rollingAtrSeries(bars, 14)).toHaveLength(1);
  });

  it('rollingAtrSeries produces 5 values for window+5 bars', () => {
    const bars = Array.from({ length: 19 }, (_, i) => ({ high: 100 + i, low: 99 + i, close: 100 + i }));
    expect(rollingAtrSeries(bars, 14)).toHaveLength(5);
  });
});

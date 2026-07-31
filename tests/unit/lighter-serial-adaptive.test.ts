import { describe, expect, it } from 'vitest';
import {
  completedLagOneReturnCorrelation,
  serialAdaptiveSide,
} from '../../src/lib/lighter-serial-adaptive.js';

function closesFromReturns(returns: readonly number[]): number[] {
  const closes = [100];
  for (const value of returns) closes.push(closes.at(-1)! * Math.exp(value));
  return closes;
}

describe('Lighter adaptive serial-dependence research', () => {
  it('detects positive and negative serial dependence from prior returns', () => {
    const persistent = closesFromReturns(Array.from({ length: 20 }, (_, index) =>
      index < 10 ? 0.01 + index * 0.001 : -0.01 - index * 0.001));
    const alternating = closesFromReturns(Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? 0.01 : -0.01));
    expect(completedLagOneReturnCorrelation(persistent, 10).at(-1)!).toBeGreaterThan(0.5);
    expect(completedLagOneReturnCorrelation(alternating, 10).at(-1)!).toBeLessThan(-0.9);
  });

  it('cannot see the signal candle or any future close', () => {
    const base = closesFromReturns(Array.from({ length: 25 }, (_, index) =>
      Math.sin(index) * 0.01));
    const changed = [...base];
    changed[20] = base[20]! * 10;
    changed[21] = base[21]! / 10;
    const left = completedLagOneReturnCorrelation(base, 10);
    const right = completedLagOneReturnCorrelation(changed, 10);
    expect(right[20]).toBeCloseTo(left[20]!, 12);
  });

  it('mirrors continuation and reversal signals and enforces body and volume', () => {
    const common = { open: 100, close: 101, atr: 1, volume: 10, volumeMean: 10 };
    expect(serialAdaptiveSide({ ...common, correlation: 0.2 })).toBe('long');
    expect(serialAdaptiveSide({ ...common, correlation: -0.2 })).toBe('short');
    expect(serialAdaptiveSide({ ...common, open: 101, close: 100, correlation: 0.2 })).toBe('short');
    expect(serialAdaptiveSide({ ...common, open: 101, close: 100, correlation: -0.2 })).toBe('long');
    expect(serialAdaptiveSide({ ...common, close: 100.4, correlation: 0.2 })).toBeNull();
    expect(serialAdaptiveSide({ ...common, volume: 9, correlation: 0.2 })).toBeNull();
  });
});

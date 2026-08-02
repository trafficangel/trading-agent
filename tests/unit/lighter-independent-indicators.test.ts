import { describe, expect, it } from 'vitest';
import {
  choppinessIndex,
  connorsRsi,
  elderForceIndexZScore,
  priceVolumeTrendOscillator,
  rollingRegressionResidualZScore,
  ultimateOscillator,
  type CompletedOhlcv,
} from '../../src/lib/lighter-independent-indicators.js';

function sample(length: number): CompletedOhlcv[] {
  return Array.from({ length }, (_, index) => {
    const close = 100 + Math.sin(index / 4) * 2 + index * 0.03;
    return {
      close,
      high: close + 0.8 + (index % 3) * 0.05,
      low: close - 0.7 - (index % 2) * 0.05,
      volume: 1_000 + (index % 11) * 37,
    };
  });
}

describe('independent completed-bar indicators', () => {
  it('keeps Ultimate Oscillator causal and bounded', () => {
    const bars = sample(120);
    const base = ultimateOscillator(bars);
    const extended = ultimateOscillator([...bars, ...sample(5)]);
    expect(extended.slice(0, bars.length)).toEqual(base);
    expect(base.slice(27).every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it('keeps Elder Force Index Z-score causal and finite', () => {
    const bars = sample(120);
    const base = elderForceIndexZScore(bars);
    const extended = elderForceIndexZScore([...bars, ...sample(5)]);
    expect(extended.slice(0, bars.length)).toEqual(base);
    expect(base.every(Number.isFinite)).toBe(true);
    expect(base.slice(59).some((value) => Math.abs(value) > 0.1)).toBe(true);
  });

  it('keeps Choppiness Index causal and bounded', () => {
    const bars = sample(120);
    const base = choppinessIndex(bars);
    const extended = choppinessIndex([...bars, ...sample(5)]);
    expect(extended.slice(0, bars.length)).toEqual(base);
    expect(base.every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it('keeps Price Volume Trend oscillator causal and finite', () => {
    const bars = sample(120);
    const base = priceVolumeTrendOscillator(bars);
    const extended = priceVolumeTrendOscillator([...bars, ...sample(5)]);
    expect(extended.oscillator.slice(0, bars.length)).toEqual(base.oscillator);
    expect(extended.signal.slice(0, bars.length)).toEqual(base.signal);
    expect(base.oscillator.every(Number.isFinite)).toBe(true);
    expect(base.oscillator.slice(30).some((value) => Math.abs(value) > 0.01)).toBe(true);
  });

  it('keeps full Connors RSI causal and bounded', () => {
    const closes = sample(180).map((bar) => bar.close);
    const base = connorsRsi(closes);
    const extended = connorsRsi([...closes, ...sample(5).map((bar) => bar.close + 7)]);
    expect(extended.slice(0, closes.length)).toEqual(base);
    expect(base.every((value) => value >= 0 && value <= 100)).toBe(true);
    expect(base.slice(101).some((value) => Math.abs(value - 50) > 5)).toBe(true);
  });

  it('keeps rolling regression residual Z-score causal and neutral on a line', () => {
    const closes = sample(180).map((bar) => bar.close);
    const base = rollingRegressionResidualZScore(closes);
    const extended = rollingRegressionResidualZScore([...closes, ...sample(5).map((bar) => bar.close - 4)]);
    expect(extended.slice(0, closes.length)).toEqual(base);
    expect(base.every(Number.isFinite)).toBe(true);
    expect(base.slice(118).some((value) => Math.abs(value) > 0.1)).toBe(true);
    const linear = Array.from({ length: 180 }, (_value, index) => 100 + index * 0.25);
    expect(rollingRegressionResidualZScore(linear).slice(118).every((value) => Math.abs(value) < 1e-6)).toBe(true);
  });
});

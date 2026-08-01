import { describe, expect, it } from 'vitest';
import { ema, rsi, type Candle } from '../../src/backtest/indicators.js';
import {
  evaluateRsiTrendPullback,
  rsiTrendExit,
} from '../../src/lib/lighter-rsi-pullback.js';

function candles(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => ({
    t: index * 300_000,
    o: close,
    h: close,
    l: close,
    c: close,
    v: 1,
  }));
}

function bars(closes: readonly number[]) {
  return closes.map((close, index) => ({ time: index * 300_000, close }));
}

describe('evaluateRsiTrendPullback', () => {
  it('matches the historical sweep RSI and EMA calculations exactly', () => {
    const closes = Array.from({ length: 520 }, (_, index) =>
      100 + index * 0.08 + Math.sin(index / 7) * 0.6);
    const snapshot = evaluateRsiTrendPullback(bars(closes), 14, 25, 400);
    expect(snapshot).not.toBeNull();
    const expectedRsi = rsi(candles(closes), 14);
    const expectedEma = ema(closes, 400);
    expect(snapshot!.previousRsi).toBeCloseTo(expectedRsi.at(-2)!, 12);
    expect(snapshot!.currentRsi).toBeCloseTo(expectedRsi.at(-1)!, 12);
    expect(snapshot!.trendMean).toBeCloseTo(expectedEma.at(-1)!, 12);
  });

  it('emits mirror-image long and short entries only with trend alignment', () => {
    const uptrend = Array.from({ length: 500 }, (_, index) => 100 + index * 0.05);
    const longCloses = [...uptrend, 124.7, 124.4, 124.1, 123.8, 123.5, 123.2];
    const long = evaluateRsiTrendPullback(bars(longCloses), 14, 25, 400);
    expect(long?.currentRsi).toBeLessThan(25);
    expect(long?.close).toBeGreaterThan(long!.trendMean);
    expect(long?.signal).toBe('long');

    const downtrend = Array.from({ length: 500 }, (_, index) => 150 - index * 0.05);
    const shortCloses = [...downtrend, 125.3, 125.6, 125.9, 126.2, 126.5, 126.8];
    const short = evaluateRsiTrendPullback(bars(shortCloses), 14, 25, 400);
    expect(short?.currentRsi).toBeGreaterThan(75);
    expect(short?.close).toBeLessThan(short!.trendMean);
    expect(short?.signal).toBe('short');
  });

  it('uses the symmetric RSI50 exit', () => {
    const snapshot = {
      barTime: 0,
      close: 100,
      previousRsi: 49,
      currentRsi: 50,
      trendMean: 100,
      signal: null,
    } as const;
    expect(rsiTrendExit(snapshot, 'long')).toBe(true);
    expect(rsiTrendExit(snapshot, 'short')).toBe(true);
  });
});

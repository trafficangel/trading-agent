import { describe, expect, it } from 'vitest';
import {
  evaluateRsiMfiTrend,
  evaluateRsiWilliamsTrend,
  evaluateVwzMfiTrend,
  rsiWilliamsExit,
} from '../../src/lib/lighter-oscillator-confluence.js';
import type { Vwz60Bar } from '../../src/lib/lighter-z60.js';

function trendThenPullback(direction: 'up' | 'down'): Vwz60Bar[] {
  const bars: Vwz60Bar[] = [];
  let close = direction === 'up' ? 100 : 160;
  for (let index = 0; index < 430; index += 1) {
    close += direction === 'up' ? 0.1 : -0.1;
    bars.push({
      time: index * 300_000,
      close,
      high: close + 0.08,
      low: close - 0.08,
      volume: 1_000,
    });
  }
  for (let index = 430; index < 444; index += 1) {
    close += direction === 'up' ? -0.22 : 0.22;
    bars.push({
      time: index * 300_000,
      close,
      high: close + 0.04,
      low: close - 0.04,
      volume: 2_000,
    });
  }
  return bars;
}

function trendThenVwzShock(direction: 'up' | 'down'): Vwz60Bar[] {
  const bars = trendThenPullback(direction).slice(0, 400);
  let close = bars.at(-1)!.close;
  for (let index = 400; index < 445; index += 1) {
    bars.push({
      time: index * 300_000,
      close,
      high: close + 0.04,
      low: close - 0.04,
      volume: 1_000,
    });
  }
  for (let index = 445; index < 459; index += 1) {
    close += direction === 'up' ? -0.001 : 0.001;
    bars.push({
      time: index * 300_000,
      close,
      high: close + 0.04,
      low: close - 0.04,
      volume: 1_000,
    });
  }
  close += direction === 'up' ? -1 : 1;
  bars.push({
    time: 459 * 300_000,
    close,
    high: close + 0.04,
    low: close - 0.04,
    volume: 1_000,
  });
  return bars;
}

describe('Native oscillator confluence', () => {
  it('emits mirrored RSI/Williams signals from completed OHLC bars', () => {
    const long = evaluateRsiWilliamsTrend(trendThenPullback('up'));
    const short = evaluateRsiWilliamsTrend(trendThenPullback('down'));
    expect(long?.signal).toBe('long');
    expect(long?.currentRsi).toBeLessThan(30);
    expect(long?.currentWilliams).toBeLessThan(-80);
    expect(long!.close).toBeGreaterThan(long!.trendMean);
    expect(short?.signal).toBe('short');
    expect(short?.currentRsi).toBeGreaterThan(70);
    expect(short?.currentWilliams).toBeGreaterThan(-20);
    expect(short!.close).toBeLessThan(short!.trendMean);
  });

  it('uses the frozen RSI50 exit symmetrically', () => {
    const long = evaluateRsiWilliamsTrend(trendThenPullback('up'))!;
    const short = evaluateRsiWilliamsTrend(trendThenPullback('down'))!;
    expect(rsiWilliamsExit(long, 'long')).toBe(false);
    expect(rsiWilliamsExit(short, 'short')).toBe(false);
    expect(rsiWilliamsExit({ ...long, currentRsi: 50 }, 'long')).toBe(true);
    expect(rsiWilliamsExit({ ...short, currentRsi: 50 }, 'short')).toBe(true);
  });

  it('requires MFI confirmation in addition to VWZ and EMA400', () => {
    const long = evaluateVwzMfiTrend(trendThenVwzShock('up'));
    const short = evaluateVwzMfiTrend(trendThenVwzShock('down'));
    expect(long?.currentMfi).toBeLessThan(35);
    expect(short?.currentMfi).toBeGreaterThan(65);
    expect(long?.signal).toBe('long');
    expect(short?.signal).toBe('short');
  });

  it('emits mirrored RSI/MFI signals from completed OHLCV bars', () => {
    const long = evaluateRsiMfiTrend(trendThenPullback('up'));
    const short = evaluateRsiMfiTrend(trendThenPullback('down'));
    expect(long?.currentRsi).toBeLessThan(30);
    expect(long?.currentMfi).toBeLessThan(30);
    expect(long?.signal).toBe('long');
    expect(short?.currentRsi).toBeGreaterThan(70);
    expect(short?.currentMfi).toBeGreaterThan(70);
    expect(short?.signal).toBe('short');
  });

  it('fails closed when native high/low data needed by confirmation is absent', () => {
    const bars = trendThenPullback('up').map(({ high: _high, low: _low, ...bar }) => bar);
    expect(evaluateRsiWilliamsTrend(bars)).toBeNull();
    expect(evaluateVwzMfiTrend(bars)).toBeNull();
    expect(evaluateRsiMfiTrend(bars)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  aggregateCompleteNativeBars,
  isSameNativeDecisionBar,
  nativeEntryDecisionDelayMs,
  nativeTimeExitReached,
  targetCompletedNativeBar,
} from '../../src/lib/lighter-native-timeframe.js';

const MINUTE = 60_000;

function candle(minute: number, close: number, volume = 1) {
  return {
    t: minute * MINUTE,
    h: close + 1,
    l: close - 1,
    c: close,
    v: volume,
  };
}

describe('Native completed-bar source', () => {
  it('selects only a bar that closed before publication grace', () => {
    expect(targetCompletedNativeBar(10 * MINUTE + 25_000, 5, 25_000))
      .toBe(5 * MINUTE);
    expect(targetCompletedNativeBar(11 * MINUTE + 25_000, 1, 25_000))
      .toBe(10 * MINUTE);
  });

  it('measures execution delay from the decision bar close, never below zero', () => {
    expect(nativeEntryDecisionDelayMs(5 * MINUTE, 5, 10 * MINUTE + 59_000))
      .toBe(59_000);
    expect(nativeEntryDecisionDelayMs(5 * MINUTE, 5, 9 * MINUTE))
      .toBe(0);
  });

  it('applies max-hold bars in the strategy timeframe', () => {
    const openedAt = 10 * MINUTE;
    expect(nativeTimeExitReached(openedAt, 13 * MINUTE, 1, 4)).toBe(true);
    expect(nativeTimeExitReached(openedAt, 25 * MINUTE, 5, 4)).toBe(true);
    expect(nativeTimeExitReached(openedAt, 20 * MINUTE, 5, 4)).toBe(false);
  });

  it('blocks re-entry only in the matching 1m or 5m decision bucket', () => {
    expect(isSameNativeDecisionBar(7 * MINUTE + 30_000, 7 * MINUTE, 1)).toBe(true);
    expect(isSameNativeDecisionBar(7 * MINUTE + 30_000, 5 * MINUTE, 5)).toBe(true);
    expect(isSameNativeDecisionBar(10 * MINUTE, 5 * MINUTE, 5)).toBe(false);
  });

  it('aggregates exact consecutive 1m candles with full OHLCV semantics', () => {
    const bars = aggregateCompleteNativeBars(
      [
        candle(0, 100, 1),
        candle(1, 102, 2),
        candle(2, 99, 3),
        candle(3, 101, 4),
        candle(4, 103, 5),
      ],
      5,
      0,
    );
    expect(bars).toEqual([{
      time: 0,
      high: 104,
      low: 98,
      close: 103,
      volume: 15,
    }]);
  });

  it('omits a higher-timeframe bucket with one missing native minute', () => {
    const bars = aggregateCompleteNativeBars(
      [candle(0, 100), candle(1, 101), candle(3, 103), candle(4, 104)],
      5,
      0,
    );
    expect(bars).toEqual([]);
  });

  it('supports a causal 1m series without special-case data semantics', () => {
    const bars = aggregateCompleteNativeBars(
      [candle(7, 107), candle(8, 108)],
      1,
      8 * MINUTE,
    );
    expect(bars.map((bar) => [bar.time, bar.close]))
      .toEqual([[7 * MINUTE, 107], [8 * MINUTE, 108]]);
  });
});

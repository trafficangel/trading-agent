import { describe, expect, it } from 'vitest';
import {
  aggregateCompleteNativeBars,
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

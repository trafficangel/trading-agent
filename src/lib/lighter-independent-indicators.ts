export type CompletedOhlcv = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

/**
 * Canonical Ultimate Oscillator (7/14/28). Each value uses only bars up to the
 * same index. Warm-up and degenerate ranges are neutral rather than signals.
 */
export function ultimateOscillator(
  bars: readonly CompletedOhlcv[],
  fast = 7,
  medium = 14,
  slow = 28,
): number[] {
  if (!(fast > 0 && fast < medium && medium < slow)) {
    throw new Error('Ultimate Oscillator periods must satisfy 0 < fast < medium < slow');
  }
  const buyingPressure = new Array<number>(bars.length).fill(0);
  const trueRange = new Array<number>(bars.length).fill(0);
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previousClose = index > 0 ? bars[index - 1]!.close : bar.close;
    const lower = Math.min(bar.low, previousClose);
    const upper = Math.max(bar.high, previousClose);
    buyingPressure[index] = bar.close - lower;
    trueRange[index] = upper - lower;
  }
  const rollingRatio = (index: number, period: number): number | null => {
    if (index + 1 < period) return null;
    let pressure = 0;
    let range = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      pressure += buyingPressure[cursor]!;
      range += trueRange[cursor]!;
    }
    return range > 0 ? pressure / range : null;
  };
  return bars.map((_bar, index) => {
    const fastAverage = rollingRatio(index, fast);
    const mediumAverage = rollingRatio(index, medium);
    const slowAverage = rollingRatio(index, slow);
    if (fastAverage == null || mediumAverage == null || slowAverage == null) return 50;
    return 100 * (4 * fastAverage + 2 * mediumAverage + slowAverage) / 7;
  });
}

/**
 * Elder Force Index EMA followed by a rolling population Z-score. Volume is
 * native Lighter candle volume; no future normalization window is used.
 */
export function elderForceIndexZScore(
  bars: readonly CompletedOhlcv[],
  emaPeriod = 13,
  zPeriod = 60,
): number[] {
  if (!(emaPeriod > 1 && zPeriod > 1)) throw new Error('EFI periods must exceed one');
  const raw = bars.map((bar, index) => (
    index > 0 ? (bar.close - bars[index - 1]!.close) * bar.volume : 0
  ));
  const alpha = 2 / (emaPeriod + 1);
  const smoothed: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    smoothed[index] = index === 0
      ? raw[index]!
      : raw[index]! * alpha + smoothed[index - 1]! * (1 - alpha);
  }
  return smoothed.map((value, index) => {
    if (index + 1 < zPeriod) return 0;
    const window = smoothed.slice(index - zPeriod + 1, index + 1);
    const mean = window.reduce((sum, current) => sum + current, 0) / window.length;
    const variance = window.reduce(
      (sum, current) => sum + (current - mean) ** 2,
      0,
    ) / window.length;
    const deviation = Math.sqrt(variance);
    return deviation > 0 ? (value - mean) / deviation : 0;
  });
}

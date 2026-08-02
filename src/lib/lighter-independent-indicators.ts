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

/**
 * Canonical Choppiness Index. A high value means that completed bars have
 * travelled a large path inside a comparatively small range; a low value
 * means directional range expansion. Future bars cannot change past values.
 */
export function choppinessIndex(
  bars: readonly CompletedOhlcv[],
  period = 14,
): number[] {
  if (!(period > 1)) throw new Error('Choppiness period must exceed one');
  const trueRanges = bars.map((bar, index) => {
    const previousClose = index > 0 ? bars[index - 1]!.close : bar.close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
  const scale = Math.log10(period);
  return bars.map((_bar, index) => {
    if (index + 1 < period) return 50;
    let rangeSum = 0;
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      rangeSum += trueRanges[cursor]!;
      highest = Math.max(highest, bars[cursor]!.high);
      lowest = Math.min(lowest, bars[cursor]!.low);
    }
    const span = highest - lowest;
    if (!(span > 0) || !(rangeSum > 0)) return 50;
    return Math.max(0, Math.min(100, 100 * Math.log10(rangeSum / span) / scale));
  });
}

/**
 * Price Volume Trend MACD-style oscillator. PVT accumulates completed close
 * returns weighted by native traded volume; two causal EMAs and a causal
 * signal EMA turn it into a scale-independent crossover series.
 */
export function priceVolumeTrendOscillator(
  bars: readonly CompletedOhlcv[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { oscillator: number[]; signal: number[] } {
  if (!(fastPeriod > 1 && fastPeriod < slowPeriod && signalPeriod > 1)) {
    throw new Error('PVT periods must satisfy 1 < fast < slow and signal > 1');
  }
  const pvt = new Array<number>(bars.length).fill(0);
  for (let index = 1; index < bars.length; index += 1) {
    const previousClose = bars[index - 1]!.close;
    const returnPct = previousClose > 0
      ? (bars[index]!.close - previousClose) / previousClose
      : 0;
    pvt[index] = pvt[index - 1]! + bars[index]!.volume * returnPct;
  }
  const causalEma = (values: readonly number[], period: number): number[] => {
    const alpha = 2 / (period + 1);
    const output = new Array<number>(values.length).fill(0);
    for (let index = 0; index < values.length; index += 1) {
      output[index] = index === 0
        ? values[index]!
        : values[index]! * alpha + output[index - 1]! * (1 - alpha);
    }
    return output;
  };
  const fast = causalEma(pvt, fastPeriod);
  const slow = causalEma(pvt, slowPeriod);
  const oscillator = fast.map((value, index) => value - slow[index]!);
  return { oscillator, signal: causalEma(oscillator, signalPeriod) };
}

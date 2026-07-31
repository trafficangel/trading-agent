export type Z60Bar = {
  time: number;
  close: number;
};

export type Vwz60Bar = Z60Bar & {
  volume: number;
};

export type Z60Signal = 'long' | 'short' | null;

export type Z60Snapshot = {
  barTime: number;
  close: number;
  mean: number;
  previousZ: number;
  currentZ: number;
  signal: Z60Signal;
  trendMean?: number;
  slowTrendMean?: number;
};

export type Z60EntryMode = 'reclaim' | 'touch';

function populationStats(values: readonly number[]): { mean: number; sigma: number } | null {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sigma = Math.sqrt(variance);
  return sigma > 0 ? { mean, sigma } : null;
}

function zAt(closes: readonly number[], index: number, period: number): {
  mean: number;
  z: number;
} | null {
  const start = index - period + 1;
  if (start < 0 || index >= closes.length) return null;
  const stats = populationStats(closes.slice(start, index + 1));
  if (!stats) return null;
  return {
    mean: stats.mean,
    z: (closes[index]! - stats.mean) / stats.sigma,
  };
}

function volumeWeightedZAt(bars: readonly Vwz60Bar[], index: number, period: number): {
  mean: number;
  z: number;
} | null {
  const start = index - period + 1;
  if (start < 0 || index >= bars.length) return null;
  let volume = 0;
  let weighted = 0;
  let weightedSquares = 0;
  for (let i = start; i <= index; i += 1) {
    const bar = bars[i]!;
    if (!Number.isFinite(bar.close) || !Number.isFinite(bar.volume) || bar.volume < 0) return null;
    volume += bar.volume;
    weighted += bar.close * bar.volume;
    weightedSquares += bar.close * bar.close * bar.volume;
  }
  if (!(volume > 0)) return null;
  const mean = weighted / volume;
  const variance = Math.max(0, weightedSquares / volume - mean * mean);
  const sigma = Math.sqrt(variance);
  if (!(sigma > 0)) return null;
  return {
    mean,
    z: (bars[index]!.close - mean) / sigma,
  };
}

/**
 * Completed-bar Z-score evaluator used by the STRAT-030 reclaim and STRAT-031
 * touch variants. It deliberately has no regime, spread, or funding gate.
 * Venue costs are measured after the signal by the Lighter L2 shadow executor.
 */
export function evaluateZ60(
  bars: readonly Z60Bar[],
  period = 60,
  threshold = 3,
  mode: Z60EntryMode = 'reclaim',
): Z60Snapshot | null {
  if (bars.length < period + 1 || period < 2 || !(threshold > 0)) return null;
  const closes = bars.map((bar) => bar.close);
  const currentIndex = bars.length - 1;
  const previous = zAt(closes, currentIndex - 1, period);
  const current = zAt(closes, currentIndex, period);
  if (!previous || !current) return null;

  let signal: Z60Signal = null;
  if (mode === 'touch') {
    if (current.z < -threshold) signal = 'long';
    else if (current.z > threshold) signal = 'short';
  } else {
    if (previous.z < -threshold && current.z >= -threshold) signal = 'long';
    else if (previous.z > threshold && current.z <= threshold) signal = 'short';
  }

  return {
    barTime: bars[currentIndex]!.time,
    close: closes[currentIndex]!,
    mean: current.mean,
    previousZ: previous.z,
    currentZ: current.z,
    signal,
  };
}

export function evaluateZ60Reclaim(
  bars: readonly Z60Bar[],
  period = 60,
  threshold = 3,
): Z60Snapshot | null {
  return evaluateZ60(bars, period, threshold, 'reclaim');
}

export function evaluateZ60Touch(
  bars: readonly Z60Bar[],
  period = 60,
  threshold = 3,
): Z60Snapshot | null {
  return evaluateZ60(bars, period, threshold, 'touch');
}

/**
 * Symmetric Z-score pullback aligned with a slower completed-bar EMA. The
 * signal is identical on both sides: buy a negative Z excursion only while
 * price remains above the trend EMA, and sell a positive excursion only while
 * price remains below it. No unfinished candle or future value is used.
 */
export function evaluateTrendFilteredZ60(
  bars: readonly Z60Bar[],
  period = 60,
  threshold = 2.5,
  mode: Z60EntryMode = 'touch',
  trendPeriod = 200,
): Z60Snapshot | null {
  if (bars.length < Math.max(period + 1, trendPeriod) || trendPeriod < 2) return null;
  const snapshot = evaluateZ60(bars, period, threshold, mode);
  if (!snapshot) return null;

  const alpha = 2 / (trendPeriod + 1);
  let trendMean = bars[0]!.close;
  for (let index = 1; index < bars.length; index += 1) {
    trendMean = bars[index]!.close * alpha + trendMean * (1 - alpha);
  }

  const signal = snapshot.signal === 'long' && snapshot.close <= trendMean
    ? null
    : snapshot.signal === 'short' && snapshot.close >= trendMean
      ? null
      : snapshot.signal;
  return { ...snapshot, signal, trendMean };
}

/**
 * Two-sided Z-score pullback that requires a fully aligned trend stack.
 * Long: close > EMA(fast) > EMA(slow). Short is the exact mirror image.
 * Every value is calculated from completed bars only.
 */
export function evaluateTrendStackZ60(
  bars: readonly Z60Bar[],
  period = 60,
  threshold = 2.5,
  mode: Z60EntryMode = 'touch',
  fastTrendPeriod = 200,
  slowTrendPeriod = 400,
): Z60Snapshot | null {
  if (
    bars.length < Math.max(period + 1, fastTrendPeriod, slowTrendPeriod)
    || fastTrendPeriod < 2
    || slowTrendPeriod <= fastTrendPeriod
  ) return null;
  const snapshot = evaluateZ60(bars, period, threshold, mode);
  if (!snapshot) return null;

  const fastAlpha = 2 / (fastTrendPeriod + 1);
  const slowAlpha = 2 / (slowTrendPeriod + 1);
  let trendMean = bars[0]!.close;
  let slowTrendMean = bars[0]!.close;
  for (let index = 1; index < bars.length; index += 1) {
    const close = bars[index]!.close;
    trendMean = close * fastAlpha + trendMean * (1 - fastAlpha);
    slowTrendMean = close * slowAlpha + slowTrendMean * (1 - slowAlpha);
  }

  const signal = snapshot.signal === 'long'
    && !(snapshot.close > trendMean && trendMean > slowTrendMean)
    ? null
    : snapshot.signal === 'short'
      && !(snapshot.close < trendMean && trendMean < slowTrendMean)
      ? null
      : snapshot.signal;
  return { ...snapshot, signal, trendMean, slowTrendMean };
}

/**
 * Completed-bar volume-weighted Z-score evaluator. It mirrors evaluateZ60()
 * but weights the rolling 60-bar distribution by native Lighter volume.
 */
export function evaluateVwz60(
  bars: readonly Vwz60Bar[],
  period = 60,
  threshold = 3,
  mode: Z60EntryMode = 'touch',
): Z60Snapshot | null {
  if (bars.length < period + 1 || period < 2 || !(threshold > 0)) return null;
  const currentIndex = bars.length - 1;
  const previous = volumeWeightedZAt(bars, currentIndex - 1, period);
  const current = volumeWeightedZAt(bars, currentIndex, period);
  if (!previous || !current) return null;

  let signal: Z60Signal = null;
  if (mode === 'touch') {
    if (current.z < -threshold) signal = 'long';
    else if (current.z > threshold) signal = 'short';
  } else {
    if (previous.z < -threshold && current.z >= -threshold) signal = 'long';
    else if (previous.z > threshold && current.z <= threshold) signal = 'short';
  }

  return {
    barTime: bars[currentIndex]!.time,
    close: bars[currentIndex]!.close,
    mean: current.mean,
    previousZ: previous.z,
    currentZ: current.z,
    signal,
  };
}

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

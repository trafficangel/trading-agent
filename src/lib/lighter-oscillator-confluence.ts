import {
  evaluateVwz60,
  type Vwz60Bar,
  type Z60Signal,
  type Z60Snapshot,
} from './lighter-z60.js';

export type RsiWilliamsSnapshot = {
  barTime: number;
  close: number;
  previousRsi: number;
  currentRsi: number;
  currentWilliams: number;
  trendMean: number;
  signal: Z60Signal;
};

export type VwzMfiSnapshot = Z60Snapshot & {
  currentMfi: number;
};

export type VwzWilliamsSnapshot = Z60Snapshot & {
  currentWilliams: number;
};

export type VwzStochasticSnapshot = Z60Snapshot & {
  currentStochastic: number;
};

export type RsiMfiSnapshot = {
  barTime: number;
  close: number;
  previousRsi: number;
  currentRsi: number;
  currentMfi: number;
  trendMean: number;
  signal: Z60Signal;
};

export type BollingerWilliamsReclaimSnapshot = {
  barTime: number;
  close: number;
  previousClose: number;
  mean: number;
  lower: number;
  upper: number;
  previousLower: number;
  previousUpper: number;
  currentWilliams: number;
  trendMean: number;
  signal: Z60Signal;
};

function completedEma(closes: readonly number[], period: number): number | null {
  if (period < 2 || closes.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = closes[0]!;
  if (!Number.isFinite(value) || value <= 0) return null;
  for (let index = 1; index < closes.length; index += 1) {
    const close = closes[index]!;
    if (!Number.isFinite(close) || close <= 0) return null;
    value = close * alpha + value * (1 - alpha);
  }
  return value;
}

function completedRsi(closes: readonly number[], period: number): number[] | null {
  if (period < 2 || closes.length < period + 2) return null;
  const result: number[] = [];
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 0; index < closes.length; index += 1) {
    const close = closes[index]!;
    if (!Number.isFinite(close) || close <= 0) return null;
    if (index === 0) {
      result.push(50);
      continue;
    }
    const change = close - closes[index - 1]!;
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (index <= period) {
      averageGain += gain / period;
      averageLoss += loss / period;
      result.push(50);
      continue;
    }
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    const relativeStrength = averageLoss === 0 ? 100 : averageGain / averageLoss;
    result.push(100 - 100 / (1 + relativeStrength));
  }
  return result;
}

function currentWilliams(bars: readonly Vwz60Bar[], period: number): number | null {
  if (period < 2 || bars.length < period) return null;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const bar of bars.slice(-period)) {
    if (
      !Number.isFinite(bar.high)
      || !Number.isFinite(bar.low)
      || bar.high! < bar.low!
    ) return null;
    high = Math.max(high, bar.high!);
    low = Math.min(low, bar.low!);
  }
  return high > low ? -100 * (high - bars.at(-1)!.close) / (high - low) : -50;
}

function currentStochastic(bars: readonly Vwz60Bar[], period: number): number | null {
  const williams = currentWilliams(bars, period);
  return williams == null ? null : williams + 100;
}

function currentMfi(bars: readonly Vwz60Bar[], period: number): number | null {
  if (period < 2 || bars.length < period + 1) return null;
  const start = bars.length - period;
  let positive = 0;
  let negative = 0;
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previous = bars[index - 1]!;
    if (
      !Number.isFinite(bar.high)
      || !Number.isFinite(bar.low)
      || !Number.isFinite(bar.volume)
      || bar.volume < 0
      || !Number.isFinite(previous.high)
      || !Number.isFinite(previous.low)
    ) return null;
    const typical = (bar.high! + bar.low! + bar.close) / 3;
    const previousTypical = (previous.high! + previous.low! + previous.close) / 3;
    const flow = typical * bar.volume;
    if (typical > previousTypical) positive += flow;
    else if (typical < previousTypical) negative += flow;
  }
  if (negative === 0) return positive > 0 ? 100 : 50;
  return 100 - 100 / (1 + positive / negative);
}

function completedMeanStd(values: readonly number[]): { mean: number; std: number } | null {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Frozen Bollinger(20,2) reclaim + Williams %R14 aligned with EMA400. */
export function evaluateBollingerWilliamsReclaim(
  bars: readonly Vwz60Bar[],
  bollingerPeriod = 20,
  deviations = 2,
  williamsPeriod = 14,
  williamsEdge = 20,
  trendPeriod = 400,
): BollingerWilliamsReclaimSnapshot | null {
  if (
    bollingerPeriod < 2
    || !(deviations > 0)
    || !(williamsEdge > 0 && williamsEdge < 50)
    || trendPeriod < 2
    || bars.length < Math.max(bollingerPeriod + 1, williamsPeriod, trendPeriod)
  ) return null;
  const closes = bars.map((bar) => bar.close);
  const currentStats = completedMeanStd(closes.slice(-bollingerPeriod));
  const previousStats = completedMeanStd(closes.slice(-bollingerPeriod - 1, -1));
  const trendMean = completedEma(closes, trendPeriod);
  const williams = currentWilliams(bars, williamsPeriod);
  if (!currentStats || !previousStats || trendMean == null || williams == null) return null;
  const close = closes.at(-1)!;
  const previousClose = closes.at(-2)!;
  const lower = currentStats.mean - deviations * currentStats.std;
  const upper = currentStats.mean + deviations * currentStats.std;
  const previousLower = previousStats.mean - deviations * previousStats.std;
  const previousUpper = previousStats.mean + deviations * previousStats.std;
  const signal = previousClose < previousLower
    && close >= lower
    && williams < -100 + williamsEdge
    && close > trendMean
    ? 'long'
    : previousClose > previousUpper
      && close <= upper
      && williams > -williamsEdge
      && close < trendMean
      ? 'short'
      : null;
  return {
    barTime: bars.at(-1)!.time,
    close,
    previousClose,
    mean: currentStats.mean,
    lower,
    upper,
    previousLower,
    previousUpper,
    currentWilliams: williams,
    trendMean,
    signal,
  };
}

export function bollingerMeanExit(
  snapshot: BollingerWilliamsReclaimSnapshot,
  side: 'long' | 'short',
): boolean {
  return side === 'long' ? snapshot.close >= snapshot.mean : snapshot.close <= snapshot.mean;
}

/** Frozen two-sided RSI14 + Williams %R14 pullback aligned with EMA400. */
export function evaluateRsiWilliamsTrend(
  bars: readonly Vwz60Bar[],
  rsiPeriod = 14,
  rsiLevel = 30,
  williamsPeriod = 14,
  williamsEdge = 20,
  trendPeriod = 400,
): RsiWilliamsSnapshot | null {
  if (
    !(rsiLevel > 0 && rsiLevel < 50)
    || !(williamsEdge > 0 && williamsEdge < 50)
    || trendPeriod < 2
  ) return null;
  const closes = bars.map((bar) => bar.close);
  if (closes.length < Math.max(rsiPeriod + 2, williamsPeriod, trendPeriod)) return null;
  const values = completedRsi(closes, rsiPeriod);
  const trendMean = completedEma(closes, trendPeriod);
  const currentWilliamsValue = currentWilliams(bars, williamsPeriod);
  if (!values || trendMean == null || currentWilliamsValue == null) return null;
  const currentIndex = bars.length - 1;
  const currentRsi = values[currentIndex]!;
  const close = closes[currentIndex]!;
  const signal = currentRsi < rsiLevel
    && currentWilliamsValue < -100 + williamsEdge
    && close > trendMean
    ? 'long'
    : currentRsi > 100 - rsiLevel
      && currentWilliamsValue > -williamsEdge
      && close < trendMean
      ? 'short'
      : null;
  return {
    barTime: bars[currentIndex]!.time,
    close,
    previousRsi: values[currentIndex - 1]!,
    currentRsi,
    currentWilliams: currentWilliamsValue,
    trendMean,
    signal,
  };
}

/** Frozen two-sided VWZ60 + MFI14 pullback aligned with EMA400. */
export function evaluateVwzMfiTrend(
  bars: readonly Vwz60Bar[],
  period = 60,
  threshold = 2.5,
  mfiPeriod = 14,
  mfiLevel = 35,
  trendPeriod = 400,
): VwzMfiSnapshot | null {
  if (!(mfiLevel > 0 && mfiLevel < 50) || trendPeriod < 2) return null;
  const snapshot = evaluateVwz60(bars, period, threshold, 'touch');
  const trendMean = completedEma(bars.map((bar) => bar.close), trendPeriod);
  const currentMfiValue = currentMfi(bars, mfiPeriod);
  if (!snapshot || trendMean == null || currentMfiValue == null) return null;
  const signal = snapshot.signal === 'long'
    && (currentMfiValue >= mfiLevel || snapshot.close <= trendMean)
    ? null
    : snapshot.signal === 'short'
      && (currentMfiValue <= 100 - mfiLevel || snapshot.close >= trendMean)
      ? null
      : snapshot.signal;
  return {
    ...snapshot,
    signal,
    trendMean,
    currentMfi: currentMfiValue,
  };
}

/** Frozen two-sided VWZ60 + Williams %R14 pullback aligned with EMA400. */
export function evaluateVwzWilliamsTrend(
  bars: readonly Vwz60Bar[],
  period = 60,
  threshold = 2.5,
  williamsPeriod = 14,
  williamsEdge = 20,
  trendPeriod = 400,
): VwzWilliamsSnapshot | null {
  if (
    !(williamsEdge > 0 && williamsEdge < 50)
    || trendPeriod < 2
  ) return null;
  const snapshot = evaluateVwz60(bars, period, threshold, 'touch');
  const trendMean = completedEma(bars.map((bar) => bar.close), trendPeriod);
  const currentWilliamsValue = currentWilliams(bars, williamsPeriod);
  if (!snapshot || trendMean == null || currentWilliamsValue == null) return null;
  const signal = snapshot.signal === 'long'
    && (currentWilliamsValue >= -100 + williamsEdge || snapshot.close <= trendMean)
    ? null
    : snapshot.signal === 'short'
      && (currentWilliamsValue <= -williamsEdge || snapshot.close >= trendMean)
      ? null
      : snapshot.signal;
  return {
    ...snapshot,
    signal,
    trendMean,
    currentWilliams: currentWilliamsValue,
  };
}

/** Frozen two-sided VWZ60 + Stochastic14 pullback aligned with EMA400. */
export function evaluateVwzStochasticTrend(
  bars: readonly Vwz60Bar[],
  period = 60,
  threshold = 2.25,
  stochasticPeriod = 14,
  stochasticEdge = 20,
  trendPeriod = 400,
): VwzStochasticSnapshot | null {
  if (
    !(stochasticEdge > 0 && stochasticEdge < 50)
    || trendPeriod < 2
  ) return null;
  const snapshot = evaluateVwz60(bars, period, threshold, 'touch');
  const trendMean = completedEma(bars.map((bar) => bar.close), trendPeriod);
  const stochastic = currentStochastic(bars, stochasticPeriod);
  if (!snapshot || trendMean == null || stochastic == null) return null;
  const signal = snapshot.signal === 'long'
    && (stochastic >= stochasticEdge || snapshot.close <= trendMean)
    ? null
    : snapshot.signal === 'short'
      && (stochastic <= 100 - stochasticEdge || snapshot.close >= trendMean)
      ? null
      : snapshot.signal;
  return {
    ...snapshot,
    signal,
    trendMean,
    currentStochastic: stochastic,
  };
}

/** Frozen two-sided RSI14 + MFI14 pullback aligned with EMA400. */
export function evaluateRsiMfiTrend(
  bars: readonly Vwz60Bar[],
  rsiPeriod = 14,
  rsiLevel = 30,
  mfiPeriod = 14,
  mfiLevel = 30,
  trendPeriod = 400,
): RsiMfiSnapshot | null {
  if (
    !(rsiLevel > 0 && rsiLevel < 50)
    || !(mfiLevel > 0 && mfiLevel < 50)
    || trendPeriod < 2
  ) return null;
  const closes = bars.map((bar) => bar.close);
  if (closes.length < Math.max(rsiPeriod + 2, mfiPeriod + 1, trendPeriod)) return null;
  const values = completedRsi(closes, rsiPeriod);
  const trendMean = completedEma(closes, trendPeriod);
  const currentMfiValue = currentMfi(bars, mfiPeriod);
  if (!values || trendMean == null || currentMfiValue == null) return null;
  const currentIndex = bars.length - 1;
  const currentRsi = values[currentIndex]!;
  const close = closes[currentIndex]!;
  const signal = currentRsi < rsiLevel
    && currentMfiValue < mfiLevel
    && close > trendMean
    ? 'long'
    : currentRsi > 100 - rsiLevel
      && currentMfiValue > 100 - mfiLevel
      && close < trendMean
      ? 'short'
      : null;
  return {
    barTime: bars[currentIndex]!.time,
    close,
    previousRsi: values[currentIndex - 1]!,
    currentRsi,
    currentMfi: currentMfiValue,
    trendMean,
    signal,
  };
}

export function rsiWilliamsExit(
  snapshot: RsiWilliamsSnapshot,
  side: 'long' | 'short',
): boolean {
  return side === 'long' ? snapshot.currentRsi >= 50 : snapshot.currentRsi <= 50;
}

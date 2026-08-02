export type CompletedOhlcv = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

/**
 * Causal rolling variance ratio of q-bar log returns to q times one-bar
 * variance. Values below one indicate short-horizon mean reversion; values
 * above one indicate persistence. Every window ends at the completed bar.
 */
export function rollingVarianceRatio(
  closes: readonly number[],
  period = 120,
  aggregation = 5,
): number[] {
  if (!(period > aggregation * 2 && aggregation > 1)) {
    throw new Error('Variance-ratio period must exceed twice the aggregation');
  }
  const returns = closes.map((close, index) => (
    index > 0 && close > 0 && closes[index - 1]! > 0
      ? Math.log(close / closes[index - 1]!)
      : 0
  ));
  const prefix = new Array<number>(returns.length + 1).fill(0);
  const prefixSquares = new Array<number>(returns.length + 1).fill(0);
  const aggregated = new Array<number>(returns.length).fill(0);
  const aggregatePrefix = new Array<number>(returns.length + 1).fill(0);
  const aggregatePrefixSquares = new Array<number>(returns.length + 1).fill(0);
  let aggregateRolling = 0;
  for (let index = 0; index < returns.length; index += 1) {
    prefix[index + 1] = prefix[index]! + returns[index]!;
    prefixSquares[index + 1] = prefixSquares[index]! + returns[index]! ** 2;
    aggregateRolling += returns[index]!;
    if (index >= aggregation) aggregateRolling -= returns[index - aggregation]!;
    if (index + 1 >= aggregation) aggregated[index] = aggregateRolling;
    aggregatePrefix[index + 1] = aggregatePrefix[index]! + aggregated[index]!;
    aggregatePrefixSquares[index + 1] = aggregatePrefixSquares[index]!
      + aggregated[index]! ** 2;
  }
  return closes.map((_close, index) => {
    if (index < period + aggregation - 1) return 1;
    const start = index - period + 1;
    const oneCount = period;
    const oneSum = prefix[index + 1]! - prefix[start]!;
    const oneSquareSum = prefixSquares[index + 1]! - prefixSquares[start]!;
    const oneMean = oneSum / oneCount;
    const oneVariance = Math.max(0, oneSquareSum / oneCount - oneMean ** 2);
    if (!(oneVariance > 0)) return 1;
    const aggregateStart = start + aggregation - 1;
    const aggregateCount = index - aggregateStart + 1;
    const aggregateSum = aggregatePrefix[index + 1]! - aggregatePrefix[aggregateStart]!;
    const aggregateSquareSum = aggregatePrefixSquares[index + 1]!
      - aggregatePrefixSquares[aggregateStart]!;
    const aggregateMean = aggregateSum / aggregateCount;
    const aggregateVariance = Math.max(
      0,
      aggregateSquareSum / aggregateCount - aggregateMean ** 2,
    );
    return aggregateVariance / (aggregation * oneVariance);
  });
}

/**
 * Relative Momentum Index: Wilder RSI applied to a completed close change
 * over `momentum` bars instead of the usual one-bar change. The output is
 * causal, bounded and neutral during warm-up/flat paths.
 */
export function relativeMomentumIndex(
  closes: readonly number[],
  period = 14,
  momentum = 5,
): number[] {
  if (!(period > 1 && momentum > 0)) {
    throw new Error('RMI period must exceed one and momentum must be positive');
  }
  const output = new Array<number>(closes.length).fill(50);
  const changes = closes.map((close, index) => (
    index >= momentum ? close - closes[index - momentum]! : 0
  ));
  const first = momentum + period - 1;
  if (first >= closes.length) return output;
  let gain = 0;
  let loss = 0;
  for (let index = momentum; index <= first; index += 1) {
    gain += Math.max(changes[index]!, 0);
    loss += Math.max(-changes[index]!, 0);
  }
  gain /= period;
  loss /= period;
  const value = (): number => {
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  };
  output[first] = value();
  for (let index = first + 1; index < closes.length; index += 1) {
    gain = (gain * (period - 1) + Math.max(changes[index]!, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-changes[index]!, 0)) / period;
    output[index] = value();
  }
  return output;
}

/**
 * Causal rolling Z-score of a completed multi-bar log return. The current
 * return is standardized only by a window ending at the same completed bar;
 * future observations cannot revise prior values.
 */
export function rollingReturnZScore(
  closes: readonly number[],
  returnPeriod = 5,
  zPeriod = 120,
): number[] {
  if (!(returnPeriod > 0 && zPeriod > 2)) {
    throw new Error('Return period must be positive and Z period must exceed two');
  }
  const returns = closes.map((close, index) => (
    index >= returnPeriod && close > 0 && closes[index - returnPeriod]! > 0
      ? Math.log(close / closes[index - returnPeriod]!)
      : 0
  ));
  const output = new Array<number>(closes.length).fill(0);
  let sum = 0;
  let squareSum = 0;
  for (let index = 0; index < returns.length; index += 1) {
    sum += returns[index]!;
    squareSum += returns[index]! ** 2;
    if (index >= zPeriod) {
      sum -= returns[index - zPeriod]!;
      squareSum -= returns[index - zPeriod]! ** 2;
    }
    if (index + 1 < returnPeriod + zPeriod - 1) continue;
    const mean = sum / zPeriod;
    const variance = Math.max(0, squareSum / zPeriod - mean ** 2);
    const deviation = Math.sqrt(variance);
    output[index] = deviation > 0 ? (returns[index]! - mean) / deviation : 0;
  }
  return output;
}

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

function wilderRsi(values: readonly number[], period: number): number[] {
  const output = new Array<number>(values.length).fill(50);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  const value = (): number => {
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  };
  output[period] = value();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = value();
  }
  return output;
}

/**
 * Full Connors RSI: RSI of close, RSI of signed close streak and percentile
 * rank of the completed one-bar return. The percentile window excludes the
 * current return, so every component is known at the completed bar and a
 * future append cannot revise history.
 */
export function connorsRsi(
  closes: readonly number[],
  closeRsiPeriod = 3,
  streakRsiPeriod = 2,
  percentilePeriod = 100,
): number[] {
  if (!(closeRsiPeriod > 1 && streakRsiPeriod > 1 && percentilePeriod > 1)) {
    throw new Error('Connors RSI periods must exceed one');
  }
  const streak = new Array<number>(closes.length).fill(0);
  const returns = new Array<number>(closes.length).fill(0);
  for (let index = 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    if (change > 0) streak[index] = Math.max(1, streak[index - 1]! + 1);
    else if (change < 0) streak[index] = Math.min(-1, streak[index - 1]! - 1);
    returns[index] = closes[index - 1]! !== 0
      ? change / closes[index - 1]!
      : 0;
  }
  const closeRsi = wilderRsi(closes, closeRsiPeriod);
  const streakRsi = wilderRsi(streak, streakRsiPeriod);
  return closes.map((_close, index) => {
    if (index <= percentilePeriod) return 50;
    let below = 0;
    let equal = 0;
    for (let cursor = index - percentilePeriod; cursor < index; cursor += 1) {
      if (returns[cursor]! < returns[index]!) below += 1;
      else if (returns[cursor] === returns[index]!) equal += 1;
    }
    const percentile = 100 * (below + 0.5 * equal) / percentilePeriod;
    return (closeRsi[index]! + streakRsi[index]! + percentile) / 3;
  });
}

/**
 * Causal Z-score of the right-edge residual from a rolling least-squares
 * price trend. The trend window is re-fitted only with completed closes; the
 * residual scale is itself estimated from past completed residuals.
 */
export function rollingRegressionResidualZScore(
  closes: readonly number[],
  regressionPeriod = 60,
  residualPeriod = 60,
): number[] {
  if (!(regressionPeriod > 2 && residualPeriod > 2)) {
    throw new Error('Regression residual periods must exceed two');
  }
  const residuals = new Array<number>(closes.length).fill(0);
  const output = new Array<number>(closes.length).fill(0);
  const sumX = regressionPeriod * (regressionPeriod - 1) / 2;
  const sumX2 = regressionPeriod * (regressionPeriod - 1) * (2 * regressionPeriod - 1) / 6;
  const denominator = regressionPeriod * sumX2 - sumX ** 2;
  let sumY = 0;
  let sumXY = 0;
  let residualSum = 0;
  let residualSquareSum = 0;
  for (let index = 0; index < closes.length; index += 1) {
    const current = closes[index]!;
    if (index < regressionPeriod) {
      sumY += current;
      sumXY += index * current;
    } else {
      const removed = closes[index - regressionPeriod]!;
      const remainingSum = sumY - removed;
      sumXY = sumXY - remainingSum + (regressionPeriod - 1) * current;
      sumY = remainingSum + current;
    }
    if (index + 1 >= regressionPeriod) {
      const slope = (regressionPeriod * sumXY - sumX * sumY) / denominator;
      const intercept = (sumY - slope * sumX) / regressionPeriod;
      residuals[index] = current - (intercept + slope * (regressionPeriod - 1));
    }
    residualSum += residuals[index]!;
    residualSquareSum += residuals[index]! ** 2;
    if (index >= residualPeriod) {
      residualSum -= residuals[index - residualPeriod]!;
      residualSquareSum -= residuals[index - residualPeriod]! ** 2;
    }
    if (index + 1 >= regressionPeriod + residualPeriod - 1) {
      const mean = residualSum / residualPeriod;
      const variance = Math.max(0, residualSquareSum / residualPeriod - mean ** 2);
      const deviation = Math.sqrt(variance);
      output[index] = deviation > 0 ? (residuals[index]! - mean) / deviation : 0;
    }
  }
  return output;
}

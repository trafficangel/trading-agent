import type { Z60Bar, Z60Signal } from './lighter-z60.js';

export type RsiTrendPullbackSnapshot = {
  barTime: number;
  close: number;
  previousRsi: number;
  currentRsi: number;
  trendMean: number;
  signal: Z60Signal;
};

function completedRsi(closes: readonly number[], period: number): number[] | null {
  if (period < 2 || closes.length < period + 2) return null;
  if (closes.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const result: number[] = [];
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 0; index < closes.length; index += 1) {
    if (index === 0) {
      result.push(50);
      continue;
    }
    const change = closes[index]! - closes[index - 1]!;
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

/**
 * Symmetric completed-bar RSI pullback aligned with a slow EMA.
 *
 * Long: RSI is below `level` while close remains above the EMA.
 * Short: RSI is above `100-level` while close remains below the EMA.
 * The caller executes only on the next bar, exactly as the historical sweep.
 */
export function evaluateRsiTrendPullback(
  bars: readonly Z60Bar[],
  rsiPeriod = 14,
  level = 25,
  trendPeriod = 400,
): RsiTrendPullbackSnapshot | null {
  if (!(level > 0 && level < 50) || trendPeriod < 2) return null;
  const closes = bars.map((bar) => bar.close);
  if (closes.length < Math.max(rsiPeriod + 2, trendPeriod)) return null;
  const values = completedRsi(closes, rsiPeriod);
  const trendMean = completedEma(closes, trendPeriod);
  if (!values || trendMean == null) return null;
  const currentIndex = closes.length - 1;
  const currentRsi = values[currentIndex]!;
  const previousRsi = values[currentIndex - 1]!;
  const close = closes[currentIndex]!;
  const signal = currentRsi < level && close > trendMean
    ? 'long'
    : currentRsi > 100 - level && close < trendMean
      ? 'short'
      : null;
  return {
    barTime: bars[currentIndex]!.time,
    close,
    previousRsi,
    currentRsi,
    trendMean,
    signal,
  };
}

export function rsiTrendExit(
  snapshot: RsiTrendPullbackSnapshot,
  side: 'long' | 'short',
): boolean {
  return side === 'long' ? snapshot.currentRsi >= 50 : snapshot.currentRsi <= 50;
}

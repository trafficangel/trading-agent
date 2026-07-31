import type { LighterFundingSeries } from './lighter-funding-history.js';

/**
 * Causal Z-score of the latest completed hourly funding settlement.
 *
 * Candle timestamps are bar opens. A value for candle i may use settlements
 * known by that candle's close (the next-bar entry time), but the latest
 * settlement is excluded from its own trailing mean and deviation.
 */
export function completedFundingZScore(
  candleOpenTimesMs: readonly number[],
  barMinutes: number,
  series: LighterFundingSeries | undefined,
  lookback = 168,
): number[] {
  const result = new Array<number>(candleOpenTimesMs.length).fill(Number.NaN);
  if (!series || lookback < 2 || !(barMinutes > 0)) return result;

  const rates = series.timestampsMs.map((_, index) =>
    series.longPayerPrefixPct[index + 1]! - series.longPayerPrefixPct[index]!);
  const sumPrefix = new Array<number>(rates.length + 1).fill(0);
  const squarePrefix = new Array<number>(rates.length + 1).fill(0);
  for (let index = 0; index < rates.length; index += 1) {
    const rate = rates[index]!;
    sumPrefix[index + 1] = sumPrefix[index]! + rate;
    squarePrefix[index + 1] = squarePrefix[index]! + rate * rate;
  }

  const barMs = barMinutes * 60_000;
  let latestFundingIndex = -1;
  for (let candleIndex = 0; candleIndex < candleOpenTimesMs.length; candleIndex += 1) {
    const knownAt = candleOpenTimesMs[candleIndex]! + barMs;
    while (
      latestFundingIndex + 1 < series.timestampsMs.length
      && series.timestampsMs[latestFundingIndex + 1]! <= knownAt
    ) latestFundingIndex += 1;
    if (latestFundingIndex < lookback) continue;

    const start = latestFundingIndex - lookback;
    const end = latestFundingIndex;
    const trailingSum = sumPrefix[end]! - sumPrefix[start]!;
    const trailingSquareSum = squarePrefix[end]! - squarePrefix[start]!;
    const mean = trailingSum / lookback;
    const variance = Math.max(0, trailingSquareSum / lookback - mean * mean);
    const deviation = Math.sqrt(variance);
    if (deviation > 0) {
      result[candleIndex] = (rates[latestFundingIndex]! - mean) / deviation;
    }
  }
  return result;
}

export function fundingCrowdingSide(
  fundingZ: number,
  priceZ: number,
  threshold = 2,
): 'long' | 'short' | null {
  if (!Number.isFinite(fundingZ) || !Number.isFinite(priceZ)) return null;
  if (fundingZ <= -threshold && priceZ <= -threshold) return 'long';
  if (fundingZ >= threshold && priceZ >= threshold) return 'short';
  return null;
}

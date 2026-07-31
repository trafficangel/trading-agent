export type SerialAdaptiveSide = 'long' | 'short';

/**
 * Pearson lag-one correlation of the `period` completed log returns ending at
 * i - 1. The return of signal candle i is deliberately excluded, so changing
 * candle i or any future candle cannot change the regime used at i.
 */
export function completedLagOneReturnCorrelation(
  closes: readonly number[],
  period: number,
): number[] {
  if (!Number.isInteger(period) || period < 3) throw new Error('invalid correlation period');
  if (closes.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('invalid close series');
  }
  const returns = closes.map((value, index) =>
    index === 0 ? 0 : Math.log(value / closes[index - 1]!));
  const prefixX = new Array<number>(closes.length + 1).fill(0);
  const prefixY = new Array<number>(closes.length + 1).fill(0);
  const prefixXX = new Array<number>(closes.length + 1).fill(0);
  const prefixYY = new Array<number>(closes.length + 1).fill(0);
  const prefixXY = new Array<number>(closes.length + 1).fill(0);
  for (let index = 1; index + 1 < returns.length; index += 1) {
    const x = returns[index]!;
    const y = returns[index + 1]!;
    prefixX[index + 1] = prefixX[index]! + x;
    prefixY[index + 1] = prefixY[index]! + y;
    prefixXX[index + 1] = prefixXX[index]! + x * x;
    prefixYY[index + 1] = prefixYY[index]! + y * y;
    prefixXY[index + 1] = prefixXY[index]! + x * y;
  }
  // Fill the unused tail so range queries remain defined at the final candle.
  for (let index = Math.max(1, returns.length - 1); index < closes.length; index += 1) {
    prefixX[index + 1] = prefixX[index]!;
    prefixY[index + 1] = prefixY[index]!;
    prefixXX[index + 1] = prefixXX[index]!;
    prefixYY[index + 1] = prefixYY[index]!;
    prefixXY[index + 1] = prefixXY[index]!;
  }

  const result = new Array<number>(closes.length).fill(0);
  const range = (prefix: readonly number[], start: number, endExclusive: number): number =>
    prefix[endExclusive]! - prefix[start]!;
  for (let signalIndex = period + 1; signalIndex < closes.length; signalIndex += 1) {
    const start = signalIndex - period;
    const endExclusive = signalIndex - 1;
    const count = endExclusive - start;
    const sumX = range(prefixX, start, endExclusive);
    const sumY = range(prefixY, start, endExclusive);
    const sumXX = range(prefixXX, start, endExclusive);
    const sumYY = range(prefixYY, start, endExclusive);
    const sumXY = range(prefixXY, start, endExclusive);
    const covariance = sumXY - sumX * sumY / count;
    const varianceX = sumXX - sumX * sumX / count;
    const varianceY = sumYY - sumY * sumY / count;
    const denominator = Math.sqrt(Math.max(0, varianceX) * Math.max(0, varianceY));
    result[signalIndex] = denominator > 0 ? covariance / denominator : 0;
  }
  return result;
}

/** Frozen symmetric SERIAL120 signal adapter. */
export function serialAdaptiveSide(input: {
  correlation: number;
  open: number;
  close: number;
  atr: number;
  volume: number;
  volumeMean: number;
  correlationThreshold?: number;
  bodyAtrMultiple?: number;
}): SerialAdaptiveSide | null {
  const threshold = input.correlationThreshold ?? 0.15;
  const bodyMultiple = input.bodyAtrMultiple ?? 0.5;
  if (
    !Number.isFinite(input.correlation)
    || !Number.isFinite(input.open)
    || !Number.isFinite(input.close)
    || !Number.isFinite(input.atr)
    || !(input.atr > 0)
    || !Number.isFinite(input.volume)
    || !Number.isFinite(input.volumeMean)
    || input.volume < input.volumeMean
    || Math.abs(input.close - input.open) < bodyMultiple * input.atr
    || Math.abs(input.correlation) < threshold
    || input.close === input.open
  ) return null;
  const candleUp = input.close > input.open;
  const continuation = input.correlation > 0;
  if (continuation) return candleUp ? 'long' : 'short';
  return candleUp ? 'short' : 'long';
}

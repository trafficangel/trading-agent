export type PriceLevel = readonly [price: number, size: number];

export type VwapResult = {
  price: number;
  baseSize: number;
  notionalUsd: number;
};

export function normalizeExchangeTimestampMs(
  value: number,
  receivedAtMs: number,
): number {
  if (!Number.isFinite(value) || value <= 0) return receivedAtMs;
  let timestampMs = value;
  if (timestampMs < 100_000_000_000) timestampMs *= 1_000;
  else if (timestampMs > 100_000_000_000_000_000) timestampMs /= 1_000_000;
  else if (timestampMs > 100_000_000_000_000) timestampMs /= 1_000;
  if (
    !Number.isFinite(timestampMs)
    || Math.abs(timestampMs - receivedAtMs) > 5 * 60_000
  ) return receivedAtMs;
  return timestampMs;
}

export function executableVwap(
  levels: readonly PriceLevel[],
  notionalUsd: number,
): VwapResult | null {
  if (!(notionalUsd > 0)) return null;
  let remaining = notionalUsd;
  let baseSize = 0;
  let spent = 0;
  for (const [price, size] of levels) {
    if (!(price > 0) || !(size > 0)) continue;
    const levelNotional = price * size;
    const takeNotional = Math.min(remaining, levelNotional);
    baseSize += takeNotional / price;
    spent += takeNotional;
    remaining -= takeNotional;
    if (remaining <= Math.max(1e-8, notionalUsd * 1e-9)) break;
  }
  if (remaining > Math.max(0.01, notionalUsd * 1e-6) || !(baseSize > 0)) return null;
  return { price: spent / baseSize, baseSize, notionalUsd: spent };
}

export function rawCrossEdgeBps(buyVwap: number, sellVwap: number): number {
  if (!(buyVwap > 0) || !(sellVwap > 0)) return Number.NaN;
  return (sellVwap / buyVwap - 1) * 10_000;
}

/**
 * A converging perp/perp trade pays both venue fees twice: once to open the
 * cheap-long/expensive-short pair and once to close both legs after convergence.
 */
export function roundTripCostBps(
  buyVenueTakerBps: number,
  sellVenueTakerBps: number,
  executionBufferBps: number,
): number {
  return 2 * (buyVenueTakerBps + sellVenueTakerBps) + executionBufferBps;
}

export function netConvergenceEdgeBps(
  rawEdgeBps: number,
  buyVenueTakerBps: number,
  sellVenueTakerBps: number,
  executionBufferBps: number,
): number {
  return rawEdgeBps - roundTripCostBps(
    buyVenueTakerBps,
    sellVenueTakerBps,
    executionBufferBps,
  );
}

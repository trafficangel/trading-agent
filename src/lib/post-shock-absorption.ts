export type AbsorptionPoint = {
  t: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bid5: number;
  ask5: number;
  buyQty: number;
  sellQty: number;
};

export type AbsorptionConfig = {
  sampleMs: number;
  shockSteps: number;
  baselineSteps: number;
  minShockBps: number;
  volatilityMultiplier: number;
  minFlowMultiple: number;
  minAggressorShare: number;
  maxDepletedDepthRatio: number;
  minConfirmSteps: number;
  maxConfirmSteps: number;
  minReclaimFraction: number;
  minDepthRecoveryRatio: number;
  minBookImbalance: number;
  maxExtensionFraction: number;
  maxPostShockFlowRatio: number;
};

export type AbsorptionSignal = {
  shockIndex: number;
  index: number;
  side: 1 | -1;
  preBid: number;
  preAsk: number;
  preMid: number;
  shockMid: number;
  shockBps: number;
  flowMultiple: number;
  aggressorShare: number;
  depletedDepthRatio: number;
  reclaimFraction: number;
  depthRecoveryRatio: number;
  bookImbalance: number;
};

export const POST_SHOCK_ABSORPTION_V1: Readonly<AbsorptionConfig> = Object.freeze({
  sampleMs: 250,
  shockSteps: 8,
  baselineSteps: 240,
  minShockBps: 15,
  volatilityMultiplier: 3,
  minFlowMultiple: 4,
  minAggressorShare: 0.75,
  maxDepletedDepthRatio: 0.8,
  minConfirmSteps: 2,
  maxConfirmSteps: 12,
  minReclaimFraction: 0.3,
  minDepthRecoveryRatio: 0.6,
  minBookImbalance: -0.15,
  maxExtensionFraction: 0.25,
  maxPostShockFlowRatio: 0.6,
});

function midpoint(point: AbsorptionPoint): number {
  return (point.bid + point.ask) / 2;
}

function range(prefix: number[], from: number, to: number): number {
  if (to < from) return 0;
  return prefix[to + 1]! - prefix[from]!;
}

function imbalance(point: AbsorptionPoint): number {
  return point.bid5 + point.ask5 > 0
    ? (point.bid5 - point.ask5) / (point.bid5 + point.ask5)
    : 0;
}

/** Causal event detector. Every signal uses only points at or before signal.index. */
export function detectPostShockAbsorptions(
  points: AbsorptionPoint[],
  config: AbsorptionConfig = POST_SHOCK_ABSORPTION_V1,
): AbsorptionSignal[] {
  if (!points.length) return [];
  const buyPrefix = new Array<number>(points.length + 1).fill(0);
  const sellPrefix = new Array<number>(points.length + 1).fill(0);
  const absReturnPrefix = new Array<number>(points.length + 1).fill(0);
  for (let i = 0; i < points.length; i++) {
    buyPrefix[i + 1] = buyPrefix[i]! + Math.max(0, points[i]!.buyQty);
    sellPrefix[i + 1] = sellPrefix[i]! + Math.max(0, points[i]!.sellQty);
    const previous = i > 0 ? midpoint(points[i - 1]!) : midpoint(points[i]!);
    const current = midpoint(points[i]!);
    absReturnPrefix[i + 1] = absReturnPrefix[i]! + Math.abs(current / previous - 1) * 10_000;
  }

  const signals: AbsorptionSignal[] = [];
  const warmup = config.baselineSteps + config.shockSteps;
  for (let shockIndex = warmup; shockIndex < points.length - config.minConfirmSteps; shockIndex++) {
    const baselineFrom = shockIndex - config.shockSteps - config.baselineSteps + 1;
    const baselineTo = shockIndex - config.shockSteps;
    const shockFrom = shockIndex - config.shockSteps;
    const oldest = points[baselineFrom]!;
    const shockPoint = points[shockIndex]!;
    const expectedSpan = (config.baselineSteps + config.shockSteps + 2) * config.sampleMs;
    if (shockPoint.t - oldest.t > expectedSpan) continue;

    const prePoint = points[shockFrom]!;
    const preMid = midpoint(prePoint);
    const shockMid = midpoint(shockPoint);
    const moveBps = (shockMid / preMid - 1) * 10_000;
    const baselineAbsReturn = range(absReturnPrefix, baselineFrom, baselineTo) / config.baselineSteps;
    const dynamicThreshold = config.volatilityMultiplier * baselineAbsReturn * Math.sqrt(config.shockSteps);
    if (Math.abs(moveBps) < Math.max(config.minShockBps, dynamicThreshold)) continue;
    const side: 1 | -1 = moveBps < 0 ? 1 : -1;

    const shockBuy = range(buyPrefix, shockFrom + 1, shockIndex);
    const shockSell = range(sellPrefix, shockFrom + 1, shockIndex);
    const shockFlow = shockBuy + shockSell;
    const baselineFlow = range(buyPrefix, baselineFrom, baselineTo)
      + range(sellPrefix, baselineFrom, baselineTo);
    const expectedShockFlow = baselineFlow / config.baselineSteps * config.shockSteps;
    if (!(expectedShockFlow > 0) || shockFlow < config.minFlowMultiple * expectedShockFlow) continue;
    const flowMultiple = shockFlow / expectedShockFlow;
    const alignedAggressor = side === 1 ? shockSell : shockBuy;
    const aggressorShare = shockFlow > 0 ? alignedAggressor / shockFlow : 0;
    if (aggressorShare < config.minAggressorShare) continue;

    const preDepth = side === 1 ? points[shockFrom]!.bid5 : points[shockFrom]!.ask5;
    const shockDepth = side === 1 ? shockPoint.bid5 : shockPoint.ask5;
    if (!(preDepth > 0)) continue;
    const depletedDepthRatio = shockDepth / preDepth;
    if (depletedDepthRatio > config.maxDepletedDepthRatio) continue;

    const shockDistance = Math.abs(preMid - shockMid);
    let found: AbsorptionSignal | null = null;
    for (let index = shockIndex + 1; index <= Math.min(points.length - 1, shockIndex + config.maxConfirmSteps); index++) {
      const point = points[index]!;
      if (point.t - shockPoint.t > (index - shockIndex + 1) * config.sampleMs) break;
      const currentMid = midpoint(point);
      const extension = side === 1 ? shockMid - currentMid : currentMid - shockMid;
      if (extension > config.maxExtensionFraction * shockDistance) break;
      if (index - shockIndex < config.minConfirmSteps) continue;

      const reclaim = side === 1 ? currentMid - shockMid : shockMid - currentMid;
      const reclaimFraction = shockDistance > 0 ? reclaim / shockDistance : 0;
      if (reclaimFraction < config.minReclaimFraction) continue;
      const currentDepth = side === 1 ? point.bid5 : point.ask5;
      const depthRecoveryRatio = currentDepth / preDepth;
      if (depthRecoveryRatio < config.minDepthRecoveryRatio) continue;
      const bookImbalance = imbalance(point);
      if (side * bookImbalance < config.minBookImbalance) continue;

      const postBuy = range(buyPrefix, shockIndex + 1, index);
      const postSell = range(sellPrefix, shockIndex + 1, index);
      const postAligned = side === 1 ? postSell : postBuy;
      const shockAlignedPerStep = alignedAggressor / config.shockSteps;
      const postAlignedPerStep = postAligned / (index - shockIndex);
      if (shockAlignedPerStep > 0 && postAlignedPerStep / shockAlignedPerStep > config.maxPostShockFlowRatio) continue;

      found = {
        shockIndex,
        index,
        side,
        preBid: prePoint.bid,
        preAsk: prePoint.ask,
        preMid,
        shockMid,
        shockBps: Math.abs(moveBps),
        flowMultiple,
        aggressorShare,
        depletedDepthRatio,
        reclaimFraction,
        depthRecoveryRatio,
        bookImbalance,
      };
      break;
    }
    if (found) {
      signals.push(found);
      shockIndex += config.maxConfirmSteps;
    }
  }
  return signals;
}

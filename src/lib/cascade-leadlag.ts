export type CascadePoint = {
  t: number;
  bid: number;
  ask: number;
  bid5: number;
  ask5: number;
  binanceBid: number;
  binanceAsk: number;
  bybitBid: number;
  bybitAsk: number;
  buyQty: number;
  sellQty: number;
};

export type CascadeConfig = {
  sampleMs: number;
  shockSteps: number;
  baselineSteps: number;
  betaSteps: number;
  minLeaderMoveBps: number;
  minLeaderFlowMultiple: number;
  minLeaderAggressorShare: number;
  minBeta: number;
  maxBeta: number;
  minExpectedMoveBps: number;
  maxLaggerCompletion: number;
  maxLaggerSpreadBps: number;
  minBookImbalance: number;
  cooldownSteps: number;
};

export type CascadeSignal = {
  index: number;
  leader: string;
  lagger: string;
  side: 1 | -1;
  leaderMoveBps: number;
  laggerMoveBps: number;
  beta: number;
  expectedMoveBps: number;
  completion: number;
  flowMultiple: number;
  aggressorShare: number;
  preMid: number;
  signalMid: number;
  bookImbalance: number;
};

export type CascadeExecutionConfig = {
  sampleMs: number;
  maxHoldSteps: number;
  targetFraction: number;
  stopFraction: number;
  takerFeeBps: number;
  minRemainingEdgeBps: number;
};

export type CascadeExecutionProfile = {
  latencySteps: number;
  extraCostBps: number;
};

export type CascadeExecution = {
  entryIndex: number;
  exitIndex: number;
  side: 1 | -1;
  netBps: number;
  reason: 'target-taker' | 'stop-taker' | 'time-taker';
};

export const CASCADE_LEADLAG_V1: Readonly<CascadeConfig> = Object.freeze({
  sampleMs: 250,
  shockSteps: 16,
  baselineSteps: 240,
  betaSteps: 1_800,
  minLeaderMoveBps: 18,
  minLeaderFlowMultiple: 3,
  minLeaderAggressorShare: 0.7,
  minBeta: 0.2,
  maxBeta: 2.5,
  minExpectedMoveBps: 14,
  maxLaggerCompletion: 0.45,
  maxLaggerSpreadBps: 6,
  minBookImbalance: -0.2,
  cooldownSteps: 80,
});

export const CASCADE_EXECUTION_V1: Readonly<CascadeExecutionConfig> = Object.freeze({
  sampleMs: 250,
  maxHoldSteps: 480,
  targetFraction: 0.7,
  stopFraction: 0.55,
  takerFeeBps: 5.5,
  minRemainingEdgeBps: 16,
});

function bybitMid(point: CascadePoint): number {
  return (point.bybitBid + point.bybitAsk) / 2;
}

function cexMid(point: CascadePoint): number {
  return ((point.binanceBid + point.binanceAsk) / 2 + bybitMid(point)) / 2;
}

function spreadBps(point: CascadePoint): number {
  const mid = bybitMid(point);
  return mid > 0 ? ((point.bybitAsk - point.bybitBid) / mid) * 10_000 : Number.POSITIVE_INFINITY;
}

function imbalance(point: CascadePoint): number {
  return point.bid5 + point.ask5 > 0 ? (point.bid5 - point.ask5) / (point.bid5 + point.ask5) : 0;
}

function range(prefix: number[], from: number, to: number): number {
  if (to < from) return 0;
  return prefix[to + 1]! - prefix[from]!;
}

function betaAt(leader: CascadePoint[], lagger: CascadePoint[], index: number, config: CascadeConfig): number {
  const from = Math.max(config.shockSteps + 1, index - config.betaSteps);
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = from; i < index; i += config.shockSteps) {
    const leaderPrev = cexMid(leader[i - config.shockSteps]!);
    const laggerPrev = bybitMid(lagger[i - config.shockSteps]!);
    const x = (cexMid(leader[i]!) / leaderPrev - 1) * 10_000;
    const y = (bybitMid(lagger[i]!) / laggerPrev - 1) * 10_000;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  if (n < 30) return 0;
  const cov = sxy - (sx * sy) / n;
  const variance = sxx - (sx * sx) / n;
  return variance > 0 ? cov / variance : 0;
}

export function detectCascadeLeadLagSignals(
  leaderName: string,
  laggerName: string,
  leader: CascadePoint[],
  lagger: CascadePoint[],
  config: CascadeConfig = CASCADE_LEADLAG_V1,
): CascadeSignal[] {
  const count = Math.min(leader.length, lagger.length);
  if (count < config.betaSteps + config.shockSteps + 2) return [];
  const buyPrefix = new Array<number>(count + 1).fill(0);
  const sellPrefix = new Array<number>(count + 1).fill(0);
  for (let i = 0; i < count; i++) {
    buyPrefix[i + 1] = buyPrefix[i]! + Math.max(0, leader[i]!.buyQty);
    sellPrefix[i + 1] = sellPrefix[i]! + Math.max(0, leader[i]!.sellQty);
  }

  const signals: CascadeSignal[] = [];
  const warmup = Math.max(config.betaSteps, config.baselineSteps) + config.shockSteps;
  for (let index = warmup; index < count - 2; index++) {
    const preIndex = index - config.shockSteps;
    const oldest = leader[index - config.baselineSteps - config.shockSteps]!;
    if (leader[index]!.t - oldest.t > (config.baselineSteps + config.shockSteps + 2) * config.sampleMs) continue;
    if (leader[index]!.t !== lagger[index]!.t || leader[preIndex]!.t !== lagger[preIndex]!.t) continue;

    const leaderPre = cexMid(leader[preIndex]!);
    const leaderNow = cexMid(leader[index]!);
    const leaderMoveBps = (leaderNow / leaderPre - 1) * 10_000;
    if (Math.abs(leaderMoveBps) < config.minLeaderMoveBps) continue;
    const side: 1 | -1 = leaderMoveBps > 0 ? 1 : -1;

    const shockBuy = range(buyPrefix, preIndex + 1, index);
    const shockSell = range(sellPrefix, preIndex + 1, index);
    const shockFlow = shockBuy + shockSell;
    const baselineFrom = index - config.shockSteps - config.baselineSteps + 1;
    const baselineTo = index - config.shockSteps;
    const baselineFlow = range(buyPrefix, baselineFrom, baselineTo)
      + range(sellPrefix, baselineFrom, baselineTo);
    const expectedFlow = baselineFlow / config.baselineSteps * config.shockSteps;
    if (!(expectedFlow > 0) || shockFlow < config.minLeaderFlowMultiple * expectedFlow) continue;
    const aggressor = side === 1 ? shockBuy : shockSell;
    const aggressorShare = shockFlow > 0 ? aggressor / shockFlow : 0;
    if (aggressorShare < config.minLeaderAggressorShare) continue;

    const beta = betaAt(leader, lagger, index, config);
    if (beta < config.minBeta || beta > config.maxBeta) continue;
    const expectedMoveBps = beta * leaderMoveBps;
    if (side * expectedMoveBps < config.minExpectedMoveBps) continue;

    const laggerPre = bybitMid(lagger[preIndex]!);
    const laggerNow = bybitMid(lagger[index]!);
    const laggerMoveBps = (laggerNow / laggerPre - 1) * 10_000;
    const completion = (side * laggerMoveBps) / Math.abs(expectedMoveBps);
    if (completion >= config.maxLaggerCompletion) continue;
    if (spreadBps(lagger[index]!) > config.maxLaggerSpreadBps) continue;
    const bookImbalance = imbalance(lagger[index]!);
    if (side * bookImbalance < config.minBookImbalance) continue;

    signals.push({
      index,
      leader: leaderName,
      lagger: laggerName,
      side,
      leaderMoveBps,
      laggerMoveBps,
      beta,
      expectedMoveBps,
      completion,
      flowMultiple: shockFlow / expectedFlow,
      aggressorShare,
      preMid: laggerPre,
      signalMid: laggerNow,
      bookImbalance,
    });
    index += config.cooldownSteps;
  }
  return signals;
}

function contiguousEnd(points: CascadePoint[], from: number, maxSteps: number, sampleMs: number): number {
  let end = from;
  for (let index = from + 1; index <= Math.min(points.length - 1, from + maxSteps); index++) {
    if (points[index]!.t - points[index - 1]!.t > 2 * sampleMs) break;
    end = index;
  }
  return end;
}

export function executeCascadeSignal(
  points: CascadePoint[],
  signal: CascadeSignal,
  profile: CascadeExecutionProfile,
  config: CascadeExecutionConfig = CASCADE_EXECUTION_V1,
): CascadeExecution | null {
  const entryIndex = signal.index + profile.latencySteps;
  if (entryIndex >= points.length) return null;
  if (points[entryIndex]!.t - points[signal.index]!.t > (profile.latencySteps + 1) * config.sampleMs) return null;
  const entry = points[entryIndex]!;
  const entryPrice = signal.side === 1 ? entry.bybitAsk : entry.bybitBid;
  const target = signal.preMid * (1 + signal.side * Math.abs(signal.expectedMoveBps) * config.targetFraction / 10_000);
  const remainingEdgeBps = signal.side * (target / entryPrice - 1) * 10_000;
  if (remainingEdgeBps < config.minRemainingEdgeBps) return null;
  const stop = entryPrice * (1 - signal.side * Math.abs(signal.expectedMoveBps) * config.stopFraction / 10_000);
  const searchEnd = contiguousEnd(points, entryIndex, config.maxHoldSteps + profile.latencySteps, config.sampleMs);
  const triggerEnd = Math.min(searchEnd, entryIndex + config.maxHoldSteps);

  let triggerIndex = triggerEnd;
  let reason: CascadeExecution['reason'] = 'time-taker';
  for (let index = entryIndex + 1; index <= triggerEnd; index++) {
    const point = points[index]!;
    const targetHit = signal.side === 1 ? point.bybitBid >= target : point.bybitAsk <= target;
    const stopHit = signal.side === 1 ? point.bybitBid <= stop : point.bybitAsk >= stop;
    if (stopHit) {
      triggerIndex = index;
      reason = 'stop-taker';
      break;
    }
    if (targetHit) {
      triggerIndex = index;
      reason = 'target-taker';
      break;
    }
  }

  const exitIndex = triggerIndex + profile.latencySteps;
  if (exitIndex > searchEnd) return null;
  const exit = points[exitIndex]!;
  const exitPrice = signal.side === 1 ? exit.bybitBid : exit.bybitAsk;
  const grossBps = signal.side * (exitPrice / entryPrice - 1) * 10_000;
  return {
    entryIndex,
    exitIndex,
    side: signal.side,
    netBps: grossBps - 2 * config.takerFeeBps - profile.extraCostBps,
    reason,
  };
}

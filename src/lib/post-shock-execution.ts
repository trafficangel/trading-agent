import { makerFillIndex, type MakerPrintPoint } from './hft-maker-fill.js';
import type { AbsorptionPoint, AbsorptionSignal } from './post-shock-absorption.js';

export type PostShockReplayPoint = AbsorptionPoint & MakerPrintPoint;
export type PostShockExecutionProfile = {
  latencySteps: number;
  queueMultiplier: number;
  extraCostBps: number;
};
export type PostShockExecutionConfig = {
  sampleMs: number;
  entryTtlSteps: number;
  maxHoldSteps: number;
  stopExtensionFraction: number;
  makerFeeBps: number;
  takerFeeBps: number;
};
export type PostShockExecution = {
  fillIndex: number;
  exitIndex: number;
  side: 1 | -1;
  netBps: number;
  reason: 'target-maker' | 'target-taker' | 'stop-taker' | 'time-taker';
};

export const POST_SHOCK_EXECUTION_V1: Readonly<PostShockExecutionConfig> = Object.freeze({
  sampleMs: 250,
  entryTtlSteps: 8,
  maxHoldSteps: 80,
  stopExtensionFraction: 0.5,
  makerFeeBps: 2,
  takerFeeBps: 5.5,
});

function midpoint(point: PostShockReplayPoint): number {
  return (point.bid + point.ask) / 2;
}

function contiguousEnd(
  points: PostShockReplayPoint[],
  from: number,
  maxSteps: number,
  sampleMs: number,
): number {
  let end = from;
  for (let index = from + 1; index <= Math.min(points.length - 1, from + maxSteps); index++) {
    if (points[index]!.t - points[index - 1]!.t > 2 * sampleMs) break;
    end = index;
  }
  return end;
}

export function executePostShockSignal(
  points: PostShockReplayPoint[],
  signal: AbsorptionSignal,
  profile: PostShockExecutionProfile,
  config: PostShockExecutionConfig = POST_SHOCK_EXECUTION_V1,
): PostShockExecution | null {
  const submitIndex = signal.index + profile.latencySteps;
  if (submitIndex + 1 >= points.length) return null;
  if (points[submitIndex]!.t - points[signal.index]!.t > (profile.latencySteps + 1) * config.sampleMs) return null;
  const submit = points[submitIndex]!;
  const quote = signal.side === 1 ? submit.bid : submit.ask;
  const queue = (signal.side === 1 ? submit.bidSize : submit.askSize) * profile.queueMultiplier;
  const entryLastIndex = contiguousEnd(points, submitIndex, config.entryTtlSteps, config.sampleMs);
  const fillIndex = makerFillIndex(points, submitIndex + 1, entryLastIndex, signal.side, quote, queue);
  if (fillIndex < 0) return null;

  const shockDistance = Math.abs(signal.preMid - signal.shockMid);
  const stop = signal.side === 1
    ? signal.shockMid - config.stopExtensionFraction * shockDistance
    : signal.shockMid + config.stopExtensionFraction * shockDistance;
  const maxContiguousIndex = contiguousEnd(
    points,
    fillIndex,
    config.maxHoldSteps + profile.latencySteps,
    config.sampleMs,
  );
  if (maxContiguousIndex === fillIndex) return null;
  const holdIndex = fillIndex + config.maxHoldSteps;
  const targetSearchEnd = Math.min(holdIndex, maxContiguousIndex);
  const target = signal.side === 1 ? signal.preAsk : signal.preBid;
  const targetSide: 1 | -1 = signal.side === 1 ? -1 : 1;
  const targetIndex = makerFillIndex(
    points,
    fillIndex + 1,
    targetSearchEnd,
    targetSide,
    target,
    Number.POSITIVE_INFINITY,
  );

  let takerTriggerIndex: number | null = null;
  let reason: PostShockExecution['reason'] = 'time-taker';
  for (let index = fillIndex + 1; index <= targetSearchEnd; index++) {
    const point = points[index]!;
    const mid = midpoint(point);
    const stopped = signal.side === 1 ? mid <= stop : mid >= stop;
    if (stopped) {
      takerTriggerIndex = index;
      reason = 'stop-taker';
      break;
    }
    const targetCrossed = signal.side === 1 ? point.bid >= target : point.ask <= target;
    if (targetCrossed) {
      takerTriggerIndex = index;
      reason = 'target-taker';
      break;
    }
    if (targetIndex === index) {
      const grossBps = signal.side * (target / quote - 1) * 10_000;
      return {
        fillIndex,
        exitIndex: index,
        side: signal.side,
        netBps: grossBps - 2 * config.makerFeeBps - profile.extraCostBps,
        reason: 'target-maker',
      };
    }
  }
  if (takerTriggerIndex == null) {
    if (maxContiguousIndex < holdIndex + profile.latencySteps) return null;
    takerTriggerIndex = holdIndex;
  }
  const exitIndex = takerTriggerIndex + profile.latencySteps;
  if (exitIndex > maxContiguousIndex) return null;
  const exitPoint = points[exitIndex]!;
  const exitPrice = signal.side === 1 ? exitPoint.bid : exitPoint.ask;
  const grossBps = signal.side * (exitPrice / quote - 1) * 10_000;
  return {
    fillIndex,
    exitIndex,
    side: signal.side,
    netBps: grossBps - config.makerFeeBps - config.takerFeeBps - profile.extraCostBps,
    reason,
  };
}

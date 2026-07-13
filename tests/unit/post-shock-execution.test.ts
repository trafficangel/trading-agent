import { describe, expect, it } from 'vitest';
import {
  executePostShockSignal,
  type PostShockExecutionConfig,
  type PostShockReplayPoint,
} from '../../src/lib/post-shock-execution.js';
import type { AbsorptionSignal } from '../../src/lib/post-shock-absorption.js';

const CONFIG: PostShockExecutionConfig = {
  sampleMs: 250,
  entryTtlSteps: 3,
  maxHoldSteps: 5,
  stopExtensionFraction: 0.5,
  makerFeeBps: 2,
  takerFeeBps: 5.5,
};
const PROFILE = { latencySteps: 1, queueMultiplier: 1, extraCostBps: 0 };

function point(index: number, bid: number, ask: number, prints: number[] = []): PostShockReplayPoint {
  return {
    t: index * 250,
    bid,
    ask,
    bidSize: 2,
    askSize: 2,
    bid5: 10,
    ask5: 10,
    buyQty: 0,
    sellQty: 0,
    hlPrints: prints,
  };
}

const SIGNAL: AbsorptionSignal = {
  shockIndex: 1,
  index: 2,
  side: 1,
  preBid: 99.99,
  preAsk: 100.01,
  preMid: 100,
  shockMid: 99.8,
  shockBps: 20,
  flowMultiple: 5,
  aggressorShare: 0.8,
  depletedDepthRatio: 0.5,
  reclaimFraction: 0.3,
  depthRecoveryRatio: 0.7,
  bookImbalance: 0.1,
};

describe('post-shock execution replay', () => {
  it('requires queue consumption, then books a strict-through maker target', () => {
    const points = [
      point(0, 99.99, 100.01), point(1, 99.79, 99.81), point(2, 99.84, 99.86),
      point(3, 99.85, 99.87), point(4, 99.85, 99.87, [99.85, -2.1]),
      point(5, 99.9, 99.92), point(6, 100, 100.02, [100.02, 1]),
    ];
    const result = executePostShockSignal(points, SIGNAL, PROFILE, CONFIG);
    expect(result).toMatchObject({ fillIndex: 4, exitIndex: 6, reason: 'target-maker' });
    expect(result!.netBps).toBeGreaterThan(10);
  });

  it('does not fabricate an entry when displayed queue remains ahead', () => {
    const points = [
      point(0, 99.99, 100.01), point(1, 99.79, 99.81), point(2, 99.84, 99.86),
      point(3, 99.85, 99.87), point(4, 99.85, 99.87, [99.85, -1]),
      point(5, 99.86, 99.88), point(6, 99.87, 99.89),
    ];
    expect(executePostShockSignal(points, SIGNAL, PROFILE, CONFIG)).toBeNull();
  });

  it('prioritizes a protective stop over a favorable print in the same bucket', () => {
    const points = [
      point(0, 99.99, 100.01), point(1, 99.79, 99.81), point(2, 99.84, 99.86),
      point(3, 99.85, 99.87), point(4, 99.85, 99.87, [99.84, -0.1]),
      point(5, 99.68, 99.7, [100.02, 1]), point(6, 99.7, 99.72),
    ];
    const result = executePostShockSignal(points, SIGNAL, PROFILE, CONFIG);
    expect(result).toMatchObject({ reason: 'stop-taker', exitIndex: 6 });
  });

  it('does not carry an order across a data gap', () => {
    const points = [
      point(0, 99.99, 100.01), point(1, 99.79, 99.81), point(2, 99.84, 99.86),
      point(3, 99.85, 99.87), point(4, 99.85, 99.87),
    ];
    points[4] = { ...points[4]!, t: 10_000, hlPrints: [99.84, -10] };
    expect(executePostShockSignal(points, SIGNAL, PROFILE, CONFIG)).toBeNull();
  });

  it('discards a filled trade when its time-stop horizon is truncated', () => {
    const points = [
      point(0, 99.99, 100.01), point(1, 99.79, 99.81), point(2, 99.84, 99.86),
      point(3, 99.85, 99.87), point(4, 99.85, 99.87, [99.84, -0.1]),
      point(5, 99.86, 99.88),
    ];
    expect(executePostShockSignal(points, SIGNAL, PROFILE, CONFIG)).toBeNull();
  });
});

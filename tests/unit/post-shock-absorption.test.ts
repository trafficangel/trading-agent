import { describe, expect, it } from 'vitest';
import {
  detectPostShockAbsorptions,
  type AbsorptionConfig,
  type AbsorptionPoint,
} from '../../src/lib/post-shock-absorption.js';

const CFG: AbsorptionConfig = {
  sampleMs: 250,
  shockSteps: 4,
  baselineSteps: 12,
  minShockBps: 10,
  volatilityMultiplier: 2,
  minFlowMultiple: 3,
  minAggressorShare: 0.75,
  maxDepletedDepthRatio: 0.8,
  minConfirmSteps: 2,
  maxConfirmSteps: 5,
  minReclaimFraction: 0.3,
  minDepthRecoveryRatio: 0.6,
  minBookImbalance: -0.2,
  maxExtensionFraction: 0.25,
  maxPostShockFlowRatio: 0.6,
};

function point(index: number, mid: number, overrides: Partial<AbsorptionPoint> = {}): AbsorptionPoint {
  return {
    t: index * 250,
    bid: mid - 0.01,
    ask: mid + 0.01,
    bidSize: 10,
    askSize: 10,
    bid5: 100,
    ask5: 100,
    buyQty: 1,
    sellQty: 1,
    ...overrides,
  };
}

function absorbedFlush(): AbsorptionPoint[] {
  const points = Array.from({ length: 17 }, (_, i) => point(i, 100));
  points.push(point(17, 99.96, { buyQty: 1, sellQty: 8, bid5: 70 }));
  points.push(point(18, 99.92, { buyQty: 1, sellQty: 8, bid5: 65 }));
  points.push(point(19, 99.88, { buyQty: 1, sellQty: 8, bid5: 55 }));
  points.push(point(20, 99.84, { buyQty: 1, sellQty: 8, bid5: 50 }));
  points.push(point(21, 99.86, { buyQty: 1, sellQty: 1, bid5: 55 }));
  points.push(point(22, 99.90, { buyQty: 2, sellQty: 1, bid5: 70 }));
  return points;
}

describe('post-shock absorption detector', () => {
  it('waits for reclaim and depth recovery before emitting a long', () => {
    const signals = detectPostShockAbsorptions(absorbedFlush(), CFG);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 1, shockIndex: 20, index: 22 });
    expect(signals[0]!.shockBps).toBeGreaterThan(10);
    expect(signals[0]!.flowMultiple).toBeGreaterThan(3);
  });

  it('mirrors the mechanism for an absorbed upward shock', () => {
    const points = Array.from({ length: 17 }, (_, i) => point(i, 100));
    points.push(point(17, 100.04, { buyQty: 8, sellQty: 1, ask5: 70 }));
    points.push(point(18, 100.08, { buyQty: 8, sellQty: 1, ask5: 65 }));
    points.push(point(19, 100.12, { buyQty: 8, sellQty: 1, ask5: 55 }));
    points.push(point(20, 100.16, { buyQty: 8, sellQty: 1, ask5: 50 }));
    points.push(point(21, 100.14, { buyQty: 1, sellQty: 1, ask5: 55 }));
    points.push(point(22, 100.10, { buyQty: 1, sellQty: 2, bid5: 70, ask5: 70 }));
    expect(detectPostShockAbsorptions(points, CFG)[0]).toMatchObject({ side: -1, shockIndex: 20, index: 22 });
  });

  it('rejects a shock that keeps extending instead of being absorbed', () => {
    const points = absorbedFlush();
    points[21] = point(21, 99.78, { buyQty: 1, sellQty: 5, bid5: 45 });
    points[22] = point(22, 99.76, { buyQty: 1, sellQty: 5, bid5: 40 });
    expect(detectPostShockAbsorptions(points, CFG)).toEqual([]);
  });

  it('does not emit on an ordinary move without exceptional flow', () => {
    const points = absorbedFlush().map((p) => ({ ...p, buyQty: 1, sellQty: 1 }));
    expect(detectPostShockAbsorptions(points, CFG)).toEqual([]);
  });

  it('is causal: later prices do not alter an already confirmed signal', () => {
    const points = absorbedFlush();
    const before = detectPostShockAbsorptions(points, CFG)[0];
    const after = detectPostShockAbsorptions([...points, point(23, 95), point(24, 105)], CFG)[0];
    expect(after).toEqual(before);
  });
});

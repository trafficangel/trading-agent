import { describe, expect, it } from 'vitest';
import {
  CASCADE_EXECUTION_V1,
  CASCADE_LEADLAG_V1,
  detectCascadeLeadLagSignals,
  executeCascadeSignal,
  type CascadePoint,
} from '../../src/lib/cascade-leadlag.js';

function point(t: number, mid: number, buyQty = 1, sellQty = 1): CascadePoint {
  return {
    t,
    bid: mid - 0.01,
    ask: mid + 0.01,
    bid5: 1_000,
    ask5: 1_000,
    binanceBid: mid - 0.01,
    binanceAsk: mid + 0.01,
    bybitBid: mid - 0.01,
    bybitAsk: mid + 0.01,
    buyQty,
    sellQty,
  };
}

function series(length: number): CascadePoint[] {
  return Array.from({ length }, (_, i) => point(i * 250, 100 + i * 0.001));
}

describe('cascade lead-lag detector', () => {
  it('detects a leader shock while the lagger is still incomplete', () => {
    const leader = series(2_200);
    const lagger = series(2_200);
    for (let i = 20; i < leader.length; i++) {
      const drift = i * 0.001;
      leader[i] = point(i * 250, 100 + drift);
      lagger[i] = point(i * 250, 100 + drift * 0.8);
    }
    for (let i = 2_000; i < 2_017; i++) {
      leader[i] = point(i * 250, 100 + 0.001 * i + (i - 1_999) * 0.14, 40, 1);
      lagger[i] = point(i * 250, 100 + 0.001 * i + (i - 1_999) * 0.02, 2, 1);
    }

    const signals = detectCascadeLeadLagSignals('BTC', 'JUP', leader, lagger, {
      ...CASCADE_LEADLAG_V1,
      betaSteps: 600,
      minExpectedMoveBps: 8,
    });

    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]).toMatchObject({ leader: 'BTC', lagger: 'JUP', side: 1 });
    expect(signals[0]!.completion).toBeLessThan(0.45);
  });

  it('rejects a lagger that already completed the beta move', () => {
    const leader = series(2_200);
    const lagger = series(2_200);
    for (let i = 20; i < leader.length; i++) {
      leader[i] = point(i * 250, 100 + i * 0.001);
      lagger[i] = point(i * 250, 100 + i * 0.001);
    }
    for (let i = 2_000; i < 2_017; i++) {
      const shock = (i - 1_999) * 0.14;
      leader[i] = point(i * 250, 100 + 0.001 * i + shock, 40, 1);
      lagger[i] = point(i * 250, 100 + 0.001 * i + shock, 20, 1);
    }

    const signals = detectCascadeLeadLagSignals('BTC', 'JUP', leader, lagger, {
      ...CASCADE_LEADLAG_V1,
      betaSteps: 600,
      minExpectedMoveBps: 8,
    });

    expect(signals).toHaveLength(0);
  });
});

describe('cascade execution replay', () => {
  it('enters after latency and exits at the catch-up target net of taker fees', () => {
    const points = series(120);
    const signal = {
      index: 10,
      leader: 'BTC',
      lagger: 'JUP',
      side: 1 as const,
      leaderMoveBps: 30,
      laggerMoveBps: 5,
      beta: 1,
      expectedMoveBps: 30,
      completion: 0.16,
      flowMultiple: 4,
      aggressorShare: 0.8,
      preMid: 100,
      signalMid: 100.05,
      bookImbalance: 0,
    };
    for (let i = 12; i < points.length; i++) points[i] = point(i * 250, 100.05 + (i - 12) * 0.02);

    const result = executeCascadeSignal(points, signal, { latencySteps: 2, extraCostBps: 0 }, {
      ...CASCADE_EXECUTION_V1,
      minRemainingEdgeBps: 1,
      maxHoldSteps: 60,
    });

    expect(result).toMatchObject({ entryIndex: 12, reason: 'target-taker' });
    expect(result!.netBps).toBeGreaterThan(0);
  });
});

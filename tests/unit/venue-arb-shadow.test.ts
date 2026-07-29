import { describe, expect, it } from 'vitest';
import {
  conservativeLatencyMs,
  independentSignalRows,
  shadowLossGuardReached,
  shadowNetAfterCosts,
  shadowReadiness,
  wilsonLowerBound,
} from '../../src/lib/venue-arb-shadow.js';

describe('venue arb execution shadow', () => {
  it('reproduces the BNB canary loss after fills and all costs', () => {
    const result = shadowNetAfterCosts({
      notionalUsd: 297.7,
      quantity: 0.52,
      entryExtended: 572.5,
      entryLighter: 573.0972,
      exitExtended: 572.46,
      exitLighter: 573.2286461538461,
      extendedTakerBps: 2.5,
      lighterTakerBps: 0,
      executionBufferBps: 0,
      fundingBps: 0,
    });
    expect(result.netUsd).toBeCloseTo(-0.2379968, 7);
    expect(result.netBps).toBeCloseTo(-7.994518, 5);
  });

  it('subtracts fees, execution buffer and funding from convergence capture', () => {
    const result = shadowNetAfterCosts({
      notionalUsd: 500,
      quantity: 1,
      entryExtended: 100,
      entryLighter: 100.20,
      exitExtended: 100.10,
      exitLighter: 100.10,
      extendedTakerBps: 2.5,
      lighterTakerBps: 0,
      executionBufferBps: 2,
      fundingBps: 0.25,
    });
    expect(result.grossUsd).toBeCloseTo(0.20, 8);
    expect(result.feesUsd).toBeCloseTo(0.050025, 8);
    expect(result.executionBufferUsd).toBeCloseTo(0.10, 8);
    expect(result.fundingUsd).toBeCloseTo(0.0125, 8);
    expect(result.netUsd).toBeCloseTo(0.037475, 8);
  });

  it('matches the protected real-canary loss gate', () => {
    expect(shadowLossGuardReached({
      projectedNetBps: -5,
      maxLossBps: 5,
      holdingMs: 200,
      minHoldMs: 200,
    })).toBe(true);
    expect(shadowLossGuardReached({
      projectedNetBps: -4.99,
      maxLossBps: 5,
      holdingMs: 200,
      minHoldMs: 200,
    })).toBe(false);
    expect(shadowLossGuardReached({
      projectedNetBps: -8,
      maxLossBps: 5,
      holdingMs: 199,
      minHoldMs: 200,
    })).toBe(false);
    expect(shadowLossGuardReached({
      projectedNetBps: -8,
      maxLossBps: 0,
      holdingMs: 1_000,
      minHoldMs: 200,
    })).toBe(false);
  });

  it('requires both the protected exit and positive delayed result', () => {
    const passing = Array.from({ length: 45 }, () => ({
      entryEdgeConfirmed: true,
      reachedExitGuard: true,
      realizedNetBps: 3,
      reason: 'protected_exit',
    }));
    const executionFailures = Array.from({ length: 5 }, () => ({
      entryEdgeConfirmed: true,
      reachedExitGuard: false,
      realizedNetBps: -1,
      reason: 'max_hold',
    }));
    const rejectedSignals = Array.from({ length: 5 }, () => ({
      entryEdgeConfirmed: false,
      reachedExitGuard: false,
      realizedNetBps: null,
      reason: 'edge_lost_before_entry',
    }));
    expect(shadowReadiness([
      ...passing,
      ...executionFailures,
      ...rejectedSignals,
    ], 50, 90)).toMatchObject({
      attempts: 55,
      samples: 50,
      entryEdgeConfirmed: 50,
      passed: 45,
      passedPct: 90,
      ready: true,
      reasons: {
        protected_exit: 45,
        max_hold: 5,
        edge_lost_before_entry: 5,
      },
    });
    const sixFailures = Array.from({ length: 6 }, () => ({
      entryEdgeConfirmed: true,
      reachedExitGuard: false,
      realizedNetBps: -1,
      reason: 'max_hold',
    }));
    expect(shadowReadiness([
      ...passing.slice(0, 44),
      ...sixFailures,
      ...rejectedSignals,
    ], 50, 90)).toMatchObject({
      attempts: 55,
      samples: 50,
      passed: 44,
      passedPct: 88,
      ready: false,
    });
  });

  it('uses measured p90 latency with a conservative floor', () => {
    expect(conservativeLatencyMs([1009], 1_000)).toBe(1_009);
    expect(conservativeLatencyMs([100, 200, 300, 4_000], 1_000)).toBe(4_000);
    expect(conservativeLatencyMs([], 2_200)).toBe(2_200);
  });

  it('never passes a result without three-snapshot entry confirmation', () => {
    expect(shadowReadiness([{
      entryEdgeConfirmed: false,
      reachedExitGuard: true,
      realizedNetBps: 12,
      reason: 'protected_exit',
    }], 1, 100)).toMatchObject({
      entryEdgeConfirmed: 0,
      passed: 0,
      ready: false,
    });
  });

  it('counts clustered crossings once per route and coin', () => {
    const rows = [
      { key: 'bybit→binance:HYPE', at: 1_000 },
      { key: 'bybit→binance:HYPE', at: 12_000 },
      { key: 'bybit→binance:ETH', at: 15_000 },
      { key: 'bybit→binance:HYPE', at: 61_000 },
    ];
    expect(independentSignalRows(
      rows,
      60_000,
      (row) => row.key,
      (row) => row.at,
    )).toEqual([rows[0], rows[2], rows[3]]);
  });

  it('ranks persistence by conservative confidence, not raw attempt count', () => {
    expect(wilsonLowerBound(5, 6)).toBeGreaterThan(wilsonLowerBound(2, 2));
    expect(wilsonLowerBound(2, 2)).toBeGreaterThan(wilsonLowerBound(2, 4));
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

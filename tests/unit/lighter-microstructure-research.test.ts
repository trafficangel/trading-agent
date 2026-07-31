import { describe, expect, it } from 'vitest';
import {
  evaluateMicrostructureRule,
  PREREGISTERED_MICRO_RULES,
  simulateMicrostructureRule,
  type MicroFeatureBar,
  type MicroTrade,
} from '../../src/lib/lighter-microstructure-research.js';

const FIVE_MINUTES_MS = 5 * 60_000;

function bar(
  index: number,
  overrides: Partial<MicroFeatureBar> = {},
): MicroFeatureBar {
  return {
    marketId: 1,
    symbol: 'BTC',
    timeMs: index * FIVE_MINUTES_MS,
    open: 100,
    close: 100,
    returnPct: 0,
    spreadPct: 0.01,
    bid5Usd: 10_000,
    ask5Usd: 10_000,
    depthImbalance: 0,
    flowImbalance: 0,
    liquidationImbalance: 0,
    basisPct: 0,
    fundingRatePctH: 0,
    executionCostPct: 0.1,
    trend: 'bull',
    volatility: 'low',
    ...overrides,
  };
}

describe('Lighter microstructure research', () => {
  it('enters only at the next bar open and subtracts measured round-trip cost', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, { close: 50, depthImbalance: 0.5, flowImbalance: 0.5 }),
      bar(1, { open: 100, close: 100 }),
      bar(2, { open: 103, close: 103 }),
    ], rule);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.entryPrice).toBe(100);
    expect(trades[0]!.exitPrice).toBe(103);
    expect(trades[0]!.netPct).toBeCloseTo(2.9);
  });

  it('rejects a trade when a future bar is missing instead of spanning the gap', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, { depthImbalance: 0.5, flowImbalance: 0.5 }),
      bar(2, { open: 103 }),
    ], rule);
    expect(trades).toEqual([]);
  });

  it('enforces the frozen $500 depth floor before simulating entry', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, { depthImbalance: 0.5, flowImbalance: 0.5, bid5Usd: 499 }),
      bar(1),
      bar(2),
    ], rule);
    expect(trades).toEqual([]);
  });

  it('rejects a signal without a prospective signal-time execution cost', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, {
        depthImbalance: 0.5,
        flowImbalance: 0.5,
        executionCostPct: null,
      }),
      bar(1),
      bar(2),
    ], rule);
    expect(trades).toEqual([]);
  });

  it('does not qualify a profitable but single-market result', () => {
    const trades: MicroTrade[] = Array.from({ length: 120 }, (_, index) => ({
      ruleId: 'TEST',
      marketId: 1,
      symbol: 'BTC',
      side: index % 2 ? 'long' : 'short',
      signalTimeMs: index * FIVE_MINUTES_MS,
      entryTimeMs: (index + 1) * FIVE_MINUTES_MS,
      exitTimeMs: (index + 2) * FIVE_MINUTES_MS,
      entryPrice: 100,
      exitPrice: 100.3,
      grossPct: 0.3,
      fundingPct: 0,
      executionCostPct: 0.02,
      netPct: 0.28,
      trend: index % 2 ? 'bull' : 'bear',
      volatility: index % 3 ? 'low' : 'high',
    }));
    const evaluation = evaluateMicrostructureRule('TEST', trades);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('active symbols'),
      expect.stringContaining('dominance'),
    ]));
  });
});

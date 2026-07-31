import { describe, expect, it } from 'vitest';
import {
  evaluateMicrostructureRule,
  PREREGISTERED_MICRO_RULES,
  simulateMicrostructureRule,
  type MicroFeatureBar,
  type MicroTrade,
} from '../../src/lib/lighter-microstructure-research.js';
import { buildLighterFundingSeries } from '../../src/lib/lighter-funding-history.js';

const FIVE_MINUTES_MS = 5 * 60_000;
const EMPTY_FUNDING = new Map([[1, buildLighterFundingSeries([])]]);

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
    adverseExecutionCostPct: 0.16,
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
    ], rule, EMPTY_FUNDING);
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
    ], rule, EMPTY_FUNDING);
    expect(trades).toEqual([]);
  });

  it('enforces the frozen $500 depth floor before simulating entry', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, { depthImbalance: 0.5, flowImbalance: 0.5, bid5Usd: 499 }),
      bar(1),
      bar(2),
    ], rule, EMPTY_FUNDING);
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
    ], rule, EMPTY_FUNDING);
    expect(trades).toEqual([]);
  });

  it('rejects a signal without an observed execution maximum', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, {
        depthImbalance: 0.5,
        flowImbalance: 0.5,
        adverseExecutionCostPct: null,
      }),
      bar(1),
      bar(2),
    ], rule, EMPTY_FUNDING);
    expect(trades).toEqual([]);
  });

  it('uses exact hourly settlements in (entry, exit] instead of rate interpolation', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const settlementAtExit = 2 * FIVE_MINUTES_MS;
    const funding = new Map([[1, buildLighterFundingSeries([{
      timestampMs: settlementAtExit,
      ratePctH: 0.2,
      direction: 'long',
    }])]]);
    const trades = simulateMicrostructureRule([
      bar(0, { close: 50, depthImbalance: 0.5, flowImbalance: 0.5 }),
      bar(1, { open: 100, close: 100, fundingRatePctH: 99 }),
      bar(2, { open: 103, close: 103, fundingRatePctH: 99 }),
    ], rule, funding);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.fundingPct).toBeCloseTo(-0.2);
    expect(trades[0]!.netPct).toBeCloseTo(2.7);
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
      adverseExecutionCostPct: 0.03,
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

  it('uses the observed maximum as adverse execution instead of a fixed multiplier', () => {
    const trades: MicroTrade[] = Array.from({ length: 120 }, (_, index) => ({
      ruleId: 'OBSERVED-MAX',
      marketId: index % 4,
      symbol: ['BTC', 'ETH', 'SOL', 'HYPE'][index % 4]!,
      side: index % 2 ? 'long' : 'short',
      signalTimeMs: index * FIVE_MINUTES_MS,
      entryTimeMs: (index + 1) * FIVE_MINUTES_MS,
      exitTimeMs: (index + 2) * FIVE_MINUTES_MS,
      entryPrice: 100,
      exitPrice: 100.3,
      grossPct: 0.3,
      fundingPct: 0,
      executionCostPct: 0.02,
      adverseExecutionCostPct: 0.35,
      netPct: 0.28,
      trend: index % 2 ? 'bull' : 'bear',
      volatility: index % 3 ? 'low' : 'high',
    }));
    const evaluation = evaluateMicrostructureRule('OBSERVED-MAX', trades);
    expect(evaluation.netPct).toBeCloseTo(33.6);
    expect(evaluation.adverseNetPct).toBeCloseTo(-6);
    expect(evaluation.reasons).not.toEqual(expect.arrayContaining([
      expect.stringContaining('observed-maximum'),
    ]));
  });
});

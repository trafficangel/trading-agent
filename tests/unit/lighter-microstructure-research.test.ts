import { describe, expect, it } from 'vitest';
import {
  buildCausalMicroFeatureBars,
  evaluateMicrostructureRule,
  existingImmutableFrozenMicrostructureReport,
  PREREGISTERED_MICRO_CHALLENGERS,
  PREREGISTERED_MICRO_RULES,
  simulateMicrostructureRule,
  type MicroFeatureBar,
  type MicroTrade,
} from '../../src/lib/lighter-microstructure-research.js';
import { buildLighterFundingSeries } from '../../src/lib/lighter-funding-history.js';
import type { StoredMicrostructureMinute } from '../../src/lib/lighter-microstructure.js';

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
    barMinutes: 5,
    open: 100,
    close: 100,
    returnPct: 0,
    spreadPct: 0.01,
    bid5Usd: 10_000,
    ask5Usd: 10_000,
    depthImbalance: 0,
    depthImbalanceChange: 0,
    tradedUsd: 10_000,
    tradeCount: 20,
    flowImbalance: 0,
    returnVolRatio: 0,
    liquidationImbalance: 0,
    liquidationShare: 0,
    basisPct: 0,
    fundingRatePctH: 0,
    executionCostPct: 0.1,
    adverseExecutionCostPct: 0.16,
    bookAgeMs: 30,
    trend: 'bull',
    volatility: 'low',
    ...overrides,
  };
}

function microMinute(
  index: number,
  minutes = 1,
  overrides: Partial<StoredMicrostructureMinute> = {},
): StoredMicrostructureMinute {
  const price = 100 + index * 0.01;
  return {
    marketId: 1,
    symbol: 'BTC',
    qualityOk: true,
    minuteTsMs: index * minutes * 60_000,
    samples: 60,
    bookUpdates: 60,
    nonceGaps: 0,
    staleSamples: 0,
    midOpen: price,
    midHigh: price + 0.01,
    midLow: price - 0.01,
    midClose: price,
    spreadAvgPct: 0.01,
    spreadMaxPct: 0.02,
    bid5UsdAvg: 10_000,
    ask5UsdAvg: 10_000,
    depthImbalanceAvg: 0.1,
    depthImbalanceClose: 0.1,
    bookAgeAvgMs: 20,
    bookAgeP95Ms: 30,
    execCost100Samples: 60,
    execCost100AvgPct: 0.01,
    execCost100P95Pct: 0.02,
    execCost100MaxPct: 0.03,
    buyUsd: 1_000,
    sellUsd: 900,
    cvdUsd: 100,
    tradeCount: 10,
    liquidationBuyUsd: 0,
    liquidationSellUsd: 0,
    indexPrice: price,
    markPrice: price,
    basisPct: 0,
    currentFundingRate: 0,
    lastFundingRate: 0,
    ...overrides,
  };
}

describe('Lighter microstructure research', () => {
  it('locks the first admissible frozen selection and rejects an unlocked evaluated file', () => {
    const locked = {
      version: 'lighter-microstructure-sweep-v3',
      mode: 'frozen',
      status: 'evaluated',
      immutableSelection: true,
      autoPromotion: false,
      shadowEligibleRules: ['1m:OF-CONT-25-H1'],
      evaluations: [{}],
    };
    expect(existingImmutableFrozenMicrostructureReport(locked)).toBe(locked);
    expect(existingImmutableFrozenMicrostructureReport({
      ...locked,
      status: 'not_ready',
      immutableSelection: false,
    })).toBeNull();
    expect(() => existingImmutableFrozenMicrostructureReport({
      ...locked,
      immutableSelection: false,
    })).toThrow(/refusing overwrite/);
    expect(() => existingImmutableFrozenMicrostructureReport({
      ...locked,
      mode: 'exploratory',
    })).toThrow(/refusing overwrite/);
    expect(existingImmutableFrozenMicrostructureReport({
      ...locked,
      version: 'lighter-microstructure-challenger-sweep-v1',
    }, 'lighter-microstructure-challenger-sweep-v1')).toBeTruthy();
  });

  it('keeps challenger signals symmetric and distinct from the core level rules', () => {
    const flip = PREREGISTERED_MICRO_CHALLENGERS.find(
      (candidate) => candidate.id === 'BOOK-FLIP-30-H1',
    )!;
    const absorption = PREREGISTERED_MICRO_CHALLENGERS.find(
      (candidate) => candidate.id === 'LOW-IMPACT-60-H1',
    )!;
    const liquidation = PREREGISTERED_MICRO_CHALLENGERS.find(
      (candidate) => candidate.id === 'LIQ-EXHAUST-20-H3',
    )!;
    expect(flip.signal(bar(0, {
      depthImbalanceChange: 0.35,
      depthImbalance: 0.25,
      flowImbalance: 0.15,
    }))).toBe('long');
    expect(flip.signal(bar(0, {
      depthImbalanceChange: -0.35,
      depthImbalance: -0.25,
      flowImbalance: -0.15,
    }))).toBe('short');
    expect(absorption.signal(bar(0, {
      flowImbalance: -0.7,
      returnVolRatio: -0.1,
      depthImbalance: 0.2,
    }))).toBe('long');
    expect(absorption.signal(bar(0, {
      flowImbalance: 0.7,
      returnVolRatio: 0.1,
      depthImbalance: -0.2,
    }))).toBe('short');
    expect(liquidation.signal(bar(0, {
      liquidationShare: 0.25,
      liquidationImbalance: -0.7,
      returnVolRatio: -0.7,
      depthImbalance: 0.2,
    }))).toBe('long');
    expect(liquidation.signal(bar(0, {
      liquidationShare: 0.25,
      liquidationImbalance: 0.7,
      returnVolRatio: 0.7,
      depthImbalance: -0.2,
    }))).toBe('short');
  });

  it('uses clock-equivalent causal warmups and resets them across a native gap', () => {
    const oneMinuteRows = Array.from({ length: 240 }, (_, index) => microMinute(index));
    const fiveMinuteRows = Array.from({ length: 48 }, (_, index) => microMinute(index, 5));
    expect(buildCausalMicroFeatureBars(oneMinuteRows, 1)).toHaveLength(1);
    expect(buildCausalMicroFeatureBars(oneMinuteRows, 1)[0]?.barMinutes).toBe(1);
    expect(buildCausalMicroFeatureBars(fiveMinuteRows, 5)).toHaveLength(1);
    expect(buildCausalMicroFeatureBars(fiveMinuteRows, 5)[0]?.barMinutes).toBe(5);
    expect(
      buildCausalMicroFeatureBars(oneMinuteRows.filter((_, index) => index !== 120), 1),
    ).toEqual([]);
  });

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

  it('does not apply a second arbitrary spread threshold after measured cost', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const trades = simulateMicrostructureRule([
      bar(0, {
        depthImbalance: 0.5,
        flowImbalance: 0.5,
        spreadPct: 0.25,
        executionCostPct: 0.3,
        adverseExecutionCostPct: 0.35,
      }),
      bar(1),
      bar(2, { open: 101 }),
    ], rule, EMPTY_FUNDING);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.netPct).toBeCloseTo(0.7);
  });

  it('rejects one-print flow imbalance while leaving measured basis signals available', () => {
    const flowRule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const basisRule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'BASIS-4BP-H3')!;
    const sparse = [
      bar(0, {
        depthImbalance: 0.5,
        flowImbalance: 1,
        tradedUsd: 50,
        tradeCount: 1,
        basisPct: -0.05,
      }),
      bar(1),
      bar(2),
      bar(3),
      bar(4),
    ];
    expect(simulateMicrostructureRule(sparse, flowRule, EMPTY_FUNDING)).toEqual([]);
    expect(simulateMicrostructureRule(sparse, basisRule, EMPTY_FUNDING)).toHaveLength(1);
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

  it('keeps the H3 horizon at 15 clock minutes on native 1m bars', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H3')!;
    const minuteBars = Array.from({ length: 17 }, (_, index) => bar(index, {
      barMinutes: 1,
      timeMs: index * 60_000,
      open: index === 1 ? 100 : index === 16 ? 103 : 100,
      close: 100,
      depthImbalance: index === 0 ? 0.5 : 0,
      flowImbalance: index === 0 ? 0.5 : 0,
    }));
    const trades = simulateMicrostructureRule(minuteBars, rule, EMPTY_FUNDING);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      barMinutes: 1,
      entryTimeMs: 60_000,
      exitTimeMs: 16 * 60_000,
    });
    expect(trades[0]!.netPct).toBeCloseTo(2.9);
  });

  it('enforces ten portfolio slots with a deterministic market-id tie break', () => {
    const rule = PREREGISTERED_MICRO_RULES.find((candidate) => candidate.id === 'OF-CONT-25-H1')!;
    const features = Array.from({ length: 11 }, (_, marketId) => [
      bar(0, {
        marketId,
        symbol: `M${marketId}`,
        depthImbalance: 0.5,
        flowImbalance: 0.5,
      }),
      bar(1, { marketId, symbol: `M${marketId}` }),
      bar(2, { marketId, symbol: `M${marketId}`, open: 101 }),
    ]).flat();
    const funding = new Map(
      Array.from({ length: 11 }, (_, marketId) => [marketId, buildLighterFundingSeries([])]),
    );
    const trades = simulateMicrostructureRule(features, rule, funding);
    expect(trades).toHaveLength(10);
    expect(trades.map((trade) => trade.marketId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('does not qualify a profitable but single-market result', () => {
    const trades: MicroTrade[] = Array.from({ length: 120 }, (_, index) => ({
      ruleId: 'TEST',
      marketId: 1,
      symbol: 'BTC',
      side: index % 2 ? 'long' : 'short',
      barMinutes: 5,
      signalTimeMs: index * FIVE_MINUTES_MS,
      entryTimeMs: (index + 1) * FIVE_MINUTES_MS,
      exitTimeMs: (index + 2) * FIVE_MINUTES_MS,
      entryPrice: 100,
      exitPrice: 100.3,
      grossPct: 0.3,
      fundingPct: 0,
      executionCostPct: 0.02,
      adverseExecutionCostPct: 0.03,
      bookAgeMs: 30,
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
      barMinutes: 5,
      signalTimeMs: index * FIVE_MINUTES_MS,
      entryTimeMs: (index + 1) * FIVE_MINUTES_MS,
      exitTimeMs: (index + 2) * FIVE_MINUTES_MS,
      entryPrice: 100,
      exitPrice: 100.3,
      grossPct: 0.3,
      fundingPct: 0,
      executionCostPct: 0.02,
      adverseExecutionCostPct: 0.35,
      bookAgeMs: 30,
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

  it('keeps the first seven days diagnostic and fails a negative frozen OOS segment', () => {
    const cutoff = 7 * 86_400_000;
    const trades: MicroTrade[] = Array.from({ length: 120 }, (_, index) => {
      const inOos = index >= 60;
      const offset = inOos ? index - 60 : index;
      const entryTimeMs = (inOos ? cutoff : 0) + offset * 3_600_000;
      const grossPct = inOos ? -0.1 : 0.3;
      return {
        ruleId: 'OOS-CHECK',
        marketId: index % 4,
        symbol: ['BTC', 'ETH', 'SOL', 'HYPE'][index % 4]!,
        side: index % 2 ? 'long' : 'short',
        barMinutes: 5,
        signalTimeMs: entryTimeMs - FIVE_MINUTES_MS,
        entryTimeMs,
        exitTimeMs: entryTimeMs + FIVE_MINUTES_MS,
        entryPrice: 100,
        exitPrice: 100 + grossPct,
        grossPct,
        fundingPct: 0,
        executionCostPct: 0.02,
        adverseExecutionCostPct: 0.03,
        bookAgeMs: 30,
        netPct: grossPct - 0.02,
        trend: index % 2 ? 'bull' : 'bear',
        volatility: index % 3 ? 'low' : 'high',
      };
    });
    const evaluation = evaluateMicrostructureRule('OOS-CHECK', trades, 10, cutoff);
    expect(evaluation.discovery.netPct).toBeCloseTo(16.8);
    expect(evaluation.oos.netPct).toBeCloseTo(-7.2);
    expect(evaluation.reasons).toEqual(expect.arrayContaining([
      'frozen OOS failed',
      'OOS long side failed',
      'OOS short side failed',
    ]));
  });
});

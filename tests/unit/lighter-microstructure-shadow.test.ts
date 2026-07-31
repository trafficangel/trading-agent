import { describe, expect, it } from 'vitest';
import {
  buildMicrostructureShadowReport,
  frozenMicrostructureReportSha256,
  mergeMicrostructureShadowTrades,
  prepareMicrostructureShadowManifest,
  prospectiveMicrostructureShadowTrades,
} from '../../src/lib/lighter-microstructure-shadow.js';
import { buildLighterFundingSeries } from '../../src/lib/lighter-funding-history.js';
import type { MicroFeatureBar } from '../../src/lib/lighter-microstructure-research.js';

const NOW = Date.parse('2026-08-22T04:00:00Z');

function report(eligible: string[] = ['1m:OF-CONT-25-H1']): Record<string, unknown> {
  return {
    version: 'lighter-microstructure-sweep-v3',
    generatedAt: '2026-08-22T03:20:00Z',
    mode: 'frozen',
    status: 'evaluated',
    immutableSelection: true,
    autoPromotion: false,
    shadowEligibleRules: eligible,
    evaluations: eligible.map((id) => {
      const [timeframe, ruleId] = id.split(':');
      return { timeframeMinutes: Number(timeframe!.slice(0, -1)), ruleId, qualified: true };
    }),
  };
}

describe('Lighter microstructure prospective Shadow manifest', () => {
  it('does nothing before the immutable 21d report is evaluated', () => {
    const pending = {
      ...report(),
      status: 'not_ready',
      immutableSelection: false,
    };
    expect(prepareMicrostructureShadowManifest(pending, null, NOW))
      .toEqual({ status: 'not_ready', manifest: null });
    expect(() => prepareMicrostructureShadowManifest(
      pending,
      prepareMicrostructureShadowManifest(report(), null, NOW).manifest,
      NOW,
    )).toThrow(/without immutable frozen evidence/);
  });

  it('starts the cohort after selection and keeps Real disabled', () => {
    const result = prepareMicrostructureShadowManifest(report(), null, NOW);
    expect(result.status).toBe('created');
    expect(result.manifest).toMatchObject({
      status: 'active',
      activatedAt: '2026-08-22T04:00:00.000Z',
      notionalUsd: 100,
      maximumConcurrentPositions: 10,
      autoPromotion: false,
      realEnabled: false,
      candidates: [{
        id: '1m:OF-CONT-25-H1',
        timeframeMinutes: 1,
        ruleId: 'OF-CONT-25-H1',
      }],
    });
  });

  it('freezes an empty result as a terminal no-candidate cohort', () => {
    const result = prepareMicrostructureShadowManifest(report([]), null, NOW);
    expect(result.manifest?.status).toBe('no_candidates');
    expect(result.manifest?.candidates).toEqual([]);
  });

  it('rejects eligible ids without exact qualified evidence', () => {
    const value = report();
    value.evaluations = [];
    expect(() => prepareMicrostructureShadowManifest(value, null, NOW))
      .toThrow(/evidence missing/);
  });

  it('refuses to mutate an existing cohort when the frozen report changes', () => {
    const first = prepareMicrostructureShadowManifest(report(), null, NOW).manifest!;
    const changed = report(['5m:BASIS-4BP-H3']);
    expect(() => prepareMicrostructureShadowManifest(changed, first, NOW + 60_000))
      .toThrow(/contract mismatch/);
  });

  it('uses a stable canonical report hash independent of object key order', () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };
    expect(frozenMicrostructureReportSha256(left))
      .toBe(frozenMicrostructureReportSha256(right));
  });

  it('records only post-activation closed trades and enforces cohort-wide capacity', () => {
    const manifest = prepareMicrostructureShadowManifest(report(), null, NOW).manifest!;
    const bars: MicroFeatureBar[] = [];
    const funding = new Map<number, ReturnType<typeof buildLighterFundingSeries>>();
    for (let marketId = 1; marketId <= 11; marketId++) {
      funding.set(marketId, buildLighterFundingSeries([]));
      for (let minute = 0; minute <= 6; minute++) {
        bars.push({
          marketId,
          symbol: `M${marketId}`,
          timeMs: NOW - 60_000 + minute * 60_000,
          barMinutes: 1,
          open: 100 + minute,
          close: 100 + minute,
          returnPct: 0,
          spreadPct: 0.01,
          bid5Usd: 1_000,
          ask5Usd: 1_000,
          depthImbalance: minute === 0 ? 0.3 : 0,
          depthImbalanceChange: 0,
          tradedUsd: 10_000,
          tradeCount: 20,
          flowImbalance: minute === 0 ? 0.3 : 0,
          returnVolRatio: 0,
          liquidationImbalance: 0,
          liquidationShare: 0,
          basisPct: 0,
          fundingRatePctH: 0,
          executionCostPct: 0.02,
          adverseExecutionCostPct: 0.03,
          trend: 'bull',
          volatility: 'low',
        });
      }
    }
    const trades = prospectiveMicrostructureShadowTrades(
      manifest,
      new Map([[1, bars], [5, []]]),
      funding,
      NOW + 10 * 60_000,
    );
    expect(trades).toHaveLength(10);
    expect(trades.every((trade) => trade.entryTimeMs >= NOW)).toBe(true);
  });

  it('reports prospective $100 PnL and cannot enable Real', () => {
    const manifest = prepareMicrostructureShadowManifest(report(), null, NOW).manifest!;
    const trade = {
      ruleId: 'OF-CONT-25-H1', marketId: 1, symbol: 'BTC', side: 'long' as const,
      barMinutes: 1 as const, signalTimeMs: NOW, entryTimeMs: NOW + 60_000,
      exitTimeMs: NOW + 360_000, entryPrice: 100, exitPrice: 101,
      grossPct: 1, fundingPct: -0.01, executionCostPct: 0.02,
      adverseExecutionCostPct: 0.03, netPct: 0.97,
      trend: 'bull' as const, volatility: 'low' as const,
    };
    const value = buildMicrostructureShadowReport(manifest, [trade], NOW + 600_000);
    expect(value.summary).toMatchObject({ closed: 1, netPct: 0.97, netUsd: 0.97 });
    expect(value).toMatchObject({ prospectiveOnly: true, exactFunding: true, realEnabled: false });
  });

  it('preserves retained trades and fails if a closed trade changes', () => {
    const base = {
      ruleId: 'OF-CONT-25-H1', marketId: 1, symbol: 'BTC', side: 'long' as const,
      barMinutes: 1 as const, signalTimeMs: NOW, entryTimeMs: NOW + 60_000,
      exitTimeMs: NOW + 360_000, entryPrice: 100, exitPrice: 101,
      grossPct: 1, fundingPct: 0, executionCostPct: 0.02,
      adverseExecutionCostPct: 0.03, netPct: 0.98,
      trend: 'bull' as const, volatility: 'low' as const,
    };
    const later = { ...base, marketId: 2, symbol: 'ETH', entryTimeMs: NOW + 600_000 };
    expect(mergeMicrostructureShadowTrades([base], [base, later])).toEqual([base, later]);
    expect(() => mergeMicrostructureShadowTrades([base], [{ ...base, netPct: 0.5 }]))
      .toThrow(/trade changed/);
  });
});

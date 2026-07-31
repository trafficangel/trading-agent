import { describe, expect, it } from 'vitest';
import {
  buildLighterFrozenExecutionCosts,
  type LighterMicrostructureCostAudit,
} from '../../src/lib/lighter-execution-calibration.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');

function matureAudit(): LighterMicrostructureCostAudit {
  return {
    generatedAt: new Date(NOW - 60_000).toISOString(),
    thresholds: {
      expectedMarkets: 15,
      minimumQualityRatio: 0.95,
      rollingExecutionNotionalUsd: 100,
      frozenResearchHistoryDays: 21,
    },
    summary: {
      markets: 15,
      minDurationDays: 21.1,
      minCoverageRatio: 0.99,
      minQualityRatio: 0.98,
      minExecutionCostRatio: 0.97,
      minFiveMinuteQualityRatio: 0.96,
    },
    gates: { frozenCandidateResearch: { passed: true, failures: [] } },
    perMarket: Array.from({ length: 15 }, (_, index) => ({
      symbol: `M${index}`,
      executionCostMinutes: 29_000,
      avgExecutionCostP95Pct: 0.01 + index / 10_000,
      maxExecutionCostP95Pct: 0.02 + index / 10_000,
    })),
  };
}

describe('Lighter frozen execution-cost calibration', () => {
  it('exports all mature market-specific costs without a common fallback', () => {
    const result = buildLighterFrozenExecutionCosts(matureAudit(), NOW);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.calibration.notionalUsd).toBe(100);
    expect(Object.keys(result.calibration.summaries)).toHaveLength(15);
    expect(result.calibration.summaries.M0).toEqual({ n: 29_000, p95Pct: 0.01, maxPct: 0.02 });
  });

  it('fails closed before the frozen research gate passes', () => {
    const audit = matureAudit();
    audit.gates = {
      frozenCandidateResearch: { passed: false, failures: ['history 2d < 21d'] },
    };
    const result = buildLighterFrozenExecutionCosts(audit, NOW);
    expect(result.status).toBe('not_ready');
    if (result.status !== 'not_ready') return;
    expect(result.failures).toContain('frozen candidate research gate has not passed');
    expect(result.failures).toContain('history 2d < 21d');
  });

  it('rejects stale audits, wrong notional and incomplete markets', () => {
    const audit = matureAudit();
    audit.generatedAt = new Date(NOW - 3 * 60 * 60_000).toISOString();
    audit.thresholds!.rollingExecutionNotionalUsd = 1_000;
    audit.perMarket!.pop();
    const result = buildLighterFrozenExecutionCosts(audit, NOW);
    expect(result.status).toBe('not_ready');
    if (result.status !== 'not_ready') return;
    expect(result.failures).toContain('audit is older than 2 hours');
    expect(result.failures).toContain('execution notional is not $100');
    expect(result.failures).toContain('valid calibrated markets 14/15');
  });

  it('rejects an invalid market tail instead of replacing it', () => {
    const audit = matureAudit();
    audit.perMarket![3]!.maxExecutionCostP95Pct = 0.001;
    const result = buildLighterFrozenExecutionCosts(audit, NOW);
    expect(result.status).toBe('not_ready');
    if (result.status !== 'not_ready') return;
    expect(result.failures).toContain('M3 observed maximum is missing or below p95');
  });
});

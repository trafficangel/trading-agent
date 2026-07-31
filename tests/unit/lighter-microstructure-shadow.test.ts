import { describe, expect, it } from 'vitest';
import {
  frozenMicrostructureReportSha256,
  prepareMicrostructureShadowManifest,
} from '../../src/lib/lighter-microstructure-shadow.js';

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
});

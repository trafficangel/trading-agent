import { describe, expect, it } from 'vitest';
import {
  evaluateWickFadeRecoveryCanary,
  recoveryCanaryHoldsGlobalPause,
  type WickFadeRecoveryTrade,
} from '../../src/lib/wick-fade-recovery-canary.js';

const trade = (
  pnlPct: number,
  closeReason: string | null = 'target',
  exact = true,
): WickFadeRecoveryTrade => ({ pnlPct, netPnlUsd: exact ? pnlPct : null, closeReason, exact });

describe('wick-fade recovery canary', () => {
  it('allows one more probe while the minimum sample is incomplete', () => {
    const result = evaluateWickFadeRecoveryCanary([trade(0.2), trade(-0.1, 'time-stop')]);

    expect(result.status).toBe('active');
    expect(result.allowEntry).toBe(true);
    expect(result.n).toBe(2);
  });

  it('becomes ready for manual review after five profitable exact probes', () => {
    const result = evaluateWickFadeRecoveryCanary([
      trade(0.3), trade(-0.1, 'time-stop'), trade(0.25), trade(0.2), trade(0.15),
    ]);

    expect(result.status).toBe('ready');
    expect(result.allowEntry).toBe(false);
    expect(result.profitFactor).toBeGreaterThan(1.1);
  });

  it('stops immediately after two consecutive stop-like losses', () => {
    const result = evaluateWickFadeRecoveryCanary([
      trade(0.2), trade(-4, 'catastrophe'), trade(-3.5, 'reconciled-flat'),
    ]);

    expect(result.status).toBe('failed');
    expect(result.allowEntry).toBe(false);
    expect(result.consecutiveStops).toBe(2);
  });

  it('fails closed while exact fill accounting is incomplete', () => {
    const result = evaluateWickFadeRecoveryCanary([trade(0.2), trade(0.1, 'target', false)]);

    expect(result.status).toBe('active');
    expect(result.allowEntry).toBe(false);
    expect(result.reason).toContain('exact accounting');
  });

  it('fails after ten probes when profitability is not proven', () => {
    const rows = Array.from({ length: 10 }, (_, index) => trade(index % 2 === 0 ? 0.1 : -0.2, 'time-stop'));
    const result = evaluateWickFadeRecoveryCanary(rows);

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('10 trades');
  });

  it('keeps the global book paused until full resumption is separately approved', () => {
    expect(recoveryCanaryHoldsGlobalPause('active')).toBe(true);
    expect(recoveryCanaryHoldsGlobalPause('ready')).toBe(true);
    expect(recoveryCanaryHoldsGlobalPause('failed')).toBe(true);
    expect(recoveryCanaryHoldsGlobalPause('ready', true)).toBe(false);
    expect(recoveryCanaryHoldsGlobalPause(null)).toBe(false);
  });
});

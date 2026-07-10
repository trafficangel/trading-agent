import { describe, expect, it } from 'vitest';
import {
  evaluateWickFadeDriftGuard,
  wickFadeDriftBlockReason,
  type WickFadeDriftRuntimeState,
  type WickFadeDriftTrade,
} from '../../src/lib/wick-fade-drift-guard.js';

const trade = (pnlPct: number): WickFadeDriftTrade => ({ pnlPct, netPnlUsd: pnlPct });

describe('wick-fade rolling drift guard', () => {
  it('pauses when the latest 20 trades deteriorate', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => trade(i % 2 ? 0.2 : -0.6)),
      ...Array.from({ length: 20 }, () => trade(0.2)),
    ];
    const result = evaluateWickFadeDriftGuard(rows, false);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('fast');
    expect(result.fast.averagePct).toBeCloseTo(-0.2, 8);
  });

  it('pauses when slower deterioration is hidden by a better latest window', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => trade(0.08)),
      ...Array.from({ length: 20 }, () => trade(-0.4)),
    ];
    const result = evaluateWickFadeDriftGuard(rows, false);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('slow');
  });

  it('keeps a paused book latched until both recovery windows are healthy', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => trade(0.04)),
      ...Array.from({ length: 20 }, () => trade(-0.10)),
    ];
    const result = evaluateWickFadeDriftGuard(rows, true);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('recovery not proven');
  });

  it('resumes only after the fast and slow windows clear hysteresis thresholds', () => {
    const rows = Array.from({ length: 40 }, (_, i) => trade(i % 3 === 0 ? -0.1 : 0.15));
    const result = evaluateWickFadeDriftGuard(rows, true);

    expect(result.blocked).toBe(false);
    expect(result.stage).toBe('live');
  });

  it('fails closed when exact accounting is insufficient', () => {
    const result = evaluateWickFadeDriftGuard(Array.from({ length: 39 }, () => trade(0.2)), false);

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('exact sample 39/40');
  });

  it('fails closed for missing, invalid, or stale runtime state', () => {
    const now = Date.UTC(2026, 6, 10);
    expect(wickFadeDriftBlockReason(undefined, now)).toContain('initializing');
    expect(wickFadeDriftBlockReason('{bad', now)).toContain('invalid');
    expect(wickFadeDriftBlockReason(JSON.stringify({ checkedAt: now - 11 * 60_000, blocked: false }), now)).toContain('stale');
  });

  it('allows entries only for a fresh healthy runtime state', () => {
    const now = Date.UTC(2026, 6, 10);
    const healthy = {
      blocked: false,
      checkedAt: now,
      reason: 'healthy',
    } as WickFadeDriftRuntimeState;
    const paused = { ...healthy, blocked: true, reason: 'rolling deterioration' };

    expect(wickFadeDriftBlockReason(JSON.stringify(healthy), now)).toBeNull();
    expect(wickFadeDriftBlockReason(JSON.stringify(paused), now)).toBe('rolling deterioration');
  });
});

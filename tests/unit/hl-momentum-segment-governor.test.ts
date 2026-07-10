import { describe, expect, it } from 'vitest';
import {
  CONFIRM_LONG_CANARY_POLICY,
  MOMENTUM_PROMOTION_POLICY,
  evaluateMomentumSegment,
  evaluateMomentumPromotion,
  walkForwardMomentumSegment,
  type MomentumPromotionTrade,
  type MomentumSegmentRow,
} from '../../src/lib/hl-momentum-segment-governor.js';

const row = (pnlPct: number, side: 'long' | 'short' = 'long', layer: 'confirm' | 'fast' = 'confirm'): MomentumSegmentRow => ({
  side,
  layer,
  pnlPct,
});

const trade = (pnlPct: number, closedAt: number, exact = true): MomentumPromotionTrade => ({
  pnlPct,
  netPnlUsd: exact ? pnlPct / 10 : null,
  exact,
  closedAt,
});

describe('HL momentum side-aware governor', () => {
  it('enables confirm-long only when full and recent windows are positive', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row(0.10)),
      ...Array.from({ length: 20 }, () => row(0.04)),
      ...Array.from({ length: 30 }, () => row(1, 'short')),
    ];
    const result = evaluateMomentumSegment(rows, 'confirm', 'long', CONFIRM_LONG_CANARY_POLICY);
    expect(result.enabled).toBe(true);
    expect(result.sample.n).toBe(40);
    expect(result.recent.averagePct).toBeCloseTo(0.10, 6);
  });

  it('blocks a stale edge when the newest window turns negative', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row(-0.05)),
      ...Array.from({ length: 20 }, () => row(0.20)),
    ];
    const result = evaluateMomentumSegment(rows, 'confirm', 'long', CONFIRM_LONG_CANARY_POLICY);
    expect(result.sample.averagePct).toBeGreaterThan(CONFIRM_LONG_CANARY_POLICY.minAveragePct);
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('recent average');
  });

  it('walks forward without selecting the training window', () => {
    const training = Array.from({ length: 40 }, () => row(0.05));
    const future = [row(0.2), row(-0.1), row(0.3)];
    const result = walkForwardMomentumSegment([...training, ...future], 'confirm', 'long', CONFIRM_LONG_CANARY_POLICY);
    expect(result.n).toBe(3);
    expect(result.sumPct).toBeCloseTo(0.4, 6);
  });

  it('never borrows evidence from another side or layer', () => {
    const rows = [
      ...Array.from({ length: 50 }, () => row(0.3, 'short')),
      ...Array.from({ length: 50 }, () => row(0.3, 'long', 'fast')),
      ...Array.from({ length: 20 }, () => row(0.3)),
    ];
    expect(evaluateMomentumSegment(rows, 'confirm', 'long', CONFIRM_LONG_CANARY_POLICY).enabled).toBe(false);
  });
});

describe('HL momentum promotion ladder', () => {
  const now = Date.UTC(2026, 6, 10);

  it('keeps the first ten exact trades in one-slot canary-1', () => {
    const result = evaluateMomentumPromotion([
      trade(-0.21, now - 3_000),
      trade(0.748, now - 2_000),
      trade(-0.374, now - 1_000),
    ], true, now);

    expect(result.stage).toBe('canary-1');
    expect(result.maxOpen).toBe(1);
    expect(result.n).toBe(3);
    expect(result.exactN).toBe(3);
    expect(result.averagePct).toBeCloseTo(0.0547, 3);
    expect(result.profitFactor).toBeGreaterThan(1.2);
    expect(result.nextMinTrades).toBe(10);
  });

  it('promotes to canary-2 after ten profitable exact trades', () => {
    const pnls = [-0.15, 0.15, 0.15, -0.15, 0.15, 0.15, -0.15, 0.15, 0.15, 0.15];
    const rows = pnls.map((pnl, i) => trade(pnl, now - (pnls.length - i) * 1_000));
    const result = evaluateMomentumPromotion(rows, true, now);

    expect(result.stage).toBe('canary-2');
    expect(result.maxOpen).toBe(2);
    expect(result.nextMinTrades).toBe(25);
  });

  it('promotes to scaled only after the stricter 25-trade gate', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      trade(i % 5 === 0 ? -0.10 : 0.12, now - (25 - i) * 1_000));
    const result = evaluateMomentumPromotion(rows, true, now);

    expect(result.stage).toBe('scaled');
    expect(result.liveEnabled).toBe(true);
    expect(result.nextStage).toBeNull();
  });

  it('pauses on three red live trades and restores a one-slot probe after cooldown', () => {
    const rows = [
      trade(-0.1, now - 3_000),
      trade(-0.2, now - 2_000),
      trade(-0.3, now - 1_000),
    ];
    const paused = evaluateMomentumPromotion(rows, true, now);
    const recovered = evaluateMomentumPromotion(rows, true, now + MOMENTUM_PROMOTION_POLICY.retryAfterMs);

    expect(paused.stage).toBe('shadow');
    expect(paused.liveEnabled).toBe(false);
    expect(paused.retryAfter).toBe(now - 1_000 + MOMENTUM_PROMOTION_POLICY.retryAfterMs);
    expect(recovered.stage).toBe('canary-1');
    expect(recovered.reason).toContain('probe restored');
  });

  it('does not promote without exact fills or current shadow evidence', () => {
    const rows = Array.from({ length: 10 }, (_, i) => trade(0.2, now - (10 - i) * 1_000, i !== 0));

    expect(evaluateMomentumPromotion(rows, true, now).stage).toBe('canary-1');
    expect(evaluateMomentumPromotion(rows, false, now).stage).toBe('shadow');
  });
});

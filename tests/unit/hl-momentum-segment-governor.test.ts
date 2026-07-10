import { describe, expect, it } from 'vitest';
import {
  CONFIRM_LONG_CANARY_POLICY,
  evaluateMomentumSegment,
  walkForwardMomentumSegment,
  type MomentumSegmentRow,
} from '../../src/lib/hl-momentum-segment-governor.js';

const row = (pnlPct: number, side: 'long' | 'short' = 'long', layer: 'confirm' | 'fast' = 'confirm'): MomentumSegmentRow => ({
  side,
  layer,
  pnlPct,
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

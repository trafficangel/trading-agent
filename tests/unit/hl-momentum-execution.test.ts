import { describe, expect, it } from 'vitest';
import {
  evaluateMomentumIntrabar,
  momentumNetPnlPct,
  type MomentumIntrabarRisk,
} from '../../src/lib/hl-momentum-execution.js';

const risk: MomentumIntrabarRisk = {
  stopPct: 0.0022,
  trailActivatePct: 0.0083,
  trailGivebackPct: 0.0011,
  trailMinLockPct: 0.0072,
};

describe('HL momentum intrabar execution parity', () => {
  it('stops a fast long on the same intrabar mid seen by live execution', () => {
    const result = evaluateMomentumIntrabar(
      { side: 'long', entryPx: 100, openedAt: 0 },
      99.77,
      5_000,
      risk,
    );

    expect(result.exitReason).toBe('fast-stop');
    expect(momentumNetPnlPct('long', 100, 99.77)).toBeCloseTo(-0.32, 8);
  });

  it('carries the best mid forward and exits on the shared trailing rule', () => {
    const armed = evaluateMomentumIntrabar(
      { side: 'long', entryPx: 100, openedAt: 0 },
      101,
      10_000,
      risk,
    );
    const pulledBack = evaluateMomentumIntrabar(
      { side: 'long', entryPx: 100, openedAt: 0 },
      100.75,
      12_000,
      risk,
      armed.bestPx,
    );

    expect(armed.trail.active).toBe(true);
    expect(pulledBack.bestPx).toBe(101);
    expect(pulledBack.exitReason).toBe('fast-trailing-stop');
  });

  it('uses the same decay decision for paper and live callers', () => {
    const result = evaluateMomentumIntrabar(
      { side: 'short', entryPx: 100, openedAt: 0 },
      100.08,
      6 * 60_000,
      risk,
      99.98,
    );

    expect(result.exitReason).toBe('fast-momentum-decay');
  });
});

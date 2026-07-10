import { describe, expect, it } from 'vitest';
import { robustCalibration } from '../../src/lib/hl-momentum-calibration.js';

describe('HL momentum robust calibration', () => {
  it('returns neutral targets without observations', () => {
    expect(robustCalibration([])).toMatchObject({ n: 0, targetProbBias: 0, targetEvBias: 0 });
  });

  it('shrinks probability correction toward zero', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      pnlPct: i < 20 ? 0.2 : -0.2,
      rawProb: 0.60,
      rawExpectedPnl: 0,
    }));
    const result = robustCalibration(rows);
    expect(result.actualWr).toBe(0.5);
    expect(result.targetProbBias).toBeCloseTo(-0.05, 6);
  });

  it('does not let one large winner dominate EV bias', () => {
    const rows = [
      ...Array.from({ length: 29 }, () => ({ pnlPct: 0, rawProb: 0.5, rawExpectedPnl: 0 })),
      { pnlPct: 5.6, rawProb: 0.5, rawExpectedPnl: 0 },
    ];
    const result = robustCalibration(rows);
    expect(result.avgActualPnl).toBeGreaterThan(0.18);
    expect(result.robustEvResidual).toBeLessThan(0.01);
    expect(result.targetEvBias).toBeLessThan(0.01);
  });

  it('produces an absolute target from raw residuals', () => {
    const rows = Array.from({ length: 40 }, () => ({ pnlPct: -0.2, rawProb: 0.5, rawExpectedPnl: 0.1 }));
    const result = robustCalibration(rows);
    expect(result.robustEvResidual).toBeCloseTo(-0.3, 6);
    expect(result.targetEvBias).toBeCloseTo(-0.15, 6);
  });
});

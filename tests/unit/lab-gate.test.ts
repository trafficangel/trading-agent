/**
 * labGateVerdict — forward-gate / decay verdict for lab strategies.
 * Pins the promotion-readiness + decay-detection logic.
 */

import { describe, it, expect } from 'vitest';
import { labGateVerdict } from '../../src/lib/lab-gate.js';

describe('labGateVerdict', () => {
  it('collecting when too few paper trades', () => {
    expect(labGateVerdict({ closed: 3, netPct: 5, winRate: 0.6 }).status).toBe('collecting');
  });

  it('underperforming when paper net <= 0 with enough trades', () => {
    expect(labGateVerdict({ closed: 12, netPct: -4, winRate: 0.5 }).status).toBe('underperforming');
  });

  it('confirming when positive but below the ready sample size', () => {
    expect(labGateVerdict({ closed: 10, netPct: 8, winRate: 0.7 }).status).toBe('confirming');
  });

  it('ready when positive over the ready sample size and matching backtest', () => {
    // exp/trade = 20/20 = 1.0 ≥ 0.4×1.95 → not decaying
    expect(labGateVerdict({ closed: 20, netPct: 20, winRate: 0.7, btNetPctPerTrade: 1.95 }).status).toBe('ready');
  });

  it('diverging when positive but well below the backtest per-trade expectancy', () => {
    // exp/trade = 2/20 = 0.1 < 0.4×1.95=0.78 → decaying
    expect(labGateVerdict({ closed: 20, netPct: 2, winRate: 0.6, btNetPctPerTrade: 1.95 }).status).toBe('diverging');
  });

  it('ready without a backtest reference (decay check skipped)', () => {
    expect(labGateVerdict({ closed: 20, netPct: 5, winRate: 0.6 }).status).toBe('ready');
  });
});

/**
 * calcPnl — PnL math for closed trades.
 *
 * History: audit C1 (2026-05-19) caught a swapped-args bug in
 * src/strategies/user-fanout.ts where the call passed (sl, closePrice)
 * in the wrong order. Every Track D user exit since fan-out shipped
 * wrote inverted pnl_pct + mirrored pnl_r. These tests pin the contract.
 *
 * Signature: calcPnl(side, entry, sl, closePrice).
 */

import { describe, it, expect } from 'vitest';
import { calcPnl } from '../../src/lib/pnl.js';

describe('calcPnl', () => {
  describe('long', () => {
    it('+1% move with 1% SL = +1R, +1.00%', () => {
      const r = calcPnl('long', 100, 99, 101);
      expect(r.pnlPct).toBe(1);
      expect(r.pnlR).toBe(1);
    });

    it('SL hit = -1R, -1.00%', () => {
      const r = calcPnl('long', 100, 99, 99);
      expect(r.pnlPct).toBe(-1);
      expect(r.pnlR).toBe(-1);
    });

    it('+2% move with 1% SL = +2R', () => {
      const r = calcPnl('long', 100, 99, 102);
      expect(r.pnlPct).toBe(2);
      expect(r.pnlR).toBe(2);
    });

    it('half-SL stop-out = -0.5R', () => {
      const r = calcPnl('long', 100, 99, 99.5);
      expect(r.pnlPct).toBe(-0.5);
      expect(r.pnlR).toBe(-0.5);
    });
  });

  describe('short', () => {
    it('-1% move (price down) = +1R for short', () => {
      const r = calcPnl('short', 100, 101, 99);
      expect(r.pnlPct).toBe(1);
      expect(r.pnlR).toBe(1);
    });

    it('SL hit on short = -1R', () => {
      const r = calcPnl('short', 100, 101, 101);
      expect(r.pnlPct).toBe(-1);
      expect(r.pnlR).toBe(-1);
    });

    it('+2% drawdown on short = -2R, -2.00%', () => {
      const r = calcPnl('short', 100, 101, 102);
      expect(r.pnlPct).toBe(-2);
      expect(r.pnlR).toBe(-2);
    });
  });

  describe('edge cases', () => {
    it('zero SL distance returns 0R (avoid div-by-zero)', () => {
      const r = calcPnl('long', 100, 100, 101);
      expect(r.pnlR).toBe(0);
      // pnlPct still meaningful
      expect(r.pnlPct).toBe(1);
    });

    it('flat close = 0 pct / 0 R', () => {
      const r = calcPnl('long', 100, 99, 100);
      expect(r.pnlPct).toBe(0);
      expect(r.pnlR).toBe(0);
    });
  });

  describe('audit C1 regression — swapped sl/closePrice', () => {
    // The bug was calcPnl(side, entry, closePrice, sl). Verify that
    // swapped order produces a clearly DIFFERENT result, so a future
    // regression would fail this test.
    it('swapped args produce different pnl', () => {
      const correct = calcPnl('long', 100, 99, 102); // sl=99, close=102 → +2R
      const swapped = calcPnl('long', 100, 102, 99); // sl=102, close=99 → -0.5R
      expect(correct.pnlR).not.toBe(swapped.pnlR);
      expect(correct.pnlPct).not.toBe(swapped.pnlPct);
      // explicit:
      expect(correct.pnlR).toBe(2);
      expect(swapped.pnlR).toBe(-0.5);
    });
  });
});

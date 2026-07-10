import { describe, expect, it } from 'vitest';
import {
  arbExitReason,
  estimatedBasisNetFromFills,
  estimatedPairNetPnlPct,
  quantizeToStep,
  sidesForBasisDirection,
  underlyingDeltaMismatchPct,
} from '../../src/lib/hl-bybit-arb-execution.js';

describe('HL <-> Bybit arb execution helpers', () => {
  it('maps the two delta-neutral directions', () => {
    expect(sidesForBasisDirection('LONG HL / SHORT BY')).toEqual({ hl: 'long', bybit: 'short' });
    expect(sidesForBasisDirection('LONG BY / SHORT HL')).toEqual({ hl: 'short', bybit: 'long' });
  });

  it('quantizes size down and IOC prices toward the crossing side', () => {
    expect(quantizeToStep(1.239, '0.01')).toBe(1.23);
    expect(quantizeToStep(1.231, '0.01', 'ceil')).toBe(1.24);
    expect(quantizeToStep(123.8, '1')).toBe(123);
  });

  it('detects contract-unit delta mismatch', () => {
    expect(underlyingDeltaMismatchPct(2, 1_000, 2_000, 1)).toBe(0);
    expect(underlyingDeltaMismatchPct(2, 1_000, 1_900, 1)).toBeCloseTo(5.1282, 4);
  });

  it('marks pair PnL after all four taker fees', () => {
    expect(estimatedPairNetPnlPct({
      hlSide: 'long', hlEntryPx: 100, hlExitPx: 100.5,
      bybitSide: 'short', bybitEntryPx: 102, bybitExitPx: 101.5,
    })).toBeCloseTo(0.7902, 4);
  });

  it('revalidates net basis from actual normalized fills', () => {
    expect(estimatedBasisNetFromFills({
      direction: 'LONG HL / SHORT BY',
      hlEntryPx: 100,
      hlUnit: 1,
      bybitEntryPx: 102,
      bybitUnit: 1,
      totalCostPct: 0.35,
    })).toBeCloseTo(1.6302, 4);
    expect(estimatedBasisNetFromFills({
      direction: 'LONG BY / SHORT HL',
      hlEntryPx: 102,
      hlUnit: 1,
      bybitEntryPx: 100,
      bybitUnit: 1,
      totalCostPct: 0.35,
    })).toBeCloseTo(1.6302, 4);
  });

  it('prioritizes profit and stop exits before the time guard', () => {
    const common = { openedAt: 0, nowMs: 86_400_001, takeProfitPct: 0.5, stopLossPct: -0.75, maxHoldMs: 86_400_000 };
    expect(arbExitReason({ ...common, netPnlPct: 0.6 })).toBe('take-profit');
    expect(arbExitReason({ ...common, netPnlPct: -0.8 })).toBe('basis-stop');
    expect(arbExitReason({ ...common, netPnlPct: 0.1 })).toBe('max-hold');
    expect(arbExitReason({ ...common, nowMs: 1_000, netPnlPct: 0.1 })).toBeNull();
  });
});

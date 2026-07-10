import { describe, expect, it } from 'vitest';
import { calculateHlTradeAccounting, type HlAccountingFill } from '../../src/lib/hl-trade-accounting.js';

const fill = (overrides: Partial<HlAccountingFill>): HlAccountingFill => ({
  time: 1_000,
  px: 10,
  sz: 1,
  side: 'B',
  dir: 'Open Long',
  startPosition: 0,
  closedPnl: 0,
  fee: 0.01,
  ...overrides,
});

describe('Hyperliquid trade accounting', () => {
  it('uses exchange closed pnl, fees and funding', () => {
    const result = calculateHlTradeAccounting([
      fill({}),
      fill({ time: 2_000, px: 11, side: 'A', dir: 'Close Long', startPosition: 1, closedPnl: 1, fee: 0.011 }),
    ], [{ time: 1_500, usdc: -0.02 }], 1_100);

    expect(result).toMatchObject({ complete: true, grossPnlUsd: 1, fundingUsd: -0.02 });
    expect(result?.feesUsd).toBeCloseTo(0.021, 9);
    expect(result?.netPnlUsd).toBeCloseTo(0.959, 9);
    expect(result?.netPnlPct).toBeCloseTo(9.59, 9);
  });

  it('aggregates partial entry and exit fills', () => {
    const result = calculateHlTradeAccounting([
      fill({ sz: 0.4, fee: 0.004 }),
      fill({ time: 1_010, sz: 0.6, startPosition: 0.4, fee: 0.006 }),
      fill({ time: 2_000, px: 10.5, sz: 0.25, side: 'A', dir: 'Close Long', startPosition: 1, closedPnl: 0.125, fee: 0.002625 }),
      fill({ time: 2_010, px: 10.5, sz: 0.75, side: 'A', dir: 'Close Long', startPosition: 0.75, closedPnl: 0.375, fee: 0.007875 }),
    ], [], 1_100);

    expect(result).toMatchObject({ complete: true, entryQty: 1, exitQty: 1, fillCount: 4 });
    expect(result?.netPnlUsd).toBeCloseTo(0.4795, 9);
  });

  it('isolates a re-entry from the previous round trip', () => {
    const result = calculateHlTradeAccounting([
      fill({ time: 900, px: 9, side: 'A', dir: 'Close Long', startPosition: 1, closedPnl: -1 }),
      fill({ time: 1_000 }),
      fill({ time: 2_000, px: 11, side: 'A', dir: 'Close Long', startPosition: 1, closedPnl: 1 }),
      fill({ time: 2_100, px: 12, dir: 'Open Long', startPosition: 0 }),
    ], [], 1_050);

    expect(result).toMatchObject({ entryTime: 1_000, exitTime: 2_000, grossPnlUsd: 1, fillCount: 2 });
  });

  it('returns an incomplete snapshot while the position is open', () => {
    const result = calculateHlTradeAccounting([fill({})], [], 1_050);
    expect(result).toMatchObject({ complete: false, exitTime: null, netPnlUsd: -0.01 });
  });

  it('handles a short round trip', () => {
    const result = calculateHlTradeAccounting([
      fill({ side: 'A', dir: 'Open Short', px: 10, startPosition: 0 }),
      fill({ time: 2_000, side: 'B', dir: 'Close Short', px: 9, startPosition: -1, closedPnl: 1, fee: 0.009 }),
    ], [], 1_050);

    expect(result).toMatchObject({ complete: true, entryAvgPx: 10, exitAvgPx: 9 });
    expect(result?.netPnlUsd).toBeCloseTo(0.981, 9);
  });
});

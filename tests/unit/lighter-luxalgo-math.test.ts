import { describe, expect, it } from 'vitest';
import {
  evaluateNativeForwardGate,
  evaluateNativeForwardRows,
  estimatedFundingPnlPct,
  LUXALGO_SHADOW_NOTIONAL_USD,
  NATIVE_SHADOW_NOTIONAL_USD,
  pricePnlPct,
  quoteNotionalVwap,
  shadowExecutionNotionalUsd,
} from '../../src/lib/lighter-luxalgo-math.js';

const DAY_MS = 86_400_000;
function forwardCoverage(count: number, marketCount = 1) {
  return {
    sides: Array.from({ length: count }, (_, index) => index % 2 ? 'short' as const : 'long' as const),
    symbols: Array.from({ length: count }, (_, index) => `M${index % marketCount}`),
    openedAtMs: Array.from({ length: count }, (_, index) => index / Math.max(1, count - 1) * 8 * DAY_MS),
    closedAtMs: Array.from({ length: count }, (_, index) => index / Math.max(1, count - 1) * 8 * DAY_MS + 60_000),
  };
}

describe('Lighter LuxAlgo shadow math', () => {
  it('keeps Native Shadow aligned with the $100 selection and Real canary', () => {
    expect(shadowExecutionNotionalUsd(true)).toBe(NATIVE_SHADOW_NOTIONAL_USD);
    expect(NATIVE_SHADOW_NOTIONAL_USD).toBe(100);
    expect(shadowExecutionNotionalUsd(false)).toBe(LUXALGO_SHADOW_NOTIONAL_USD);
    expect(LUXALGO_SHADOW_NOTIONAL_USD).toBe(1_000);
  });

  it('sweeps fixed USD notional across depth', () => {
    const vwap = quoteNotionalVwap([[100, 5], [101, 10]], 1_000);
    expect(vwap).not.toBeNull();
    expect(vwap!).toBeCloseTo(1_000 / (5 + 500 / 101), 6);
  });

  it('refuses insufficient depth', () => {
    expect(quoteNotionalVwap([[100, 5]], 1_000)).toBeNull();
  });

  it('calculates long and short price PnL', () => {
    expect(pricePnlPct('long', 100, 103)).toBeCloseTo(3);
    expect(pricePnlPct('short', 100, 97)).toBeCloseTo(3);
  });

  it('applies positive funding as a long cost and short income', () => {
    expect(estimatedFundingPnlPct('long', 0.001, 0.003, 2 * 3_600_000))
      .toBeCloseTo(-0.004);
    expect(estimatedFundingPnlPct('short', 0.001, 0.003, 2 * 3_600_000))
      .toBeCloseTo(0.004);
  });

  it('keeps collecting Native forward evidence before 20 closes', () => {
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(19),
      netPcts: Array.from({ length: 19 }, () => -0.2),
      signalCount: 19,
      captureErrors: 19,
      executionCostPcts: [],
      bookAgesMs: [],
    });
    expect(result.status).toBe('collecting');
    expect(result.entryAllowed).toBe(true);
  });

  it('fails closed immediately when the frozen drawdown ceiling is irreversibly breached', () => {
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(5),
      netPcts: [1, -2, -2, -2, -2],
      signalCount: 5,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 5 }, () => 0.02),
      bookAgesMs: Array.from({ length: 5 }, () => 100),
    });
    expect(result.status).toBe('failed');
    expect(result.entryAllowed).toBe(false);
    expect(result.closed).toBe(5);
    expect(result.maxDrawdownPct).toBeCloseTo(8);
    expect(result.reasons).toEqual([
      expect.stringContaining('drawdown'),
    ]);
  });

  it('passes a profitable, stable and executable Native forward sample', () => {
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(20),
      netPcts: Array.from({ length: 20 }, (_, index) => index % 4 === 0 ? -0.2 : 0.25),
      signalCount: 40,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 40 }, () => 0.04),
      bookAgesMs: Array.from({ length: 40 }, () => 120),
    });
    expect(result.status).toBe('passed');
    expect(result.entryAllowed).toBe(true);
    expect(result.netPct).toBeGreaterThan(0);
    expect(result.profitFactor).toBeGreaterThanOrEqual(1.2);
  });

  it('keeps profitable evidence in Shadow until duration, both sides and portfolio breadth mature', () => {
    const shortCoverage = forwardCoverage(20, 3);
    const result = evaluateNativeForwardGate({
      ...shortCoverage,
      sides: Array.from({ length: 20 }, () => 'long' as const),
      openedAtMs: Array.from({ length: 20 }, (_, index) => index * 60_000),
      closedAtMs: Array.from({ length: 20 }, (_, index) => index * 60_000 + 30_000),
      netPcts: Array.from({ length: 20 }, (_, index) => index % 4 === 0 ? -0.2 : 0.25),
      signalCount: 40,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 40 }, () => 0.04),
      bookAgesMs: Array.from({ length: 40 }, () => 120),
      minUniqueSymbols: 4,
    });
    expect(result.status).toBe('collecting');
    expect(result.entryAllowed).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('duration'),
      expect.stringContaining('short closes'),
      expect.stringContaining('markets'),
    ]));
  });

  it('blocks new entries when capture quality or book freshness fails', () => {
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(20),
      netPcts: Array.from({ length: 20 }, (_, index) => index % 4 === 0 ? -0.2 : 0.25),
      signalCount: 40,
      captureErrors: 2,
      executionCostPcts: Array.from({ length: 40 }, () => 0.12),
      bookAgesMs: Array.from({ length: 40 }, (_, index) => index >= 37 ? 2_500 : 120),
    });
    expect(result.status).toBe('failed');
    expect(result.entryAllowed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('capture errors'),
      expect.stringContaining('book age p95'),
    ]));
  });

  it('pauses before promotion when the latest resolved signal window is unhealthy', () => {
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(0),
      netPcts: [],
      signalCount: 20,
      captureErrors: 1,
      executionCostPcts: Array.from({ length: 19 }, () => 0.02),
      bookAgesMs: Array.from({ length: 19 }, () => 100),
      recentSignalCount: 20,
      recentCaptureErrors: 1,
      recentBookAgesMs: Array.from({ length: 19 }, () => 100),
    });
    expect(result.status).toBe('failed');
    expect(result.entryAllowed).toBe(false);
    expect(result.recentCaptureErrorRatePct).toBe(5);
    expect(result.reasons).toEqual([
      expect.stringContaining('recent 20 capture errors'),
    ]);
  });

  it('stops a mature strategy when the latest twenty trades decay', () => {
    const netPcts = [
      ...Array.from({ length: 30 }, () => 0.3),
      ...Array.from({ length: 10 }, () => 1),
      ...Array.from({ length: 20 }, () => -0.1),
    ];
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(60, 4),
      netPcts,
      signalCount: 100,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 100 }, () => 0.02),
      bookAgesMs: Array.from({ length: 100 }, () => 100),
    });
    expect(result.netPct).toBeGreaterThan(0);
    expect(result.firstHalfPct).toBeGreaterThan(0);
    expect(result.secondHalfPct).toBeGreaterThan(0);
    expect(result.status).toBe('failed');
    expect(result.entryAllowed).toBe(false);
    expect(result.recentClosed).toBe(20);
    expect(result.recentNetPct).toBeCloseTo(-2);
    expect(result.reasons).toEqual([
      expect.stringContaining('recent 20 decay'),
    ]);
  });

  it('does not apply one universal cost ceiling after net PnL already includes execution', () => {
    const result = evaluateNativeForwardGate({
      ...forwardCoverage(20),
      netPcts: Array.from({ length: 20 }, (_, index) => index % 4 === 0 ? -0.2 : 0.25),
      signalCount: 40,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 40 }, () => 0.12),
      bookAgesMs: Array.from({ length: 40 }, () => 120),
    });
    expect(result.status).toBe('passed');
    expect(result.avgExecutionCostPct).toBeCloseTo(0.12);
    expect(result.reasons).not.toEqual(expect.arrayContaining([
      expect.stringContaining('execution cost'),
    ]));
  });

  it('normalizes a multi-position portfolio drawdown by its frozen capacity', () => {
    const standalone = evaluateNativeForwardGate({
      ...forwardCoverage(20),
      netPcts: [5, -4, -4, ...Array.from({ length: 17 }, () => 0.5)],
      signalCount: 20,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 20 }, () => 0.02),
      bookAgesMs: Array.from({ length: 20 }, () => 100),
    });
    const portfolio = evaluateNativeForwardGate({
      ...forwardCoverage(20, 4),
      netPcts: [5, -4, -4, ...Array.from({ length: 17 }, () => 0.5)],
      signalCount: 20,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 20 }, () => 0.02),
      bookAgesMs: Array.from({ length: 20 }, () => 100),
      drawdownCapacityUnits: 10,
      minUniqueSymbols: 4,
    });
    expect(standalone.maxDrawdownPct).toBeCloseTo(8);
    expect(portfolio.maxDrawdownPct).toBeCloseTo(0.8);
  });

  it('uses the same captured L2 rows for runtime and independent promotion evidence', () => {
    const pnlRows = Array.from({ length: 20 }, (_, index) => ({
      net_pnl_pct: index % 4 === 0 ? -0.2 : 0.25,
      side: index % 2 ? 'short' as const : 'long' as const,
      symbol: 'SOL',
      opened_at: index / 19 * 8 * DAY_MS,
      closed_at: index / 19 * 8 * DAY_MS + 60_000,
    }));
    const signalRows = Array.from({ length: 40 }, () => ({
      capture_status: 'captured',
      book_age_ms: 100,
      bid: 99.99,
      ask: 100.01,
      buy_slippage_pct: 0.005,
      sell_slippage_pct: 0.005,
    }));
    const evaluation = evaluateNativeForwardRows(pnlRows, signalRows);
    expect(evaluation.status).toBe('passed');
    expect(evaluation.avgExecutionCostPct).toBeCloseTo(0.03, 6);
    expect(evaluation.p95BookAgeMs).toBe(100);
  });

  it('resumes Shadow after startup capture errors leave the recent health window', () => {
    const pnlRows = Array.from({ length: 20 }, (_, index) => ({
      net_pnl_pct: index % 4 === 0 ? -0.2 : 0.25,
      side: index % 2 ? 'short' as const : 'long' as const,
      symbol: 'SOL',
      opened_at: index / 19 * 8 * DAY_MS,
      closed_at: index / 19 * 8 * DAY_MS + 60_000,
    }));
    const signalRows = [
      ...Array.from({ length: 20 }, () => ({
        capture_status: 'error',
        book_age_ms: null,
        bid: null,
        ask: null,
        buy_slippage_pct: null,
        sell_slippage_pct: null,
      })),
      ...Array.from({ length: 100 }, () => ({
        capture_status: 'captured',
        book_age_ms: 100,
        bid: 99.99,
        ask: 100.01,
        buy_slippage_pct: 0.005,
        sell_slippage_pct: 0.005,
      })),
    ];
    const evaluation = evaluateNativeForwardRows(pnlRows, signalRows);
    expect(evaluation.status).toBe('collecting');
    expect(evaluation.entryAllowed).toBe(true);
    expect(evaluation.captureErrorRatePct).toBeCloseTo(20 / 120 * 100);
    expect(evaluation.recentSignalCount).toBe(100);
    expect(evaluation.recentCaptureErrorRatePct).toBe(0);
    expect(evaluation.reasons).toEqual([
      expect.stringContaining('capture errors'),
    ]);
  });
});

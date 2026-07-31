import { describe, expect, it } from 'vitest';
import {
  evaluateNativeForwardGate,
  evaluateNativeForwardRows,
  estimatedFundingPnlPct,
  pricePnlPct,
  quoteNotionalVwap,
} from '../../src/lib/lighter-luxalgo-math.js';

describe('Lighter LuxAlgo shadow math', () => {
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
      netPcts: Array.from({ length: 19 }, () => -0.2),
      signalCount: 19,
      captureErrors: 19,
      executionCostPcts: [],
      bookAgesMs: [],
    });
    expect(result.status).toBe('collecting');
    expect(result.entryAllowed).toBe(true);
  });

  it('passes a profitable, stable and executable Native forward sample', () => {
    const result = evaluateNativeForwardGate({
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

  it('blocks new entries when capture quality or book freshness fails', () => {
    const result = evaluateNativeForwardGate({
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

  it('does not apply one universal cost ceiling after net PnL already includes execution', () => {
    const result = evaluateNativeForwardGate({
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
      netPcts: [5, -4, -4, ...Array.from({ length: 17 }, () => 0.5)],
      signalCount: 20,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 20 }, () => 0.02),
      bookAgesMs: Array.from({ length: 20 }, () => 100),
    });
    const portfolio = evaluateNativeForwardGate({
      netPcts: [5, -4, -4, ...Array.from({ length: 17 }, () => 0.5)],
      signalCount: 20,
      captureErrors: 0,
      executionCostPcts: Array.from({ length: 20 }, () => 0.02),
      bookAgesMs: Array.from({ length: 20 }, () => 100),
      drawdownCapacityUnits: 10,
    });
    expect(standalone.maxDrawdownPct).toBeCloseTo(8);
    expect(portfolio.maxDrawdownPct).toBeCloseTo(0.8);
  });

  it('uses the same captured L2 rows for runtime and independent promotion evidence', () => {
    const pnlRows = Array.from({ length: 20 }, (_, index) => ({
      net_pnl_pct: index % 4 === 0 ? -0.2 : 0.25,
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
});

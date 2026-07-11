import { describe, expect, it } from 'vitest';
import {
  fitLogPair,
  pairEntryPrices,
  pairExitPrices,
  pairFundingCarryPct,
  pairResidualZ,
  pairTradeGrossPct,
  pairTradeNetPct,
} from '../../src/lib/true-pairs.js';

describe('true two-leg pairs math', () => {
  it('recovers a log-price hedge ratio and standardizes its residual', () => {
    const b = Array.from({ length: 400 }, (_, i) =>
      Math.exp(5 + i * 0.001 + Math.sin(i / 17) * 0.01),
    );
    const a = b.map((price, i) => Math.exp(1 + 1.2 * Math.log(price) + Math.sin(i / 3) * 0.004));
    const fit = fitLogPair(a, b);
    expect(fit).not.toBeNull();
    expect(fit!.beta).toBeCloseTo(1.2, 1);
    expect(fit!.residualStd).toBeGreaterThan(0);
    expect(Number.isFinite(pairResidualZ(a[399]!, b[399]!, fit!))).toBe(true);
  });

  it('nets both legs and normalizes by total gross exposure', () => {
    const gross = pairTradeGrossPct({
      direction: 1,
      beta: 1,
      aEntry: 100,
      aExit: 102,
      bEntry: 100,
      bExit: 101,
    });
    expect(gross).toBeCloseTo(0.5, 8);
    expect(
      pairTradeNetPct(
        { direction: 1, beta: 1, aEntry: 100, aExit: 102, bEntry: 100, bExit: 101 },
        0.09,
      ),
    ).toBeCloseTo(0.41, 8);
  });

  it('mirrors PnL when the spread direction is reversed', () => {
    const longSpread = pairTradeGrossPct({
      direction: 1,
      beta: 1,
      aEntry: 100,
      aExit: 102,
      bEntry: 100,
      bExit: 101,
    });
    const shortSpread = pairTradeGrossPct({
      direction: -1,
      beta: 1,
      aEntry: 100,
      aExit: 102,
      bEntry: 100,
      bExit: 101,
    });
    expect(shortSpread).toBeCloseTo(-longSpread, 10);
  });

  it('rejects invalid prices and mismatched formation series', () => {
    expect(fitLogPair([1, 2], [1])).toBeNull();
    expect(
      pairTradeGrossPct({ direction: 1, beta: 1, aEntry: 0, aExit: 1, bEntry: 1, bExit: 1 }),
    ).toBeNaN();
  });

  it('uses executable BBO sides for both spread directions', () => {
    const a = { bid: 99, ask: 101 };
    const b = { bid: 49, ask: 51 };
    expect(pairEntryPrices(1, a, b)).toEqual({ a: 101, b: 49 });
    expect(pairExitPrices(1, a, b)).toEqual({ a: 99, b: 51 });
    expect(pairEntryPrices(-1, a, b)).toEqual({ a: 99, b: 51 });
    expect(pairExitPrices(-1, a, b)).toEqual({ a: 101, b: 49 });
  });

  it('weights both legs of funding carry by gross exposure', () => {
    expect(
      pairFundingCarryPct({ direction: 1, beta: 1, aRates: [0.0001], bRates: [0.0003] }),
    ).toBeCloseTo(0.01, 10);
    expect(
      pairFundingCarryPct({ direction: -1, beta: 1, aRates: [0.0001], bRates: [0.0003] }),
    ).toBeCloseTo(-0.01, 10);
    expect(pairFundingCarryPct({ direction: 1, beta: 1, aRates: [0.0001], bRates: [] })).toBeNaN();
  });
});

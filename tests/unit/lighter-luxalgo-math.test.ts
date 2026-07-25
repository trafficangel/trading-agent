import { describe, expect, it } from 'vitest';
import {
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
});

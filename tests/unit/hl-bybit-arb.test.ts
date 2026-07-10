import { describe, expect, it } from 'vitest';
import {
  estimatedBasisNetPct,
  estimatedFundingNetPct,
  estimatedRoundTripCostPct,
  totalMarginRoiPct,
  vwap,
} from '../../scripts/scan-hl-bybit-arb.js';

describe('HL <-> Bybit arb economics', () => {
  it('prices a fixed delta through multiple book levels', () => {
    expect(vwap([
      { price: 100, qty: 5 },
      { price: 101, qty: 10 },
    ], 10)).toBeCloseTo(100.5, 8);
    expect(vwap([{ price: 100, qty: 5 }], 10)).toBeNull();
  });

  it('charges four taker fills plus close-cross and safety buffers', () => {
    expect(estimatedRoundTripCostPct(0.10)).toBeCloseTo(0.38, 8);
    expect(estimatedBasisNetPct(1.50, 0.10)).toBeCloseTo(1.12, 8);
  });

  it('keeps a separate basis-risk reserve for projected funding carry', () => {
    expect(estimatedFundingNetPct(0.80, 0.10)).toBeCloseTo(0.17, 8);
  });

  it('computes leverage ROI against margin posted on both venues', () => {
    expect(totalMarginRoiPct(1, 3)).toBeCloseTo(1.5, 8);
    expect(totalMarginRoiPct(-0.2, 5)).toBeCloseTo(-0.5, 8);
  });
});

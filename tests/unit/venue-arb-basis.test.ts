import { describe, expect, it } from 'vitest';
import {
  calibratedVenueArbBasis,
  pairedVenueArbExpectedNetBps,
} from '../../src/lib/venue-arb-basis.js';

describe('venue arb basis calibration', () => {
  it('measures deviation from an established route baseline', () => {
    const samples = Array.from({ length: 180 }, (_, index) => ({
      at: (index + 1) * 1_000,
      bps: index === 40 ? 200 : 20,
    }));
    expect(calibratedVenueArbBasis(samples, 181_000, 31, {
      windowMs: 180_000,
      excludeMs: 5_000,
      minSamples: 120,
      minSpanMs: 120_000,
    })).toEqual({
      baselineBps: 20,
      deviationBps: 11,
      samples: 176,
      spanMs: 175_000,
    });
  });

  it('refuses to signal before the baseline has enough history', () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({
      at: (index + 1) * 1_000,
      bps: 20,
    }));
    expect(calibratedVenueArbBasis(samples, 61_000, 31, {
      windowMs: 180_000,
      excludeMs: 5_000,
      minSamples: 120,
      minSpanMs: 120_000,
    })).toBeNull();
  });

  it('prices all four fills through the opposite executable baseline', () => {
    expect(pairedVenueArbExpectedNetBps(25, -8, 7)).toBe(10);
    expect(pairedVenueArbExpectedNetBps(12, -8, 7)).toBe(-3);
    expect(
      pairedVenueArbExpectedNetBps(Number.NaN, -8, 7),
    ).toBe(Number.NEGATIVE_INFINITY);
  });
});

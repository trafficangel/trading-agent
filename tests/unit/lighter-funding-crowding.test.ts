import { describe, expect, it } from 'vitest';
import {
  completedFundingZScore,
  fundingCrowdingSide,
} from '../../src/lib/lighter-funding-crowding.js';
import { buildLighterFundingSeries } from '../../src/lib/lighter-funding-history.js';

const HOUR = 3_600_000;

describe('funding crowding signal', () => {
  it('is symmetric and requires both funding and price extremes', () => {
    expect(fundingCrowdingSide(-2.1, -2.3)).toBe('long');
    expect(fundingCrowdingSide(2.1, 2.3)).toBe('short');
    expect(fundingCrowdingSide(2.1, -2.3)).toBeNull();
    expect(fundingCrowdingSide(1.9, 2.3)).toBeNull();
  });

  it('excludes the current settlement from its own normalization', () => {
    const points = Array.from({ length: 170 }, (_, index) => ({
      timestampMs: (index + 1) * HOUR,
      ratePctH: index % 2 === 0 ? 0.001 : 0.003,
      direction: 'long' as const,
    }));
    points[168] = { timestampMs: 169 * HOUR, ratePctH: 0.01, direction: 'long' };
    const series = buildLighterFundingSeries(points);
    const result = completedFundingZScore([168 * HOUR], 60, series, 168);
    expect(result[0]).toBeCloseTo(8, 8);
  });

  it('does not let future settlements alter an earlier candle', () => {
    const points = Array.from({ length: 190 }, (_, index) => ({
      timestampMs: (index + 1) * HOUR,
      ratePctH: index % 2 === 0 ? 0.001 : 0.003,
      direction: index % 3 === 0 ? 'short' as const : 'long' as const,
    }));
    const candles = Array.from({ length: 20 }, (_, index) => (168 + index) * HOUR);
    const before = completedFundingZScore(
      candles,
      60,
      buildLighterFundingSeries(points),
      168,
    );
    points[185] = { timestampMs: 186 * HOUR, ratePctH: 0.5, direction: 'long' };
    const after = completedFundingZScore(
      candles,
      60,
      buildLighterFundingSeries(points),
      168,
    );
    expect(after.slice(0, 16)).toEqual(before.slice(0, 16));
  });
});

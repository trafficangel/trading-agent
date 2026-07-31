import { describe, expect, it } from 'vitest';
import {
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  lighterFundingPnlPct,
} from '../../src/lib/lighter-funding-history.js';

const HOUR = 3_600_000;

describe('lighter funding history', () => {
  it('normalizes, sorts and deduplicates hourly settlements', () => {
    const series = buildLighterFundingSeries([
      { timestampMs: 2 * HOUR, ratePctH: 0.002, direction: 'short' },
      { timestampMs: HOUR, ratePctH: 0.001, direction: 'long' },
      { timestampMs: HOUR, ratePctH: 0.0015, direction: 'long' },
    ]);
    expect(series.timestampsMs).toEqual([HOUR, 2 * HOUR]);
    expect(series.longPayerPrefixPct).toEqual([0, 0.0015, -0.0005]);
  });

  it('applies exact settlements in (entry, exit] with the correct side sign', () => {
    const series = buildLighterFundingSeries([
      { timestampMs: HOUR, ratePctH: 0.001, direction: 'long' },
      { timestampMs: 2 * HOUR, ratePctH: 0.002, direction: 'long' },
      { timestampMs: 3 * HOUR, ratePctH: 0.003, direction: 'short' },
    ]);
    expect(lighterFundingPnlPct(series, 'long', HOUR, 3 * HOUR)).toBeCloseTo(0.001);
    expect(lighterFundingPnlPct(series, 'short', HOUR, 3 * HOUR)).toBeCloseTo(-0.001);
  });

  it('fails coverage when history is late, stale or internally gapped', () => {
    const complete = buildLighterFundingSeries([
      { timestampMs: HOUR, ratePctH: 0.001, direction: 'long' },
      { timestampMs: 2 * HOUR, ratePctH: 0.001, direction: 'long' },
      { timestampMs: 3 * HOUR, ratePctH: 0.001, direction: 'long' },
    ]);
    expect(fundingSeriesCoverage(complete, 0, 4 * HOUR).covered).toBe(true);

    const gapped = buildLighterFundingSeries([
      { timestampMs: HOUR, ratePctH: 0.001, direction: 'long' },
      { timestampMs: 3 * HOUR, ratePctH: 0.001, direction: 'long' },
    ]);
    expect(fundingSeriesCoverage(gapped, 0, 4 * HOUR).covered).toBe(false);
  });
});

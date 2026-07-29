import { describe, expect, it } from 'vitest';
import {
  leadLagResidualBps,
  leadLagReturnBps,
  lighterRoundTripNetBps,
  summarizeLeadLag,
  topLevelDepthUsd,
} from '../../src/lib/lighter-leadlag.js';

describe('Lighter lead-lag math', () => {
  it('measures the leader move not yet reflected by the target', () => {
    expect(leadLagResidualBps(101, 100, 100.4, 100)).toBeCloseTo(60, 8);
    expect(leadLagReturnBps(101, 100)).toBeCloseTo(100, 8);
  });

  it('uses executable target sides and subtracts the execution buffer', () => {
    expect(lighterRoundTripNetBps('long', 100, 100.1, 1)).toBeCloseTo(9, 8);
    expect(lighterRoundTripNetBps('short', 100, 99.9, 1)).toBeCloseTo(
      9.01001001,
      8,
    );
  });

  it('rejects invalid prices and computes top-level capacity', () => {
    expect(leadLagResidualBps(0, 100, 100, 100)).toBeNull();
    expect(lighterRoundTripNetBps('long', 0, 100, 1)).toBeNull();
    expect(topLevelDepthUsd(100, 2.5)).toBe(250);
    expect(topLevelDepthUsd(100, 0)).toBe(0);
  });

  it('summarizes net outcomes and drawdown in chronological order', () => {
    expect(summarizeLeadLag([
      { netBps: 3, passed: true },
      { netBps: -1, passed: false },
      { netBps: 2, passed: true },
      { netBps: -4, passed: false },
    ])).toEqual({
      samples: 4,
      wins: 2,
      winRatePct: 50,
      netBps: 0,
      averageNetBps: 0,
      medianNetBps: 0.5,
      profitFactor: 1,
      maxDrawdownBps: 4,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  evaluateNativeRunnerLiveness,
  nativeRsiWaitingReason,
  nativeWaitingReason,
  parseNativeRunnerStatus,
  type NativeRunnerStatus,
} from '../../src/lib/lighter-native-runner-status.js';

describe('nativeWaitingReason', () => {
  it('distinguishes an ordinary inside-band wait from a missing signal path', () => {
    expect(nativeWaitingReason({
      mode: 'touch',
      threshold: 2.5,
      previousZ: 0.2,
      currentZ: 1.1,
      close: 100,
    })).toBe('z_inside_threshold');
  });

  it('explains a statistically valid long that the trend stack blocks', () => {
    expect(nativeWaitingReason({
      mode: 'touch',
      threshold: 2.5,
      previousZ: -2.2,
      currentZ: -3.1,
      close: 99,
      trendMean: 100,
      slowTrendMean: 98,
    })).toBe('long_trend_stack_not_aligned');
  });

  it('explains a statistically valid short that the trend stack blocks', () => {
    expect(nativeWaitingReason({
      mode: 'touch',
      threshold: 2.5,
      previousZ: 2.2,
      currentZ: 3.1,
      close: 101,
      trendMean: 100,
      slowTrendMean: 102,
    })).toBe('short_trend_stack_not_aligned');
  });

  it('reports that a reclaim rule is still outside and waiting to cross back', () => {
    expect(nativeWaitingReason({
      mode: 'reclaim',
      threshold: 3,
      previousZ: -3.3,
      currentZ: -3.1,
      close: 90,
    })).toBe('waiting_reclaim');
  });
});

describe('nativeRsiWaitingReason', () => {
  it('distinguishes an ordinary RSI wait from a trend-blocked extreme', () => {
    expect(nativeRsiWaitingReason({
      level: 25,
      currentRsi: 50,
      close: 100,
      trendMean: 99,
    })).toBe('rsi_inside_threshold');
    expect(nativeRsiWaitingReason({
      level: 25,
      currentRsi: 20,
      close: 98,
      trendMean: 99,
    })).toBe('long_trend_not_aligned');
  });
});

describe('parseNativeRunnerStatus', () => {
  const valid: NativeRunnerStatus = {
    version: 1,
    heartbeatAt: 2_000,
    targetBarTime: 1_500,
    evaluations: [{
      strategyId: 'z60stack25-btc',
      symbol: 'BTCUSDT',
      marketId: 1,
      timeframeMinutes: 5,
      family: 'zscore',
      mode: 'touch',
      threshold: 2.5,
      trendFilter: 'ema200_400',
      attemptedBarTime: 1_500,
      barTime: 1_500,
      evaluatedAt: 1_700,
      state: 'waiting',
      reason: 'z_inside_threshold',
      side: null,
      close: 65_000,
      mean: 64_900,
      previousZ: 0.1,
      currentZ: 0.2,
      trendMean: 63_000,
      slowTrendMean: 62_000,
      efficiencyRatio60: 0.3,
      previousRsi: null,
      currentRsi: null,
      secondaryOscillator: null,
      error: null,
    }],
  };

  it('accepts a complete versioned heartbeat', () => {
    expect(parseNativeRunnerStatus(JSON.stringify(valid))).toEqual(valid);
  });

  it('fails closed on a malformed state instead of showing a false green runner', () => {
    expect(parseNativeRunnerStatus(JSON.stringify({ ...valid, heartbeatAt: 'now' }))).toBeNull();
    expect(parseNativeRunnerStatus('{')).toBeNull();
  });

  it('accepts 1m evaluations and defaults legacy rows to 5m', () => {
    const oneMinute = {
      ...valid,
      evaluations: [{ ...valid.evaluations[0]!, timeframeMinutes: 1 as const }],
    };
    expect(parseNativeRunnerStatus(JSON.stringify(oneMinute))?.evaluations[0]?.timeframeMinutes)
      .toBe(1);
    const legacy = {
      ...valid,
      evaluations: valid.evaluations.map(({ timeframeMinutes: _timeframe, ...row }) => row),
    };
    expect(parseNativeRunnerStatus(JSON.stringify(legacy))?.evaluations[0]?.timeframeMinutes)
      .toBe(5);
  });

  it('requires a fresh successful evaluation for every promoted strategy', () => {
    const result = evaluateNativeRunnerLiveness(valid, ['z60stack25-btc'], 2_050);
    expect(result.passed).toBe(true);
    expect(result.healthyStrategyIds).toEqual(['z60stack25-btc']);
  });

  it('fails closed on stale heartbeat, missing rows and latest-bar errors', () => {
    expect(evaluateNativeRunnerLiveness(valid, ['z60stack25-btc'], 100_000).passed)
      .toBe(false);
    expect(evaluateNativeRunnerLiveness(valid, ['missing'], 2_050).reasons)
      .toEqual([expect.stringContaining('missing or duplicated')]);
    const failed = {
      ...valid,
      evaluations: [{
        ...valid.evaluations[0]!,
        state: 'data_error' as const,
        barTime: 1_200,
        error: 'gap',
      }],
    };
    expect(evaluateNativeRunnerLiveness(failed, ['z60stack25-btc'], 2_050).reasons)
      .toEqual([expect.stringContaining('latest attempted bar was not evaluated')]);
  });
});

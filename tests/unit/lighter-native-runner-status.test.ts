import { describe, expect, it } from 'vitest';
import {
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
});

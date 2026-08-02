import { describe, expect, it } from 'vitest';
import {
  assertNativeStandaloneLifecycle,
  isRetiredNativeStrategy,
  NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS,
} from '../../src/lib/lighter-native-strategy-lifecycle.js';

describe('Native Quant standalone lifecycle', () => {
  it('keeps the executable cohort canonical and APT retired', () => {
    expect(() => assertNativeStandaloneLifecycle(
      NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS,
    )).not.toThrow();
    expect(isRetiredNativeStrategy('apt-rsi14-pullback-ema400')).toBe(true);
    expect(NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS)
      .not.toContain('apt-rsi14-pullback-ema400');
  });

  it('fails closed on a missing, duplicate or retired executable strategy', () => {
    expect(() => assertNativeStandaloneLifecycle(
      NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS.slice(1),
    )).toThrow('runner/lifecycle mismatch');
    expect(() => assertNativeStandaloneLifecycle([
      ...NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS,
      NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS[0],
    ])).toThrow('runner/lifecycle mismatch');
    expect(() => assertNativeStandaloneLifecycle([
      ...NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS.slice(1),
      'apt-rsi14-pullback-ema400',
    ])).toThrow('runner/lifecycle mismatch');
  });
});

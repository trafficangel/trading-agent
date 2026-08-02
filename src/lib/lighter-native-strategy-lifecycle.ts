/**
 * Canonical lifecycle registry for standalone Native Quant strategies.
 *
 * The executable runner, public lab and independent promotion audit must use
 * the same active cohort. Retired strategies remain addressable for archived
 * trade history but can never silently re-enter the signal path.
 */
export const NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS = [
  'hype-vwz60-touch',
  'hype-bb20-willr14-reclaim-ema400-challenger',
  'hype-rsi14-willr14-ema400-challenger',
  'hype-vwz60-stoch14-ema400-challenger',
  'xlm-vwz60-touch-er25',
  'xlm-vwz60-willr14-ema400-challenger',
  'zec-rsi14-willr14-ema400',
  'zec-vwz60-mfi14-ema400-challenger',
] as const;

export const NATIVE_RETIRED_STRATEGY_IDS = [
  'sol-z60-reclaim',
  'sol-z60-touch',
  'bnb-z60-touch',
  'ltc-z60-touch',
  'hype-rsi14-willr14-ema400',
  'xlm-vwz60-mfi14-ema400',
  'data-vwz60-mfi14-ema400',
  'btc-vwz60-touch',
  'xrp-vwz60-touch',
  'data-vwz60-touch',
  'dot-rsi14-pullback-ema400',
  'apt-rsi14-pullback-ema400',
] as const;

const active = new Set<string>(NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS);
const retired = new Set<string>(NATIVE_RETIRED_STRATEGY_IDS);

export function assertNativeStandaloneLifecycle(
  executableIds: readonly string[],
): void {
  const actual = [...new Set(executableIds)].sort();
  const expected = [...active].sort();
  if (
    actual.length !== executableIds.length
    || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `Native standalone runner/lifecycle mismatch: expected ${expected.join(',')}; got ${actual.join(',')}`,
    );
  }
  const overlap = expected.filter((strategyId) => retired.has(strategyId));
  if (overlap.length) {
    throw new Error(`Native lifecycle active/retired overlap: ${overlap.join(',')}`);
  }
}

export function isRetiredNativeStrategy(strategyId: string): boolean {
  return retired.has(strategyId);
}

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

/** Frozen two-sided Z60 portfolio cohorts that collect independent forward evidence. */
export const NATIVE_P2_PORTFOLIO_STRATEGY_IDS = [
  'z60stack25-btc', 'z60stack25-eth', 'z60stack25-sol',
  'z60stack25-bnb', 'z60stack25-ltc', 'z60stack25-hype',
  'z60stack25-zec', 'z60stack25-doge', 'z60stack25-near',
  'z60stack25-jup', 'z60stack25-lit', 'z60stack25-gram',
  'z60stack25-xmr', 'z60stack25-ena', 'z60stack25-tao',
] as const;

export const NATIVE_P3_PORTFOLIO_STRATEGY_IDS = [
  'z60stack25p3-btc', 'z60stack25p3-eth', 'z60stack25p3-sol',
  'z60stack25p3-hype', 'z60stack25p3-zec', 'z60stack25p3-doge',
  'z60stack25p3-near', 'z60stack25p3-jup', 'z60stack25p3-gram',
  'z60stack25p3-xmr',
] as const;

/**
 * Every Native strategy whose closed Shadow rows require exact Lighter funding.
 * Retired IDs remain in scope so historical rows can still be reconciled.
 */
export const NATIVE_FUNDING_RECONCILIATION_STRATEGY_IDS = [
  ...NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS,
  ...NATIVE_RETIRED_STRATEGY_IDS,
  ...NATIVE_P2_PORTFOLIO_STRATEGY_IDS,
  ...NATIVE_P3_PORTFOLIO_STRATEGY_IDS,
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

export function assertNativePortfolioLifecycle(
  executableP2Ids: readonly string[],
  executableP3Ids: readonly string[],
): void {
  for (const [label, actualIds, expectedIds] of [
    ['P2', executableP2Ids, NATIVE_P2_PORTFOLIO_STRATEGY_IDS],
    ['P3', executableP3Ids, NATIVE_P3_PORTFOLIO_STRATEGY_IDS],
  ] as const) {
    const actual = [...new Set(actualIds)].sort();
    const expected = [...expectedIds].sort();
    if (
      actual.length !== actualIds.length
      || actual.length !== expected.length
      || actual.some((value, index) => value !== expected[index])
    ) {
      throw new Error(
        `Native ${label} runner/lifecycle mismatch: expected ${expected.join(',')}; got ${actual.join(',')}`,
      );
    }
  }
}

export function isRetiredNativeStrategy(strategyId: string): boolean {
  return retired.has(strategyId);
}

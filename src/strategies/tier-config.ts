/**
 * TRACK E — Tier-Based Autotrading (May 21, 2026).
 *
 * Tier system replaces manual /account/strategies selection. User
 * connects a Bybit key, we read balance, auto-assign one of 5 tiers,
 * activate the right strategies with computed margin/leverage.
 *
 * Margin-based model (per audit decision):
 *   - Tier defines a TOTAL margin pool (sum of margin across all
 *     simultaneously-open positions).
 *   - Pool is distributed equally across enabled strategies for the
 *     tier: margin_per_trade = marginPoolUsd / N_strategies.
 *   - Each strategy uses its own `maxSafeLeverage` (computed from
 *     slPct in track-c-config.ts) to derive notional:
 *       notional = margin_per_trade × strategy.maxSafeLeverage
 *   - This way tight-SL strategies (BCH 3.5%, BTC 4%) get high leverage
 *     and large notional; wide-SL strategies (XRP 15%) get low leverage
 *     and small notional. Risk per trade stays bounded by SL × notional.
 *
 * Liquidation is structurally impossible: leverage × (slPct + 0.02
 * slippage) ≤ 0.70, so safety SL always fires BEFORE Bybit-side
 * liquidation. 30% margin buffer.
 *
 * Auto-assignment lifecycle:
 *   1. /account/api-key successful verify → matchTier(balance) → assignTier
 *   2. balance-monitor cron (5 min) → evaluateTierTransition:
 *      - downgrade: auto after 72h continuous below
 *      - upgrade: prompt user, manual confirmation + prorated billing
 *
 * VIP override: plan='vip' users can bypass tier logic entirely via
 * tier_override_strategies / tier_override_margin / tier_override_leverage
 * columns. Operator (me) + Eldar are seeded into VIP with their current
 * manual settings preserved.
 */

import { STRATEGY_CONFIGS } from './track-c-config.js';

export type TierId = 'starter' | 'standard' | 'plus' | 'pro' | 'vip' | 'prof';

export type TierConfig = {
  id: TierId;
  /** Display name in UI / Telegram alerts. */
  name: string;
  /** Min/max balance for tier eligibility (USDT). Vip max is Infinity. */
  minBalanceUsdt: number;
  maxBalanceUsdt: number;
  /** Subscription price per month (USD). */
  monthlyPriceUsd: number;
  /** Strategy IDs (from STRATEGY_CONFIGS keys) included in this tier.
   *  Must all have tierEligible:true. VIP gets all eligible by default
   *  but can be overridden per-user via tier_override_strategies. */
  strategyIds: string[];
  /** Total margin pool in USD — sum across all simultaneously-open
   *  positions. Distributed equally: margin/trade = pool / N_strategies. */
  marginPoolUsd: number;
  /** Hard cap on simultaneously-open positions. Belt-and-braces with
   *  pool size: even if margin allows more, this stops concentration. */
  maxConcurrentPositions: number;
  /** Range of expected monthly PnL in USD (low/high). Used for cabinet
   *  display + landing. Calculated by combining backtest PnL per $1000
   *  with the computed notional per strategy and applying ±30% range. */
  expectedMonthlyPnlRangeUsd: { low: number; high: number };
  /** Stated max drawdown for marketing — user explicitly accepts this
   *  when signing up to the tier. Computed from worst-case scenarios
   *  in backtest aggregation. */
  expectedMaxDdPct: number;
  /** Free-text marketing one-liner for the landing tier-card. */
  pitch: string;
};

export const TIER_CONFIGS: Record<TierId, TierConfig> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    minBalanceUsdt: 300,
    maxBalanceUsdt: 799,
    monthlyPriceUsd: 12,
    // 3 low-band strategies (tight SL, safe leverage).
    strategyIds: ['bnb-cntr-tt-mf50', 'btc-cfm-strong-tst', 'bch-cntr-cfm-tc'],
    // Pool 12% of min-depo $500 ≈ $60. Conservative for newcomers.
    marginPoolUsd: 60,
    maxConcurrentPositions: 2,
    expectedMonthlyPnlRangeUsd: { low: 50, high: 80 },
    expectedMaxDdPct: 8,
    pitch: 'Тариф для знакомства с автотрейдингом. Маленькие сделки, минимальный риск, понятный результат.',
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    minBalanceUsdt: 800,
    maxBalanceUsdt: 2499,
    monthlyPriceUsd: 35,
    // +XRP (high band, but worth it).
    strategyIds: ['bnb-cntr-tt-mf50', 'btc-cfm-strong-tst', 'bch-cntr-cfm-tc', 'xrp-cntr-tc-mf50'],
    // Pool 20% of min-depo $1000 = $200.
    marginPoolUsd: 200,
    maxConcurrentPositions: 3,
    expectedMonthlyPnlRangeUsd: { low: 150, high: 240 },
    expectedMaxDdPct: 15,
    pitch: 'Самый популярный выбор. Больше монет в работе, больше сделок, заметный доход в месяц.',
  },
  plus: {
    id: 'plus',
    name: 'Plus',
    minBalanceUsdt: 2500,
    maxBalanceUsdt: 5999,
    monthlyPriceUsd: 90,
    // +TRX (5th strategy).
    strategyIds: [
      'bnb-cntr-tt-mf50',
      'btc-cfm-strong-tst',
      'bch-cntr-cfm-tc',
      'xrp-cntr-tc-mf50',
      'trx-cfm-tt-wc',
    ],
    // Pool 20% of $3000 = $600.
    marginPoolUsd: 600,
    maxConcurrentPositions: 4,
    expectedMonthlyPnlRangeUsd: { low: 390, high: 580 },
    expectedMaxDdPct: 18,
    pitch: 'Полный портфель монет в работе. Хороший выбор когда депозит уже серьёзный, а время — нет.',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    minBalanceUsdt: 6000,
    maxBalanceUsdt: 14999,
    monthlyPriceUsd: 235,
    // Same 5 strategies as Plus, larger margin pool.
    strategyIds: [
      'bnb-cntr-tt-mf50',
      'btc-cfm-strong-tst',
      'bch-cntr-cfm-tc',
      'xrp-cntr-tc-mf50',
      'trx-cfm-tt-wc',
    ],
    // Pool 20% of $8000 = $1600.
    marginPoolUsd: 1600,
    maxConcurrentPositions: 5,
    expectedMonthlyPnlRangeUsd: { low: 1000, high: 1500 },
    expectedMaxDdPct: 18,
    pitch: 'Тот же портфель монет, но сделки больше — пропорционально вашему депозиту растёт и заработок.',
  },
  vip: {
    id: 'vip',
    name: 'VIP',
    minBalanceUsdt: 15000,
    maxBalanceUsdt: Number.POSITIVE_INFINITY,
    monthlyPriceUsd: 580,
    // Default: same 5 strategies. VIP users can override to include
    // TON/UNI/HBAR via tier_override_strategies (operator decides).
    strategyIds: [
      'bnb-cntr-tt-mf50',
      'btc-cfm-strong-tst',
      'bch-cntr-cfm-tc',
      'xrp-cntr-tc-mf50',
      'trx-cfm-tt-wc',
    ],
    // Pool 20% of $20000 = $4000.
    marginPoolUsd: 4000,
    maxConcurrentPositions: 5,
    expectedMonthlyPnlRangeUsd: { low: 2500, high: 4000 },
    expectedMaxDdPct: 18,
    pitch: 'Премиум: персональная настройка через оператора, гибкие условия (success-fee вместо фиксированной подписки).',
  },
  // Phase K — Pro Manual («Prof»). Special tier for experienced users who
  // want full control. ALL 8 strategies eligible (including the wide-SL
  // ones: UNI/TON/HBAR). marginPoolUsd here is a SUGGESTED starting point;
  // each user_strategies row's notional+leverage is user-editable on
  // /account/strategies. Balance gate + auto-downgrade are bypassed —
  // user is on their own (with explicit «I know what I'm doing» disclaimer
  // at activation time). minBalanceUsdt = $300 is the hard global floor
  // for autotrading economics, not a tier-specific limit.
  prof: {
    id: 'prof',
    name: 'Prof',
    minBalanceUsdt: 300,
    maxBalanceUsdt: Number.POSITIVE_INFINITY,
    monthlyPriceUsd: 99,
    strategyIds: [
      'bnb-cntr-tt-mf50',
      'btc-cfm-strong-tst',
      'bch-cntr-cfm-tc',
      'xrp-cntr-tc-mf50',
      'trx-cfm-tt-wc',
      'uni-cfm-tc-tst',
      'ton-cntr-cfm-neo',
      'hbar-cntr-tsr-scfl',
    ],
    // Suggested pool — user can override per-strategy notional after activation.
    marginPoolUsd: 200,
    maxConcurrentPositions: 8,
    // No PnL estimate — depends entirely on user's chosen sizes.
    expectedMonthlyPnlRangeUsd: { low: 0, high: 0 },
    expectedMaxDdPct: 100, // sentinel: «no platform-promised cap, user owns risk»
    pitch: 'Для опытных трейдеров. Все 8 стратегий доступны, размер позиции и плечо настраиваете вручную. Платформа не контролирует ваш баланс и не предлагает down/upgrade — вы сами принимаете риски.',
  },
};

/** Ordered list of tiers from cheapest to most expensive. Used in UI
 *  for landing pricing-table + admin stats grouping. */
export const TIER_ORDER: TierId[] = ['starter', 'standard', 'plus', 'pro', 'vip', 'prof'];

/** Below this balance no tier is assigned — user is asked to top up. */
export const MIN_AUTOTRADING_DEPOSIT_USDT = 300;

/**
 * Map a Bybit USDT balance to a tier. Returns null when balance is
 * below the minimum for any tier — caller shows «top up to $300+».
 *
 * Boundary semantics: ≥ min, ≤ max. No overlap between adjacent tiers.
 */
/** Tiers that participate in balance-based auto-suggest/auto-downgrade.
 *  Excludes 'prof' which is opt-in only and bypasses the balance loop. */
const BALANCE_BASED_TIERS: TierId[] = ['starter', 'standard', 'plus', 'pro', 'vip'];

export function matchTier(balanceUsdt: number): TierId | null {
  if (balanceUsdt < MIN_AUTOTRADING_DEPOSIT_USDT) return null;
  for (const id of BALANCE_BASED_TIERS) {
    const t = TIER_CONFIGS[id];
    if (balanceUsdt >= t.minBalanceUsdt && balanceUsdt <= t.maxBalanceUsdt) return id;
  }
  // Above VIP max (Infinity) — defensive fallback. Should never hit.
  return 'vip';
}

export function getTier(id: TierId): TierConfig {
  return TIER_CONFIGS[id];
}

export function listTiers(): TierConfig[] {
  return TIER_ORDER.map((id) => TIER_CONFIGS[id]);
}

/** List of coin tickers (e.g. "BTC, BNB, BCH") used by strategies in this
 *  tier. Used in UI to make "3 стратегий" concrete: tells the user
 *  exactly which crypto-assets will be traded on their account. */
export function tierCoinTickers(tierId: TierId): string[] {
  const tier = TIER_CONFIGS[tierId];
  if (!tier) return [];
  return tier.strategyIds
    .map((sid) => STRATEGY_CONFIGS[sid]?.symbol ?? '')
    .filter(Boolean)
    .map((sym) => sym.replace(/USDT$/, ''));
}

/**
 * Compute the (margin per trade, notional) for a given strategy under
 * a given tier. Returns null if the strategy isn't in tier.strategyIds
 * or the strategy is missing maxSafeLeverage.
 */
export function computeTierTradeSize(
  tierId: TierId,
  strategyId: string,
): { marginUsd: number; leverage: number; notionalUsd: number } | null {
  const tier = TIER_CONFIGS[tierId];
  if (!tier.strategyIds.includes(strategyId)) return null;
  const strategy = STRATEGY_CONFIGS[strategyId];
  if (!strategy?.maxSafeLeverage) return null;
  const marginUsd = tier.marginPoolUsd / tier.strategyIds.length;
  const leverage = strategy.maxSafeLeverage;
  const notionalUsd = marginUsd * leverage;
  return { marginUsd, leverage, notionalUsd };
}

/**
 * Compute expected monthly PnL for a user on a given tier, by summing
 * each strategy's backtest PnL-per-$1000 scaled to the tier's notional.
 * Returns the same range published in tier.expectedMonthlyPnlRangeUsd
 * but freshly derived — useful for sanity-checking when strategies
 * are added/removed from a tier.
 */
export function computeExpectedMonthlyPnl(tierId: TierId): {
  point: number;
  low: number;
  high: number;
} {
  const tier = TIER_CONFIGS[tierId];
  let total = 0;
  for (const sid of tier.strategyIds) {
    const sz = computeTierTradeSize(tierId, sid);
    if (!sz) continue;
    const bt = STRATEGY_CONFIGS[sid]?.backtest;
    if (!bt) continue;
    // backtest.netPnlUsd is total for periodDays at notional bt.notionalUsd.
    // Scale to monthly + to tier notional.
    const monthlyAtBacktestNotional = (bt.netPnlUsd * 30) / bt.periodDays;
    const pnlPerDollar = monthlyAtBacktestNotional / bt.notionalUsd;
    total += pnlPerDollar * sz.notionalUsd;
  }
  return {
    point: Math.round(total),
    low: Math.round(total * 0.7),
    high: Math.round(total * 1.3),
  };
}

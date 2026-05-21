/**
 * Margin accounting for Track D users.
 *
 * Three numbers a user needs to see at a glance:
 *   - balance:   USDT available on their Bybit Unified Trading Account
 *   - required:  Σ(notional/leverage) across every ENABLED strategy
 *                (worst-case: if every strategy fires at once)
 *   - used:      Σ(bybit_qty × bybit_avg_price / leverage) across active
 *                positions — how much margin is currently locked
 *
 * Derived:
 *   - free = balance - used
 *   - deficit = required - free (positive → not enough to cover next
 *               concurrent signal-set, banner shown + flag eventually
 *               set by the balance-monitor cron)
 *
 * Why required is computed worst-case (every strategy at once) rather
 * than "the one currently firing": the user enables N strategies and
 * expects ALL of them to be tradeable. If a strategy fires when only
 * (N-1) margin is available, we skip it silently and the user is
 * confused. Showing the worst-case lets them top up proactively.
 */

import { db } from '../db/client.js';
import { sumEnabledRequiredMargin } from '../db/repos/user-strategies.js';
import { findActiveKey } from '../db/repos/user-api-keys.js';
import type { ApiKeyRow } from '../db/repos/user-api-keys.js';

export type MarginState = {
  /** Last known USDT-equivalent balance from /v5/account/wallet-balance.
   *  Null if no key connected or no successful verify yet. */
  balanceUsdt: number | null;
  /** Sum across enabled strategies (worst-case concurrent signal). */
  requiredUsdt: number;
  /** Sum across active user_decisions (margin currently locked). */
  usedUsdt: number;
  /** balance - used; null when balance unknown. */
  freeUsdt: number | null;
  /** required - free; positive number means user is short on margin.
   *  Null when balance unknown. */
  deficitUsdt: number | null;
  /** Stale flag bookkeeping — copied from the api-key row. */
  insufficientBalanceAt: number | null;
};

/** SUM of margin locked by currently-open user positions. We pull
 *  bybit_qty × bybit_avg_price (real fill notional) ÷ leverage from
 *  the user_strategy that originated each decision. */
const sumUsedStmt = db.prepare<[number], { total: number | null }>(`
  SELECT SUM((d.bybit_qty * d.bybit_avg_price) / NULLIF(us.leverage, 0)) AS total
    FROM decisions d
    LEFT JOIN user_strategies us
           ON us.user_id = d.user_id AND us.strategy_id = d.strategy_id
   WHERE d.user_id = ? AND d.status = 'active' AND d.track = 'strategy'
     AND d.bybit_qty IS NOT NULL AND d.bybit_avg_price IS NOT NULL
`);

export function sumUsedMargin(userId: number): number {
  const r = sumUsedStmt.get(userId);
  return r?.total ?? 0;
}

/** Build the full margin snapshot. Pure read — never touches Bybit, only
 *  consults the cached `last_balance_usdt` on the api-key row. Cron
 *  refreshes that cache; see src/jobs/balance-monitor.ts. */
export function computeMarginState(userId: number): MarginState {
  const key: ApiKeyRow | null = findActiveKey(userId);
  const balance = key && !key.revoked_at ? key.last_balance_usdt : null;
  const required = sumEnabledRequiredMargin(userId);
  const used = sumUsedMargin(userId);
  const free = balance !== null ? balance - used : null;
  const deficit = free !== null ? Math.max(0, required - free) : null;
  return {
    balanceUsdt: balance,
    requiredUsdt: required,
    usedUsdt: used,
    freeUsdt: free,
    deficitUsdt: deficit,
    insufficientBalanceAt: key?.insufficient_balance_at ?? null,
  };
}

/** True when the user is currently considered "trading blocked" due to
 *  margin shortfall. Either explicit flag OR computed deficit > 0.
 *  Used by the dashboard banner + by fan-out as the soft pre-flight. */
export function isMarginInsufficient(userId: number): boolean {
  const state = computeMarginState(userId);
  if (state.insufficientBalanceAt) return true;
  if (state.deficitUsdt !== null && state.deficitUsdt > 0) return true;
  return false;
}

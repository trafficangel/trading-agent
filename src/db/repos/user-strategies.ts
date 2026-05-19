/**
 * user_strategies repo — per-user strategy selection, deposit, leverage.
 *
 * Each row links one user to one strategy with their chosen notional
 * (USDT per entry) and leverage (Bybit margin multiplier). The fan-out
 * in strategy-trader selects all rows with enabled=1 and a valid
 * subscription/key.
 */

import { db } from '../client.js';

export type UserStrategyRow = {
  id: number;
  user_id: number;
  strategy_id: string;
  enabled: 0 | 1;
  notional_usd: number;
  leverage: number;
  enabled_at: number;
  disabled_at: number | null;
  created_at: number;
  updated_at: number;
};

const upsertStmt = db.prepare(`
  INSERT INTO user_strategies
    (user_id, strategy_id, enabled, notional_usd, leverage, enabled_at, created_at, updated_at)
  VALUES (?, ?, 1, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, strategy_id) DO UPDATE SET
    enabled = 1,
    notional_usd = excluded.notional_usd,
    leverage = excluded.leverage,
    enabled_at = excluded.enabled_at,
    disabled_at = NULL,
    updated_at = excluded.updated_at
`);

const disableStmt = db.prepare(`
  UPDATE user_strategies
     SET enabled = 0, disabled_at = ?, updated_at = ?
   WHERE user_id = ? AND strategy_id = ?
`);

const findByUserStmt = db.prepare<[number], UserStrategyRow>(`
  SELECT * FROM user_strategies WHERE user_id = ? ORDER BY enabled DESC, strategy_id ASC
`);

const findEnabledByStrategyStmt = db.prepare<[string], UserStrategyRow>(`
  SELECT * FROM user_strategies WHERE strategy_id = ? AND enabled = 1
`);

const findOneStmt = db.prepare<[number, string], UserStrategyRow>(`
  SELECT * FROM user_strategies WHERE user_id = ? AND strategy_id = ? LIMIT 1
`);

/** Enable a strategy for a user (or update notional/leverage if already enabled). */
export function enableUserStrategy(input: {
  userId: number;
  strategyId: string;
  notionalUsd: number;
  leverage: number;
}): void {
  if (input.notionalUsd < 10) {
    throw new Error('notional must be >= 10 USDT');
  }
  if (input.leverage < 1 || input.leverage > 100) {
    throw new Error('leverage must be in [1, 100]');
  }
  const now = Date.now();
  upsertStmt.run(
    input.userId,
    input.strategyId,
    input.notionalUsd,
    input.leverage,
    now,
    now,
    now,
  );
}

export function disableUserStrategy(userId: number, strategyId: string): void {
  const now = Date.now();
  disableStmt.run(now, now, userId, strategyId);
}

export function listUserStrategies(userId: number): UserStrategyRow[] {
  return findByUserStmt.all(userId);
}

export function findUserStrategy(
  userId: number,
  strategyId: string,
): UserStrategyRow | null {
  return findOneStmt.get(userId, strategyId) ?? null;
}

/** Used by the strategy fan-out: which users have this strategy ENABLED.
 *  Caller must additionally filter by `hasActiveAccess(userId)` and
 *  `findActiveKey(userId)` — those joins live in a query helper. */
export function listEnabledForStrategy(strategyId: string): UserStrategyRow[] {
  return findEnabledByStrategyStmt.all(strategyId);
}

// Convenience join for the strategy fan-out:
//   "Who should receive an order when strategy X fires?"
//
// One eligible user requires:
//   1. user_strategies.enabled = 1
//   2. user_subscriptions.status IN ('trial','active') AND access_until > now
//   3. user_api_keys row exists with revoked_at IS NULL AND last_verified_at IS NOT NULL
const findEligibleStmt = db.prepare<
  [string, number],
  {
    user_id: number;
    strategy_id: string;
    notional_usd: number;
    leverage: number;
    api_key_id: number;
  }
>(`
  SELECT us.user_id, us.strategy_id, us.notional_usd, us.leverage, k.id AS api_key_id
    FROM user_strategies us
    JOIN user_subscriptions s ON s.user_id = us.user_id
    JOIN user_api_keys k ON k.user_id = us.user_id AND k.exchange = 'bybit'
   WHERE us.strategy_id = ?
     AND us.enabled = 1
     AND s.status IN ('trial', 'active')
     AND s.access_until > ?
     AND s.trading_paused_at IS NULL
     AND k.revoked_at IS NULL
     AND k.last_verified_at IS NOT NULL
     AND k.insufficient_balance_at IS NULL
`);

export type EligibleTarget = {
  user_id: number;
  strategy_id: string;
  notional_usd: number;
  leverage: number;
  api_key_id: number;
};

/**
 * Sum required isolated margin across all ENABLED strategies for a user.
 * required = Σ(notional_usd / leverage). This is the "if every strategy
 * fires concurrently, how much USDT margin will Bybit demand" worst-case.
 * Used by the dashboard banner + balance-monitor cron + pre-flight.
 */
const sumRequiredStmt = db.prepare<[number], { total: number | null }>(`
  SELECT SUM(notional_usd / leverage) AS total
    FROM user_strategies
   WHERE user_id = ? AND enabled = 1 AND leverage > 0
`);

export function sumEnabledRequiredMargin(userId: number): number {
  const r = sumRequiredStmt.get(userId);
  return r?.total ?? 0;
}

export function listEligibleTargets(strategyId: string, now = Date.now()): EligibleTarget[] {
  return findEligibleStmt.all(strategyId, now);
}

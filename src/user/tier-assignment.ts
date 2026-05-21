/**
 * TRACK E — tier assignment + transition logic.
 *
 * assignTier(userId, tierId) sets up user_strategies rows according to
 * the tier's strategy list and computed margin/leverage. Wipes prior
 * user_strategies and re-creates — that's fine because open positions
 * are tracked in `decisions` (not user_strategies), so they survive
 * a tier change.
 *
 * VIP overrides: if the subscription row has tier_override_strategies /
 * tier_override_margin / tier_override_leverage set, we honour those
 * instead of the tier defaults. Operator and Eldar get seeded into
 * VIP-with-overrides preserving their current manual configuration.
 *
 * Downgrade: balance-monitor calls evaluateTierTransition every 5 min.
 * When suggestedTier < currentTier for 72h continuous → applyDowngrade.
 * Upgrade in Phase A is prompt-only (no auto-apply) — implemented in
 * Phase B with prorated billing.
 */

import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  TIER_CONFIGS,
  matchTier,
  type TierId,
} from '../strategies/tier-config.js';
import { STRATEGY_CONFIGS } from '../strategies/track-c-config.js';
import {
  enableUserStrategy,
  disableUserStrategy,
  listUserStrategies,
} from '../db/repos/user-strategies.js';
import { recordTierTransition } from '../db/repos/user-tier-history.js';
import { enqueueOperatorLog } from '../telegram/log-queue.js';
import { getLastPrice, getInstrumentInfo } from '../exchange/bybit-public.js';

/** Anti-flap downgrade window. Balance must be below current tier's
 *  min for at least this long before auto-downgrade fires. */
export const DOWNGRADE_GRACE_MS = 72 * 60 * 60 * 1000; // 72 hours

/** Anti-flap upgrade-prompt window. Used in Phase B (currently info
 *  only). Upgrade requires user confirmation. */
export const UPGRADE_PROMPT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const updateTierStmt = db.prepare(`
  UPDATE user_subscriptions
     SET tier_id = ?,
         tier_transition_target_id = NULL,
         tier_transition_first_seen_at = NULL,
         updated_at = ?
   WHERE user_id = ?
`);

const updateTransitionStmt = db.prepare(`
  UPDATE user_subscriptions
     SET tier_transition_target_id = ?,
         tier_transition_first_seen_at = ?,
         updated_at = ?
   WHERE user_id = ?
`);

const clearTransitionStmt = db.prepare(`
  UPDATE user_subscriptions
     SET tier_transition_target_id = NULL,
         tier_transition_first_seen_at = NULL,
         updated_at = ?
   WHERE user_id = ?
`);

const findSubscriptionStmt = db.prepare<[number], {
  tier_id: string;
  plan: string;
  tier_override_strategies: string | null;
  tier_override_margin: number | null;
  tier_override_leverage: string | null;
  tier_transition_target_id: string | null;
  tier_transition_first_seen_at: number | null;
}>(`
  SELECT tier_id, plan,
         tier_override_strategies, tier_override_margin, tier_override_leverage,
         tier_transition_target_id, tier_transition_first_seen_at
    FROM user_subscriptions
   WHERE user_id = ?
   LIMIT 1
`);

/**
 * Compute the effective (strategyIds, marginPerTrade, leveragePerStrategy)
 * for a user — honours VIP overrides if present, otherwise tier defaults.
 */
export function resolveUserTierParams(userId: number): {
  tierId: TierId;
  strategyIds: string[];
  marginPerTradeUsd: number;
  leverageByStrategy: Record<string, number>;
} | null {
  const sub = findSubscriptionStmt.get(userId);
  if (!sub) return null;
  const tierId = sub.tier_id as TierId;
  const tier = TIER_CONFIGS[tierId];
  if (!tier) {
    logger.warn({ userId, tierId }, 'resolveUserTierParams: unknown tier_id');
    return null;
  }

  // VIP override path: when any of the override fields are non-NULL,
  // the operator has hand-picked configuration. We honour each present
  // field; absent fields fall through to tier defaults.
  let strategyIds = tier.strategyIds;
  let marginPerTradeUsd = tier.marginPoolUsd / tier.strategyIds.length;
  const leverageByStrategy: Record<string, number> = {};

  if (sub.tier_override_strategies) {
    try {
      const parsed = JSON.parse(sub.tier_override_strategies) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) strategyIds = parsed;
    } catch (err) {
      logger.warn({ userId, err }, 'resolveUserTierParams: bad override JSON');
    }
  }
  if (sub.tier_override_margin && sub.tier_override_margin > 0) {
    marginPerTradeUsd = sub.tier_override_margin;
  }
  // Per-strategy leverage starts from each strategy's maxSafeLeverage,
  // overridden by tier_override_leverage if present.
  let overrideMap: Record<string, number> = {};
  if (sub.tier_override_leverage) {
    try {
      overrideMap = JSON.parse(sub.tier_override_leverage) as Record<string, number>;
    } catch (err) {
      logger.warn({ userId, err }, 'resolveUserTierParams: bad leverage override JSON');
    }
  }
  for (const sid of strategyIds) {
    const strategy = STRATEGY_CONFIGS[sid];
    const fallback = strategy?.maxSafeLeverage ?? 5;
    leverageByStrategy[sid] = overrideMap[sid] ?? fallback;
  }

  return { tierId, strategyIds, marginPerTradeUsd, leverageByStrategy };
}

/**
 * Assign a tier to a user. Wipes prior user_strategies for this user
 * and re-creates rows matching the tier's strategy list + computed
 * margin/leverage. Idempotent — safe to call multiple times.
 *
 * Open positions in `decisions` are NOT touched — they live their own
 * lifecycle and close on strategy_exit signal as usual.
 *
 * Phase B additions:
 *   - records user_tier_history row with reason + balance snapshot
 *   - enqueues Telegram operator alert (batched, non-critical)
 *   - tracks per-strategy skips (e.g. qtyStep doesn't fit) in
 *     metadata for support diagnostics
 *
 * `reason` is required so history is meaningful: 'initial_assign',
 * 'auto_downgrade_72h_grace', 'manual_upgrade_user_confirmed',
 * 'operator_override', etc.
 */
export async function assignTier(
  userId: number,
  tierId: TierId,
  opts: {
    reason?: string;
    balanceUsdt?: number | null;
  } = {},
): Promise<void> {
  const tier = TIER_CONFIGS[tierId];
  if (!tier) throw new Error(`assignTier: unknown tier_id ${tierId}`);

  const reason = opts.reason ?? 'initial_assign';
  const balanceUsdt = opts.balanceUsdt ?? null;

  // Capture previous tier for history.
  const prev = findSubscriptionStmt.get(userId);
  const fromTier = prev?.tier_id ?? null;

  const now = Date.now();
  // Update tier on subscription row.
  updateTierStmt.run(tierId, now, userId);

  // Reset user_strategies to match the new tier.
  // 1. Disable everything (sets enabled=0). enableUserStrategy below
  //    will set enabled=1 for the right rows.
  const existing = listUserStrategies(userId);
  for (const row of existing) {
    if (row.enabled === 1) disableUserStrategy(userId, row.strategy_id);
  }

  // 2. Resolve effective params (handles VIP override).
  const params = resolveUserTierParams(userId);
  if (!params) {
    logger.error({ userId, tierId }, 'assignTier: resolveUserTierParams returned null');
    return;
  }

  // 3. Enable strategies. Track skips for history + UX.
  //    Phase B: qtyStep validation. For each candidate strategy fetch
  //    the symbol's minOrderQty + livePrice from Bybit (cached 1h).
  //    If tier notional can't even buy one minimum lot — skip and
  //    record. Operator sees this in tier-history metadata for support.
  const enabledIds: string[] = [];
  const skippedIds: { id: string; reason: string; details?: Record<string, unknown> }[] = [];
  for (const sid of params.strategyIds) {
    const strategy = STRATEGY_CONFIGS[sid];
    if (!strategy || strategy.enabled === false) {
      logger.warn({ userId, sid }, 'assignTier: strategy disabled or missing, skipping');
      skippedIds.push({ id: sid, reason: 'strategy_disabled' });
      continue;
    }
    const leverage = params.leverageByStrategy[sid] ?? strategy.maxSafeLeverage ?? 5;
    const notionalUsd = params.marginPerTradeUsd * leverage;

    // qtyStep guard — only when we know the symbol (operator strategies
    // can have symbol=undefined for ANY-symbol pickup).
    if (strategy.symbol) {
      try {
        const [info, price] = await Promise.all([
          getInstrumentInfo(strategy.symbol),
          getLastPrice(strategy.symbol),
        ]);
        if (info && price !== null && info.minOrderQty > 0) {
          const minNotional = info.minOrderQty * price;
          if (notionalUsd < minNotional) {
            logger.warn(
              {
                userId,
                sid,
                symbol: strategy.symbol,
                tierNotional: notionalUsd,
                minNotional: minNotional.toFixed(2),
                price,
                minOrderQty: info.minOrderQty,
              },
              'assignTier: notional below minOrderQty, skipping',
            );
            skippedIds.push({
              id: sid,
              reason: 'notional_below_min_order_qty',
              details: {
                symbol: strategy.symbol,
                tierNotional: notionalUsd,
                minNotional: Math.round(minNotional * 100) / 100,
                livePrice: price,
              },
            });
            continue;
          }
        }
      } catch (err) {
        // Fetch failed — non-fatal, fall through and let Bybit reject
        // at fan-out time if the lot doesn't fit. Log so operator can
        // see if this becomes a pattern.
        logger.warn(
          { userId, sid, err: (err as Error).message },
          'assignTier: instruments-info fetch failed, allowing strategy',
        );
      }
    }

    enableUserStrategy({
      userId,
      strategyId: sid,
      notionalUsd,
      leverage,
    });
    enabledIds.push(sid);
  }

  // 4. Audit log + operator notification.
  recordTierTransition({
    userId,
    fromTier,
    toTier: tierId,
    reason,
    balanceUsdt,
    metadata: {
      enabledStrategies: enabledIds,
      skippedStrategies: skippedIds,
      marginPerTrade: params.marginPerTradeUsd,
    },
  });

  // Telegram alert (batched). Skip noisy «initial_assign» for fresh
  // signups — only notify on actual transitions.
  if (fromTier && fromTier !== tierId) {
    enqueueOperatorLog(
      `🔄 Tier transition: user_id=${userId} ${fromTier} → ${tierId} (${reason}` +
        (balanceUsdt !== null ? `, balance=$${balanceUsdt.toFixed(2)}` : '') +
        `)`,
    );
  }

  logger.info(
    {
      userId,
      tierId,
      fromTier,
      reason,
      strategies: enabledIds.length,
      skipped: skippedIds.length,
      marginPerTrade: params.marginPerTradeUsd,
    },
    'tier assigned',
  );
}

/**
 * Read balance → match tier → if changed from current, evaluate
 * transition. Called by balance-monitor cron after recordBalance.
 *
 * Phase A behaviour:
 *   - Downgrade: auto after DOWNGRADE_GRACE_MS continuous below.
 *   - Upgrade: track the suggestion (set transition fields) but DON'T
 *     auto-apply. UI shows a banner — user clicks to confirm.
 *
 * VIP users are exempt — their tier is set by operator override and
 * doesn't track balance.
 */
export async function evaluateTierTransition(userId: number, balanceUsdt: number): Promise<{
  action: 'none' | 'downgrade' | 'upgrade-pending' | 'too-low';
  fromTier?: TierId;
  toTier?: TierId;
}> {
  const sub = findSubscriptionStmt.get(userId);
  if (!sub) return { action: 'none' };
  if (sub.plan === 'vip') return { action: 'none' };

  const currentTier = sub.tier_id as TierId;
  const suggestedTier = matchTier(balanceUsdt);

  if (suggestedTier === null) {
    // Balance below $300 — no tier. Caller should handle low-balance UX.
    return { action: 'too-low' };
  }
  if (suggestedTier === currentTier) {
    // Stable — clear any pending transition state.
    if (sub.tier_transition_target_id) {
      clearTransitionStmt.run(Date.now(), userId);
    }
    return { action: 'none' };
  }

  const tierOrder = ['starter', 'standard', 'plus', 'pro', 'vip'];
  const isDowngrade = tierOrder.indexOf(suggestedTier) < tierOrder.indexOf(currentTier);

  // First time we see this transition? Start the grace timer.
  if (sub.tier_transition_target_id !== suggestedTier) {
    updateTransitionStmt.run(suggestedTier, Date.now(), Date.now(), userId);
    return { action: isDowngrade ? 'downgrade' : 'upgrade-pending', fromTier: currentTier, toTier: suggestedTier };
  }

  // Same suggestion as before — check if grace period elapsed.
  const elapsed = Date.now() - (sub.tier_transition_first_seen_at ?? Date.now());
  if (isDowngrade && elapsed >= DOWNGRADE_GRACE_MS) {
    await assignTier(userId, suggestedTier, {
      reason: 'auto_downgrade_72h_grace',
      balanceUsdt,
    });
    logger.info(
      { userId, fromTier: currentTier, toTier: suggestedTier, balanceUsdt },
      'auto-downgrade applied (72h grace elapsed)',
    );
    return { action: 'downgrade', fromTier: currentTier, toTier: suggestedTier };
  }

  // Upgrade — Phase A keeps transition tracked but doesn't auto-apply.
  return { action: 'upgrade-pending', fromTier: currentTier, toTier: suggestedTier };
}

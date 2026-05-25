/**
 * Track D — strategy fan-out to user accounts.
 *
 * When the operator's shadow trade fires (entry or exit), this module
 * replays it on every eligible user's Bybit account in parallel. The
 * shadow row is written FIRST (synchronously) so the public marketing
 * trade-log stays correct even if individual user calls fail.
 *
 * Per-user execution path (entry):
 *   1. listEligibleTargets() — joins user_strategies + user_subscriptions
 *      + user_api_keys; only rows with verified+unrevoked key and active
 *      access (status in trial/active, access_until > now OR plan=vip)
 *   2. p-limit(10) parallel:
 *      a. decrypt creds
 *      b. setLeverage(symbol, lev) — idempotent
 *      c. placeMarketOrder(symbol, side, qty, stopLoss=sl_price) — atomic
 *      d. on success: insertDecision({ user_id, parent_decision_id,
 *         exchange_order_id, bybit_qty, bybit_avg_price })
 *      e. on failure: recordVerifyResult(keyId, ok=false, error=label) +
 *         Telegram Logs alert with user_id + retCode. No DB decision row
 *         is written for that user — they see "key needs re-verify" on
 *         their cabinet next page-load.
 *
 * Per-user execution path (exit):
 *   1. findActiveUserDecisions(symbol, strategy_id) — every active user row
 *   2. p-limit(10) parallel:
 *      a. placeMarketOrder(opposite side, qty=bybit_qty, reduceOnly=true)
 *      b. fetchOrderResult to get the real fill avg price
 *      c. closeUserDecision({ id, close_price, force_reason: 'strategy_exit' })
 *      d. on failure: log + leave row active; tpsl-monitor reconcile will
 *         pick it up next minute.
 */

import pLimit from 'p-limit';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { enqueueOperatorLog } from '../telegram/log-queue.js';
import {
  listEligibleTargets,
  type EligibleTarget,
} from '../db/repos/user-strategies.js';
import {
  findActiveKey,
  getDecryptedCreds,
  recordVerifyResult,
  setInsufficientBalance,
  clearInsufficientBalanceIfUnchanged,
} from '../db/repos/user-api-keys.js';
import { isTradingActive } from '../db/repos/user-subscriptions.js';
import {
  insertDecision,
  findActiveUserDecisions,
  findActiveByUser,
  closeUserDecision,
  calcPnl,
  findUserDecisionByParent,
} from '../db/repos/decisions.js';
import {
  setLeverage,
  placeMarketOrder,
  fetchOrderResult,
  fetchPosition,
  setPositionSL,
  switchToOneWayMode,
  bybitErrorLabel,
} from '../exchange/bybit-private.js';
import { roundQtyToStep } from '../exchange/bybit-public.js';
import { STRATEGY_CONFIGS, TRACK_C_NOTIONAL_USD } from './track-c-config.js';
import { computeMarginState } from '../user/margin.js';
import { resolveUserTierParams } from '../user/tier-assignment.js';
import { TIER_CONFIGS } from './tier-config.js';
import {
  computeSlippageBps,
  computeExitSlippageBps,
  SLIPPAGE_ALERT_BPS,
} from '../lib/slippage.js';

const PARALLEL_LIMIT = 10; // well below Bybit's 50 req/s global cap
const limit = pLimit(PARALLEL_LIMIT);

/** Bybit error codes that indicate the API KEY itself is broken
 *  (revoked, wrong IP, missing permission). Other codes (insufficient
 *  balance, qty too small, leverage conflict) are operational and
 *  shouldn't poison the key as verify_failed. */
const AUTH_CLASS_ERROR_CODES = new Set([
  10003, // invalid API key
  10004, // invalid sign
  10005, // permission denied
  10010, // unmatched IP
  10006, // rate limit / abusive — treat as auth issue too
]);

/** Codes that mean "balance / margin insufficient on the unified
 *  account". When seen, we flip insufficient_balance_at on the key
 *  so subsequent signals are skipped until the user tops up. */
const INSUFFICIENT_BALANCE_CODES = new Set([
  110007, // insufficient available balance
  110012, // insufficient margin
  110045, // insufficient quote (USDT) balance
]);

function shouldMarkKeyBroken(code: number): boolean {
  return AUTH_CLASS_ERROR_CODES.has(code);
}

function isInsufficientBalance(code: number): boolean {
  return INSUFFICIENT_BALANCE_CODES.has(code);
}

export type FanOutEntryArgs = {
  shadowDecisionId: number;
  strategyId: string;
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  sl: number;
  rawWebhook: string;
};

/**
 * Replay an entry signal on every eligible user account. Returns when
 * all user calls have settled (or failed). The webhook handler awaits
 * this so TradingView gets a complete 200 response after the dust settles.
 */
export async function fanOutEntry(args: FanOutEntryArgs): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  const cfg = STRATEGY_CONFIGS[args.strategyId];
  if (!cfg) {
    logger.warn({ strategyId: args.strategyId }, 'fanOutEntry: unknown strategy_id');
    return { attempted: 0, succeeded: 0, failed: 0 };
  }
  const targets = listEligibleTargets(args.strategyId);
  if (targets.length === 0) {
    logger.info({ strategyId: args.strategyId }, 'fanOutEntry: no eligible users');
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  await Promise.allSettled(
    targets.map((t) =>
      limit(async () => {
        const ok = await executeUserEntry(t, args);
        if (ok) succeeded++;
        else failed++;
      }),
    ),
  );

  logger.info(
    {
      strategyId: args.strategyId,
      symbol: args.symbol,
      attempted: targets.length,
      succeeded,
      failed,
    },
    'fanOutEntry: done',
  );
  return { attempted: targets.length, succeeded, failed };
}

async function executeUserEntry(t: EligibleTarget, args: FanOutEntryArgs): Promise<boolean> {
  // Phase N — per-user SL override (Prof tier).
  //   - If user set sl_pct_override on this strategy, recompute the SL from
  //     args.entry + args.side using their value (independent of the shadow
  //     SL in args.sl, which was computed using STRATEGY_CONFIGS default).
  //   - Otherwise use args.sl as-is.
  //   The user's own SL flows into placeMarketOrder + verifyOrAttachSL +
  //   insertDecision so tpsl-monitor / dashboards see their value.
  const userSl = (() => {
    const override = t.sl_pct_override;
    if (override == null || !Number.isFinite(override) || override <= 0) {
      return args.sl;
    }
    const dist = args.entry * override;
    const raw = args.side === 'long' ? args.entry - dist : args.entry + dist;
    // Round to 4 decimals to match strategy-trader.ts. Bybit accepts the
    // price as long as it's a valid tick — instruments-info would be more
    // precise, but 4-decimal works for all symbols we currently trade.
    return Math.round(raw * 1e4) / 1e4;
  })();
  // Margin pre-flight — per-trade safety only. If free margin can't
  // cover THIS specific entry we skip it cleanly (Bybit would reject
  // anyway). Each signal is evaluated independently — we no longer
  // flag the user as «insufficient» globally, because the operator
  // decision is to keep trying every signal regardless of overall
  // balance. The minimum-balance requirement is only a gate for
  // activation, not an ongoing constraint.
  const margin = computeMarginState(t.user_id);
  if (margin.balanceUsdt !== null) {
    const free = margin.freeUsdt ?? 0;
    const needed = t.notional_usd / Math.max(1, t.leverage);
    const buffered = needed * 1.05; // 5% buffer for fees/slippage
    if (free < buffered) {
      logger.info(
        { userId: t.user_id, free, needed, balance: margin.balanceUsdt, used: margin.usedUsdt },
        'fanOutEntry: pre-flight margin shortfall on this signal — skipping (next signal evaluated fresh)',
      );
      return false;
    }
  }
  // TRACK E — max concurrent positions per tier. Even if margin
  // would allow more, the tier promises a cap (e.g. Plus = 4 max).
  // This stops accidental over-concentration during multi-symbol bursts.
  const tierParams = resolveUserTierParams(t.user_id);
  if (tierParams) {
    const tierMaxConcurrent = TIER_CONFIGS[tierParams.tierId].maxConcurrentPositions;
    const activeCount = findActiveByUser(t.user_id).length;
    if (activeCount >= tierMaxConcurrent) {
      logger.info(
        { userId: t.user_id, tier: tierParams.tierId, activeCount, max: tierMaxConcurrent },
        'fanOutEntry: tier max-concurrent reached, skipping',
      );
      return false;
    }
  }

  // Audit C2 — fan-out idempotency pre-flight.
  // TradingView retries webhooks aggressively on 5xx / network glitch.
  // The shadow row is deduped by webhook_dedup_key, but the per-user
  // fan-out runs ASYNC after that — so a retry can land while the
  // first run is still mid-flight (or after partial completion). If
  // we already wrote a row for this (parent, user) pair, skip cleanly.
  // Migration 026 also has a partial unique index as a hard backstop.
  const existing = findUserDecisionByParent(args.shadowDecisionId, t.user_id);
  if (existing !== null) {
    logger.info(
      { userId: t.user_id, parent: args.shadowDecisionId, existing },
      'fanOutEntry: skip, already processed (idempotency)',
    );
    return false;
  }
  // Re-check trading-active right before placing the order — defends
  // against two races: (a) access expired / cancelled between
  // listEligibleTargets() and now, and (b) user clicked «Остановить»
  // in the cabinet while we were in flight. isTradingActive covers
  // both (hasActiveAccess + trading_paused_at IS NULL).
  if (!isTradingActive(t.user_id)) {
    logger.info({ userId: t.user_id }, 'fanOutEntry: trading lapsed between query and execute');
    return false;
  }
  const keyRow = findActiveKey(t.user_id);
  if (!keyRow) {
    // Should not happen because listEligibleTargets joined on it, but
    // defend against TOCTOU (user revoked between query + here).
    return false;
  }
  let creds;
  try {
    creds = getDecryptedCreds(keyRow);
  } catch (err) {
    logger.error({ err, userId: t.user_id }, 'fanOutEntry: decrypt failed');
    recordVerifyResult(keyRow.id, false, 'decrypt_failed');
    // Critical: decrypt failure usually means API_KEY_MASTER_SECRET was
    // rotated incorrectly, the row was corrupted, or the legacy-secret
    // fallback was removed. Without the master key we cannot close any
    // open positions for this user — operator must act immediately.
    await alertOperatorCritical(
      `🚨 Не удалось расшифровать ключ user_id=${t.user_id}. Проверь API_KEY_MASTER_SECRET.`,
    );
    return false;
  }

  // 0. Force One-Way position mode. Idempotent on Bybit's side
  //    (110025 = "not modified" → treated as OK). If the user toggled
  //    their account to Hedge mode on Bybit's website our order code
  //    (which always uses positionIdx=0) would otherwise fail with
  //    10001 "position idx not match position mode". This is cheap
  //    (~150ms) and runs every fan-out tick — if we ever need to
  //    optimise we can cache the One-Way state per key.
  const modeRes = await switchToOneWayMode(creds);
  if (!modeRes.ok) {
    logger.warn(
      { userId: t.user_id, code: modeRes.code, msg: modeRes.msg },
      'fanOutEntry: switchToOneWayMode failed',
    );
    // 110024 ("Position is currently in cross margin mode") on accounts
    // that have an OPEN position in Hedge mode — we can't auto-switch
    // until they close it. Surface a clear message and skip.
    if (modeRes.code === 110024) {
      alertOperator(
        `⚠️ Track D: user_id=${t.user_id} has open positions in Hedge mode on Bybit. ` +
          `Auto-switch to One-Way blocked. User must close existing positions manually first.`,
      );
    } else if (shouldMarkKeyBroken(modeRes.code)) {
      recordVerifyResult(keyRow.id, false, `switchMode: ${bybitErrorLabel(modeRes.code)}`);
    }
    return false;
  }

  // 1. Set leverage. Idempotent — already at this value → ok.
  //    110044 = "leverage cannot change with open position" — not the
  //    key's fault, the user just has an existing position. Skip
  //    gracefully without marking the key broken.
  const levRes = await setLeverage(creds, args.symbol, t.leverage);
  if (!levRes.ok) {
    const label = bybitErrorLabel(levRes.code);
    logger.warn({ userId: t.user_id, code: levRes.code, msg: levRes.msg }, 'fanOutEntry: setLeverage failed');
    if (shouldMarkKeyBroken(levRes.code)) {
      recordVerifyResult(keyRow.id, false, `setLeverage: ${label}`);
    }
    if (levRes.code === 110044) {
      alertOperator(
        `ℹ️ Track D: user_id=${t.user_id} has an existing position on ${args.symbol}, skipping. Should close it on Bybit first.`,
      );
    } else {
      alertOperator(
        `⚠️ Track D fan-out: user_id=${t.user_id} setLeverage(${args.symbol}, ${t.leverage}×) failed: ${label} · ${levRes.msg}`,
      );
    }
    return false;
  }

  // 2. Place market entry with atomic SL.
  // Audit H5: round to the symbol's actual qtyStep from instruments-info
  // (cached 1h). Pre-fix this was a hardcoded 4-decimal floor which
  // breaks for integer-step coins (PEPE, SHIB) and tight-step majors.
  const qty = await roundQtyToStep(t.notional_usd / args.entry, args.symbol);
  if (qty <= 0) {
    logger.warn(
      { userId: t.user_id, notional: t.notional_usd, entry: args.entry, symbol: args.symbol },
      'fanOutEntry: qty rounded to 0 (notional below min or step lookup failed)',
    );
    // Not an auth issue — don't poison the key.
    return false;
  }
  const clientOrderId = `td-${args.shadowDecisionId}-u${t.user_id}-e`;
  const orderRes = await placeMarketOrder(creds, {
    symbol: args.symbol,
    side: args.side,
    qty,
    stopLoss: userSl,
    clientOrderId,
  });
  if (!orderRes.ok) {
    const label = bybitErrorLabel(orderRes.code);
    logger.warn({ userId: t.user_id, code: orderRes.code, msg: orderRes.msg }, 'fanOutEntry: placeMarketOrder failed');
    // Only mark key broken on auth-class errors. Insufficient balance
    // (110007/110012), invalid qty (170131) etc. are operational and
    // shouldn't make the user re-verify their key.
    if (shouldMarkKeyBroken(orderRes.code)) {
      recordVerifyResult(keyRow.id, false, `placeOrder: ${label}`);
    }
    // Insufficient balance: set the flag so the user is skipped from
    // future fan-outs until they top up + re-verify (manual click on
    // «Проверить связь» auto-clears it). Avoids hammering Bybit with
    // rejected orders every time a signal fires.
    if (isInsufficientBalance(orderRes.code)) {
      setInsufficientBalance(keyRow.id, Date.now());
      alertOperator(
        `💸 Track D: user_id=${t.user_id} insufficient balance on ${args.symbol}. ` +
        `Required: $${(t.notional_usd / t.leverage).toFixed(2)} margin. Skipping until top-up.`,
      );
    } else {
      alertOperator(
        `⚠️ Track D fan-out: user_id=${t.user_id} entry on ${args.symbol} failed: ${label} · ${orderRes.msg}`,
      );
    }
    // Record the failure as an inactive decision row so it shows in the
    // user's history with order_error populated.
    insertDecision({
      symbol: args.symbol,
      side: args.side,
      entry: args.entry,
      sl: userSl,
      reasoningShort: `🚫 fanOutEntry failed: ${label}`,
      reasoningFull: `Order rejected by Bybit (retCode=${orderRes.code}): ${orderRes.msg}`,
      rawResponse: args.rawWebhook,
      strategyId: args.strategyId,
      userId: t.user_id,
      parentDecisionId: args.shadowDecisionId,
      orderError: `${label}: ${orderRes.msg}`,
    });
    return false;
  }

  // 3. Fetch real fill (qty + avg price) — Bybit returns these
  //    asynchronously, so we poll briefly. Market orders fill within
  //    milliseconds on liquid pairs; 3 × 250ms is overkill safety.
  let filledQty = qty;
  let avgPrice = args.entry;
  for (let i = 0; i < 3; i++) {
    const fillRes = await fetchOrderResult(creds, {
      symbol: args.symbol,
      orderLinkId: clientOrderId,
    });
    if (fillRes.ok && fillRes.order && fillRes.order.filledQty > 0) {
      filledQty = fillRes.order.filledQty;
      avgPrice = fillRes.order.avgPrice;
      break;
    }
    await sleep(250);
  }

  // 3-1. Slippage check — compare what we got vs the signal price.
  //      Bigger than threshold = thin book, wide spread, fast candle.
  //      Operator gets a heads-up; the trade proceeds as normal.
  const slipBps = computeSlippageBps({
    side: args.side,
    signalPrice: args.entry,
    fillPrice: avgPrice,
  });
  if (Math.abs(slipBps) >= SLIPPAGE_ALERT_BPS) {
    const sign = slipBps > 0 ? '+' : '';
    const direction = slipBps > 0 ? 'against us' : 'in our favour';
    alertOperator(
      `📏 Track D entry slippage · user_id=${t.user_id} · ${args.symbol} ${args.side} · ` +
        `signal $${args.entry.toFixed(4)} → fill $${avgPrice.toFixed(4)} = ${sign}${slipBps} bps (${direction})`,
    );
  }

  // 3-2. Partial fill detection. Market orders on liquid USDT-perps
  //      almost always fully fill, but a fast-moving candle or thin
  //      book can leave us with less than asked. We don't change
  //      behaviour (SL was already attached to whatever filled), just
  //      flag the operator so we can spot pairs/timings that suffer.
  if (filledQty < qty * 0.95) {
    const filledPct = (filledQty / qty) * 100;
    alertOperator(
      `⚠️ Track D partial fill · user_id=${t.user_id} · ${args.symbol} ${args.side} · ` +
        `asked ${qty}, got ${filledQty} (${filledPct.toFixed(1)}%). Position opened at reduced size.`,
    );
  }

  // 3a. Audit C-NEW-1 — post-order trading-active re-check.
  //     The pre-flight on :211 covered access lapse BEFORE we placed
  //     the order. But the order itself takes ~500-1000ms (place +
  //     fill poll), and a user clicking «Отключить ключ» mid-flight
  //     would set trading_paused_at AFTER our isTradingActive check.
  //     If we then commit insertDecision, we'd write a row tied to a
  //     key that's about to be revoked — orphan position on Bybit
  //     once revoke completes.
  //     Re-check now. If access is gone, emergency-close before
  //     anyone (user OR revoke flow) has a chance to remove the key.
  if (!isTradingActive(t.user_id)) {
    logger.warn(
      { userId: t.user_id, orderId: orderRes.orderId },
      'fanOutEntry: trading lapsed between order and persist — emergency closing',
    );
    const closedOk = await emergencyCloseUnprotected(
      creds,
      args.symbol,
      args.side,
      filledQty,
      args.shadowDecisionId,
      t.user_id,
    );
    if (closedOk) {
      alertOperator(
        `⚠️ Track D: user_id=${t.user_id} on ${args.symbol} — trading was paused mid-order, emergency-closed reduceOnly. Position safe.`,
      );
    }
    // No decision row written — the trade essentially didn't happen
    // from the user's perspective. The shadow row remains as the
    // operator-side record.
    return false;
  }

  // 3b. Audit C3 — verify SL actually attached to the position.
  //
  // placeMarketOrder includes stopLoss in the order body, but Bybit can
  // silently drop the param (validation, mode mismatch, etc.) and still
  // return 200 + orderId. We do NOT trust the order response — we read
  // the position back and check that stopLoss > 0 within tolerance of
  // what we asked for. If missing, retry setPositionSL up to 3 times.
  // If still missing, EMERGENCY-CLOSE the position with a reduceOnly
  // market order — better to take a tiny slippage loss than to leave
  // a user position open and unprotected.
  const slOk = await verifyOrAttachSL(creds, args.symbol, userSl, t.user_id);
  if (!slOk) {
    // Position is open without SL after all retries failed. Emergency
    // close. We do this with a reduceOnly market order in the opposite
    // direction; size from the position we just fetched.
    const emergencyOk = await emergencyCloseUnprotected(
      creds,
      args.symbol,
      args.side,
      filledQty,
      args.shadowDecisionId,
      t.user_id,
    );
    alertOperator(
      `🚨 Track D fan-out: user_id=${t.user_id} entry on ${args.symbol} ` +
        `opened BUT SL failed to attach after 3 retries. Emergency close: ` +
        `${emergencyOk ? 'OK' : 'ALSO FAILED — manual intervention required'}.`,
    );
    insertDecision({
      symbol: args.symbol,
      side: args.side,
      entry: avgPrice,
      sl: userSl,
      reasoningShort: `🚨 SL verify failed, position emergency-closed`,
      reasoningFull:
        `Order ${orderRes.orderId} filled @${avgPrice} qty=${filledQty} but ` +
        `Bybit did not attach stopLoss. After 3 setPositionSL retries we ` +
        `${emergencyOk ? 'emergency-closed via reduceOnly market' : 'FAILED to close — operator must close manually'}.`,
      rawResponse: args.rawWebhook,
      strategyId: args.strategyId,
      userId: t.user_id,
      parentDecisionId: args.shadowDecisionId,
      exchangeOrderId: orderRes.orderId,
      bybitQty: filledQty,
      bybitAvgPrice: avgPrice,
      orderError: emergencyOk ? 'sl_attach_failed_closed' : 'sl_attach_failed_open',
    });
    return false;
  }

  // 4. Persist the user row.
  const slLabel = t.sl_pct_override != null
    ? `${userSl} (Prof custom ${(t.sl_pct_override * 100).toFixed(2)}%, attached atomically)`
    : `${userSl} (attached atomically)`;
  insertDecision({
    symbol: args.symbol,
    side: args.side,
    entry: avgPrice,
    sl: userSl,
    reasoningShort: `Track D user fan-out · ${args.symbol} ${args.side} @${avgPrice}`,
    reasoningFull:
      `Strategy ${args.strategyId} → user_id=${t.user_id}\n` +
      `Notional: $${t.notional_usd} · Leverage: ${t.leverage}×\n` +
      `Qty: ${filledQty} · Avg price: ${avgPrice}\n` +
      `SL: ${slLabel}\n` +
      `Order ID: ${orderRes.orderId}`,
    rawResponse: args.rawWebhook,
    strategyId: args.strategyId,
    userId: t.user_id,
    parentDecisionId: args.shadowDecisionId,
    exchangeOrderId: orderRes.orderId,
    bybitQty: filledQty,
    bybitAvgPrice: avgPrice,
    features: {
      source: 'track_d_user_fanout',
      strategy_id: args.strategyId,
      user_id: t.user_id,
      notional_usd: t.notional_usd,
      leverage: t.leverage,
      operator_notional: TRACK_C_NOTIONAL_USD,
    },
  });

  // Mark the key as freshly verified (it just worked).
  recordVerifyResult(keyRow.id, true);
  // Audit H3 — clear the insufficient_balance flag with compare-and-swap.
  // Race we're guarding against: this fanout started before a concurrent
  // fanout on a DIFFERENT symbol set the flag (real failure). A naive
  // `setInsufficientBalance(keyRow.id, null)` would wipe that flag and
  // re-include the user in eligible-targets even though their balance
  // is still insufficient for the new symbol.
  // CAS only clears if the flag still equals what we read at the start.
  if (keyRow.insufficient_balance_at) {
    clearInsufficientBalanceIfUnchanged(keyRow.id, keyRow.insufficient_balance_at);
  }
  return true;
}

export type FanOutExitArgs = {
  strategyId: string;
  symbol: string;
  forceReason: 'strategy_exit' | 'reverse_signal';
  /** Close price from the strategy_exit webhook payload — used to
   *  compute exit slippage (signal price vs actual fill). Optional
   *  because old call-sites might not have it yet. */
  signalPrice?: number;
};

/**
 * Close every active user position on this (symbol, strategy_id).
 */
export async function fanOutExit(args: FanOutExitArgs): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  const userRows = findActiveUserDecisions(args.symbol, args.strategyId);
  if (userRows.length === 0) return { attempted: 0, succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed = 0;

  await Promise.allSettled(
    userRows.map((row) =>
      limit(async () => {
        const ok = await executeUserExit(row, args);
        if (ok) succeeded++;
        else failed++;
      }),
    ),
  );

  logger.info(
    { strategyId: args.strategyId, attempted: userRows.length, succeeded, failed },
    'fanOutExit: done',
  );
  return { attempted: userRows.length, succeeded, failed };
}

async function executeUserExit(
  row: {
    id: number;
    user_id: number | null;
    symbol: string;
    side: string | null;
    entry: number | null;
    sl: number | null;
    bybit_qty: number | null;
    original_sl: number | null;
  },
  args: FanOutExitArgs,
): Promise<boolean> {
  if (!row.user_id || !row.side || !row.entry || !row.bybit_qty) {
    logger.warn({ id: row.id }, 'fanOutExit: row missing required fields');
    return false;
  }
  const keyRow = findActiveKey(row.user_id);
  if (!keyRow) {
    logger.warn({ userId: row.user_id, id: row.id }, 'fanOutExit: no active key — leaving row active');
    return false;
  }
  let creds;
  try {
    creds = getDecryptedCreds(keyRow);
  } catch (err) {
    logger.error({ err, userId: row.user_id }, 'fanOutExit: decrypt failed');
    return false;
  }

  const oppositeSide: 'long' | 'short' = row.side === 'long' ? 'short' : 'long';
  const clientOrderId = `td-${row.id}-u${row.user_id}-x`;
  const closeRes = await placeMarketOrder(creds, {
    symbol: row.symbol,
    side: oppositeSide,
    qty: row.bybit_qty,
    reduceOnly: true,
    clientOrderId,
  });
  if (!closeRes.ok) {
    const label = bybitErrorLabel(closeRes.code);
    logger.warn({ userId: row.user_id, code: closeRes.code, msg: closeRes.msg }, 'fanOutExit: close failed');
    alertOperator(
      `⚠️ Track D fan-out exit failed: user_id=${row.user_id} id=${row.id} on ${row.symbol}: ${label} · ${closeRes.msg}`,
    );
    return false;
  }

  // Wait briefly for the close fill, then read avg price for accurate PnL.
  let closePrice = row.entry;
  let closeAvgPrice: number | null = null;
  for (let i = 0; i < 3; i++) {
    const fillRes = await fetchOrderResult(creds, {
      symbol: row.symbol,
      orderLinkId: clientOrderId,
    });
    if (fillRes.ok && fillRes.order && fillRes.order.filledQty > 0) {
      closePrice = fillRes.order.avgPrice;
      closeAvgPrice = fillRes.order.avgPrice;
      break;
    }
    await sleep(250);
  }

  // Exit-slippage check against the strategy's signal close price.
  // Same threshold as entry; this catches cases where the user's
  // exit landed materially worse than the LuxAlgo bar close (e.g.
  // strategy fires on bar-close at 1.3500, our market exit fills
  // at 1.3460 → 30 bps against us on a SHORT exit).
  if (args.signalPrice && args.signalPrice > 0 && closeAvgPrice && row.side) {
    const exitSlipBps = computeExitSlippageBps({
      side: row.side as 'long' | 'short',
      signalPrice: args.signalPrice,
      fillPrice: closeAvgPrice,
    });
    if (Math.abs(exitSlipBps) >= SLIPPAGE_ALERT_BPS) {
      const sign = exitSlipBps > 0 ? '+' : '';
      const direction = exitSlipBps > 0 ? 'against us' : 'in our favour';
      alertOperator(
        `📏 Track D exit slippage · user_id=${row.user_id} · ${row.symbol} ${row.side} · ` +
          `signal $${args.signalPrice.toFixed(4)} → fill $${closeAvgPrice.toFixed(4)} = ${sign}${exitSlipBps} bps (${direction})`,
      );
    }
  }

  // PnL math — reuse calcPnl which knows about side + entry direction.
  // Pass original_sl (frozen at open) for R-multiple, matches our shadow
  // accounting convention.
  // Signature: calcPnl(side, entry, sl, closePrice) — historically this
  // call swapped sl/closePrice, which produced inverted pnl_pct and a
  // mirrored R-multiple. Audit C1, 2026-05-19.
  const slForR = row.original_sl ?? row.sl ?? row.entry;
  const pnl = calcPnl(
    row.side as 'long' | 'short',
    row.entry,
    slForR,
    closePrice,
  );

  closeUserDecision({
    id: row.id,
    closePrice,
    closeReason: 'manual',
    pnlPct: pnl.pnlPct,
    pnlR: pnl.pnlR,
    forceReason: args.forceReason,
    bybitCloseAvgPrice: closeAvgPrice,
  });
  return true;
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Non-critical operator log. Routed through the batch queue (audit H1)
 *  so a market-wide incident (50 users insufficient_balance in one
 *  minute) doesn't 429-rate-limit the bot. The queue waits up to
 *  ~1.5 sec to collect siblings then sends ONE digest message. */
function alertOperator(text: string): void {
  enqueueOperatorLog(text);
}

/** Critical-priority operator alert (notification on, immediate flush).
 *  Reserved for events where money is on the line and immediate human
 *  intervention may be needed (emergency close, decrypt fail). Always
 *  bypasses the queue — operator MUST see this without delay. */
async function alertOperatorCritical(text: string): Promise<void> {
  await sendMessage({ channel: 'logs', text, disable_notification: false }).catch(() => {});
}

/**
 * Audit H4 — close every active user position before the key is revoked.
 *
 * Called from /account/api-key/revoke. Without this, soft-deleting the
 * row leaves any open Bybit position permanently un-closable from our
 * side (we no longer have decrypted creds), and the user's only safety
 * net is the position-based SL Bybit holds on its own.
 *
 * Returns counts so the caller can flash a meaningful message:
 *   { attempted: N, succeeded: K, failed: N-K }
 *
 * On failure we still let the revoke proceed — the user explicitly
 * asked to disconnect. The flash message tells them which positions
 * they need to close manually on Bybit.
 */
export async function closeAllUserPositions(
  userId: number,
  reason: 'strategy_exit' | 'reverse_signal' = 'strategy_exit',
): Promise<{ attempted: number; succeeded: number; failed: number; failedSymbols: string[] }> {
  const rows = findActiveByUser(userId);
  if (rows.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, failedSymbols: [] };
  }
  let succeeded = 0;
  let failed = 0;
  const failedSymbols: string[] = [];
  await Promise.allSettled(
    rows.map((row) =>
      limit(async () => {
        if (!row.strategy_id) {
          failed++;
          failedSymbols.push(row.symbol);
          return;
        }
        const ok = await executeUserExit(row, {
          strategyId: row.strategy_id,
          symbol: row.symbol,
          forceReason: reason,
        });
        if (ok) succeeded++;
        else {
          failed++;
          failedSymbols.push(row.symbol);
        }
      }),
    ),
  );
  logger.info(
    { userId, attempted: rows.length, succeeded, failed },
    'closeAllUserPositions: done',
  );
  return { attempted: rows.length, succeeded, failed, failedSymbols };
}

/**
 * Audit C3 — verify SL attachment, with retries.
 *
 * Reads fetchPosition to see whether Bybit accepted the stopLoss param
 * from placeMarketOrder. If missing or far from target, calls
 * setPositionSL up to 3 times with backoff. Returns true only when the
 * position has a SL within 0.5% of the requested price. Returns false
 * if all retries fail OR if the position no longer exists (already
 * closed by SL during our retries, which is its own kind of "ok" but
 * we let the caller decide).
 *
 * 0.5% tolerance handles Bybit's tick-rounding of the stopLoss field
 * (BTC at 70000 has $1 ticks → 0.0014% rounding, well within tolerance).
 */
async function verifyOrAttachSL(
  creds: Parameters<typeof setPositionSL>[0],
  symbol: string,
  targetSl: number,
  userId: number,
): Promise<boolean> {
  const tolerance = 0.005; // 0.5%
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Position changes (fill, SL hit) propagate to /v5/position/list
    // within ~100ms. Wait a bit on the first read so we don't false-
    // positive on a freshly-opened position whose stopLoss hasn't
    // indexed yet.
    if (attempt === 1) await sleep(300);
    const posRes = await fetchPosition(creds, symbol);
    if (!posRes.ok) {
      logger.warn({ userId, code: posRes.code, attempt }, 'verifyOrAttachSL: fetchPosition failed');
      await sleep(500);
      continue;
    }
    if (!posRes.position || posRes.position.size === 0) {
      // Position no longer exists — either SL already triggered or the
      // user closed it on the website. Either way, no SL to verify.
      logger.warn({ userId, attempt }, 'verifyOrAttachSL: position vanished between order and verify');
      return false;
    }
    const attachedSl = posRes.position.stopLoss;
    if (attachedSl > 0 && Math.abs(attachedSl - targetSl) / targetSl < tolerance) {
      // All good.
      if (attempt > 1) {
        logger.info({ userId, attempt, sl: attachedSl }, 'verifyOrAttachSL: attached on retry');
      }
      return true;
    }
    logger.warn(
      { userId, attempt, attachedSl, targetSl },
      'verifyOrAttachSL: SL missing or off — re-attaching',
    );
    const setRes = await setPositionSL(creds, symbol, targetSl);
    if (!setRes.ok) {
      logger.error(
        { userId, attempt, code: setRes.code, msg: setRes.msg },
        'verifyOrAttachSL: setPositionSL retry failed',
      );
    }
    await sleep(500 * attempt); // 500, 1000, 1500
  }
  return false;
}

/** Audit C3 — last-resort: close the position via reduceOnly market.
 *  Used when SL never attached. We don't trust the position to remain
 *  flat in adverse markets even for the seconds between detection
 *  and close, but a market reduceOnly is the closest thing to a SL
 *  available without one. */
async function emergencyCloseUnprotected(
  creds: Parameters<typeof setPositionSL>[0],
  symbol: string,
  entrySide: 'long' | 'short',
  qty: number,
  shadowDecisionId: number,
  userId: number,
): Promise<boolean> {
  // Reverse the side: a long position closes with a Sell, short with Buy.
  const closeSide = entrySide === 'long' ? 'short' : 'long';
  const closeRes = await placeMarketOrder(creds, {
    symbol,
    side: closeSide,
    qty,
    reduceOnly: true,
    clientOrderId: `td-${shadowDecisionId}-u${userId}-emergclose`,
  });
  if (!closeRes.ok) {
    logger.error(
      { userId, code: closeRes.code, msg: closeRes.msg },
      'emergencyCloseUnprotected: close failed',
    );
    await alertOperatorCritical(
      `🚨🚨 Track D: emergency-close FAILED for user_id=${userId} ${symbol}. ` +
        `Position is OPEN AND UNPROTECTED. ${bybitErrorLabel(closeRes.code)}: ${closeRes.msg}. ` +
        `MANUAL CLOSE REQUIRED.`,
    );
    return false;
  }
  return true;
}

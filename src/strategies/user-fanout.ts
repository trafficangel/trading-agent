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
import {
  listEligibleTargets,
  type EligibleTarget,
} from '../db/repos/user-strategies.js';
import {
  findActiveKey,
  getDecryptedCreds,
  recordVerifyResult,
} from '../db/repos/user-api-keys.js';
import { hasActiveAccess } from '../db/repos/user-subscriptions.js';
import {
  insertDecision,
  findActiveUserDecisions,
  closeUserDecision,
  calcPnl,
} from '../db/repos/decisions.js';
import {
  setLeverage,
  placeMarketOrder,
  fetchOrderResult,
  roundContractQty,
  bybitErrorLabel,
} from '../exchange/bybit-private.js';
import { STRATEGY_CONFIGS, TRACK_C_NOTIONAL_USD } from './track-c-config.js';

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

function shouldMarkKeyBroken(code: number): boolean {
  return AUTH_CLASS_ERROR_CODES.has(code);
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
  // Re-check access right before placing the order — defends against
  // the race where access expired (or user cancelled) between
  // listEligibleTargets() and now. Without this we'd place a real
  // order on a sub'd-out user, then refuse to close it later (no key
  // for the next exit signal).
  if (!hasActiveAccess(t.user_id)) {
    logger.info({ userId: t.user_id }, 'fanOutEntry: access lapsed between query and execute');
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
    await alertOperator(`🚨 Не удалось расшифровать ключ user_id=${t.user_id}. Проверь API_KEY_MASTER_SECRET.`);
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
      await alertOperator(
        `ℹ️ Track D: user_id=${t.user_id} has an existing position on ${args.symbol}, skipping. Should close it on Bybit first.`,
      );
    } else {
      await alertOperator(
        `⚠️ Track D fan-out: user_id=${t.user_id} setLeverage(${args.symbol}, ${t.leverage}×) failed: ${label} · ${levRes.msg}`,
      );
    }
    return false;
  }

  // 2. Place market entry with atomic SL.
  const qty = roundContractQty(t.notional_usd / args.entry, args.symbol);
  if (qty <= 0) {
    logger.warn({ userId: t.user_id, notional: t.notional_usd, entry: args.entry }, 'fanOutEntry: qty rounded to 0');
    // Not an auth issue — don't poison the key.
    return false;
  }
  const clientOrderId = `td-${args.shadowDecisionId}-u${t.user_id}-e`;
  const orderRes = await placeMarketOrder(creds, {
    symbol: args.symbol,
    side: args.side,
    qty,
    stopLoss: args.sl,
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
    await alertOperator(
      `⚠️ Track D fan-out: user_id=${t.user_id} entry on ${args.symbol} failed: ${label} · ${orderRes.msg}`,
    );
    // Record the failure as an inactive decision row so it shows in the
    // user's history with order_error populated.
    insertDecision({
      symbol: args.symbol,
      side: args.side,
      entry: args.entry,
      sl: args.sl,
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

  // 4. Persist the user row.
  insertDecision({
    symbol: args.symbol,
    side: args.side,
    entry: avgPrice,
    sl: args.sl,
    reasoningShort: `Track D user fan-out · ${args.symbol} ${args.side} @${avgPrice}`,
    reasoningFull:
      `Strategy ${args.strategyId} → user_id=${t.user_id}\n` +
      `Notional: $${t.notional_usd} · Leverage: ${t.leverage}×\n` +
      `Qty: ${filledQty} · Avg price: ${avgPrice}\n` +
      `SL: ${args.sl} (attached atomically)\n` +
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
  return true;
}

export type FanOutExitArgs = {
  strategyId: string;
  symbol: string;
  forceReason: 'strategy_exit' | 'reverse_signal';
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
    await alertOperator(
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

  // PnL math — reuse calcPnl which knows about side + entry direction.
  // Pass original_sl (frozen at open) for R-multiple, matches our shadow
  // accounting convention.
  const pnl = calcPnl(
    row.side as 'long' | 'short',
    row.entry,
    closePrice,
    row.original_sl ?? row.sl ?? row.entry,
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

async function alertOperator(text: string): Promise<void> {
  await sendMessage({ channel: 'logs', text, disable_notification: true }).catch(() => {});
}

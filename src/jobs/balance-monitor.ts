/**
 * Track D — balance monitor.
 *
 * Every 5 minutes, for every active user (key connected + sub active),
 * refresh their Bybit USDT-equivalent balance and compute margin
 * sufficiency. Two outcomes:
 *
 *   1. balance >= required + used      → clear insufficient_balance_at
 *      (user topped up since the last check)
 *
 *   2. balance < required + used       → set insufficient_balance_at
 *      (user is short on margin; new signals will be skipped via the
 *      listEligibleTargets SQL filter). Telegram alert to operator
 *      the first time this transition happens for a user (not on every
 *      tick — we'd spam the logs channel).
 *
 * Why pre-flight here instead of inside fan-out:
 *   - Fan-out only triggers on a signal; a user could have insufficient
 *     balance for hours before the next signal fires. They open the
 *     cabinet and see "ключ подключён, всё ок" — confusing.
 *   - Bybit rejects an order with code 110007/110012 ONLY when the
 *     order is sent. Showing it preemptively requires a periodic poll.
 *
 * Cost: one /v5/account/wallet-balance request per active user every
 * 5 minutes. At 50 users that's 600/h = negligible vs Bybit's 50 req/s
 * global cap.
 */

import cron from 'node-cron';
import pLimit from 'p-limit';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import {
  getDecryptedCreds,
  recordBalance,
  setInsufficientBalance,
  type ApiKeyRow,
} from '../db/repos/user-api-keys.js';
import { fetchBalanceUsdt } from '../exchange/bybit-private.js';
import { sumEnabledRequiredMargin } from '../db/repos/user-strategies.js';
import { sumUsedMargin } from '../user/margin.js';
import { hasActiveAccess } from '../db/repos/user-subscriptions.js';

const limit = pLimit(5); // throttle parallel Bybit calls

const listActiveKeysStmt = db.prepare<[], ApiKeyRow>(`
  SELECT k.* FROM user_api_keys k
   WHERE k.revoked_at IS NULL
     AND k.last_verified_at IS NOT NULL
`);

async function tick(): Promise<void> {
  const keys = listActiveKeysStmt.all();
  if (keys.length === 0) return;
  await Promise.allSettled(keys.map((k) => limit(() => processOne(k))));
}

async function processOne(key: ApiKeyRow): Promise<void> {
  // Skip users whose subscription has lapsed — they aren't trading,
  // we shouldn't ping their API for a balance update.
  if (!hasActiveAccess(key.user_id)) return;

  let creds;
  try {
    creds = getDecryptedCreds(key);
  } catch (err) {
    // Decrypt failure already alerts via fan-out path; don't spam.
    logger.error({ err, userId: key.user_id }, 'balance-monitor: decrypt failed');
    return;
  }

  const balRes = await fetchBalanceUsdt(creds);
  if (!balRes.ok) {
    logger.warn(
      { userId: key.user_id, code: balRes.code, msg: balRes.msg },
      'balance-monitor: fetchBalance failed',
    );
    return;
  }

  const balance = balRes.totalUsdt;
  recordBalance(key.id, balance);

  const required = sumEnabledRequiredMargin(key.user_id);
  const used = sumUsedMargin(key.user_id);
  const need = required + used;
  // A small buffer: Bybit reserves a few % for fees + funding. We
  // require 1.05× the raw need so we don't flip the flag during the
  // last few cents of slack.
  const buffered = need * 1.05;

  const wasInsufficient = key.insufficient_balance_at !== null;
  const isInsufficient = balance < buffered && required > 0;

  if (isInsufficient && !wasInsufficient) {
    setInsufficientBalance(key.id, Date.now());
    logger.warn(
      { userId: key.user_id, balance, required, used, buffered },
      'balance-monitor: flipping to insufficient',
    );
    // First-transition alert. Telegram operator channel — silent (no
    // notification) so we don't get pinged 24/7. The user themselves
    // sees the dashboard banner.
    await sendMessage({
      channel: 'logs',
      text:
        `⚠️ Track D balance: user_id=${key.user_id} balance=$${balance.toFixed(2)} ` +
        `< buffered need $${buffered.toFixed(2)} (required $${required.toFixed(2)} + ` +
        `used $${used.toFixed(2)}). Trading blocked until top-up.`,
      disable_notification: true,
    }).catch(() => {});
  } else if (!isInsufficient && wasInsufficient) {
    // Recovered — user topped up. Clear flag.
    setInsufficientBalance(key.id, null);
    logger.info(
      { userId: key.user_id, balance, need },
      'balance-monitor: cleared insufficient flag — user recovered',
    );
    await sendMessage({
      channel: 'logs',
      text:
        `✅ Track D balance: user_id=${key.user_id} recovered. ` +
        `balance=$${balance.toFixed(2)} ≥ need $${buffered.toFixed(2)}. Trading resumed.`,
      disable_notification: true,
    }).catch(() => {});
  }
}

export function startBalanceMonitorJob(): void {
  // Every 5 minutes. Aligned with subscription-sweeper cadence.
  cron.schedule('*/5 * * * *', () => {
    void tick().catch((err) =>
      logger.error({ err }, 'balance-monitor: tick threw'),
    );
  });
  logger.info('balance monitor cron started (every 5 min)');
  // Also run once immediately at boot so a freshly-deployed server
  // doesn't wait 5 min before noticing a recently-topped-up user.
  setTimeout(() => void tick().catch(() => {}), 10_000);
}

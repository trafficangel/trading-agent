/**
 * Track D — balance monitor.
 *
 * Every 5 minutes, for every active user (key connected + sub active),
 * refresh their Bybit USDT-equivalent balance. Updates the cached
 * `last_balance_usdt` on the api-key row so the cabinet UI shows
 * current numbers without round-tripping to Bybit on each page load.
 *
 * Recovery path: if a user is currently flagged as insufficient
 * (set reactively by fan-out when a real order was rejected — see
 * `setInsufficientBalance` in user-fanout.ts) AND their balance now
 * covers the largest single-trade margin among their enabled
 * strategies, we clear the flag so the next signal can fire.
 *
 * What we DO NOT do: we no longer set the flag pre-emptively based
 * on the worst-case "all strategies fire concurrently" sum. That's a
 * scary number with rarely-realised semantics — users with $150 free
 * and $30 typical per-trade margin were being blocked because the
 * worst-case sum across 8 enabled strategies was $230. Per-trade
 * checks happen at fan-out time (executeUserEntry) and Bybit's own
 * rejection (110007/110012) — both reactive, both correct.
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
import { sumUsedMargin } from '../user/margin.js';
import { hasActiveAccess } from '../db/repos/user-subscriptions.js';
import { evaluateTierTransition } from '../user/tier-assignment.js';

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

  // Operator decision: minimum-balance is only a gate at activation, not
  // an ongoing constraint. Tier transitions (auto-downgrade after grace
  // period when balance falls below tier min) are disabled — the user
  // stays on whatever tier they picked, and the per-entry margin pre-
  // flight handles any signal that's literally too big to fit. Users
  // can manually pick a smaller tier in /account/subscription/select-tier
  // if they want to fit more strategies into a smaller balance.
  void evaluateTierTransition; // kept import for backwards compat / re-enable

  // Recovery: ONLY clear the flag if Bybit explicitly set it (via a real
  // rejection or per-trade pre-flight). Use the LARGEST single-trade
  // margin among enabled strategies as the recovery threshold — this is
  // what the next signal could plausibly need, so clearing here is safe.
  // We deliberately do NOT use the worst-case sum across all strategies:
  // that produces false-positives where a user with plenty of free
  // funds is blocked because a hypothetical concurrent-fire scenario
  // wouldn't fit.
  const wasInsufficient = key.insufficient_balance_at !== null;
  if (!wasInsufficient) return;

  const largestTrade = getLargestSingleTradeMargin(key.user_id);
  const used = sumUsedMargin(key.user_id);
  const free = balance - used;
  // Buffer covers fees + slippage. Recovery is conservative — better
  // to wait one more tick than to clear, get rejected, set again.
  const buffered = largestTrade * 1.10;

  if (free >= buffered) {
    setInsufficientBalance(key.id, null);
    logger.info(
      { userId: key.user_id, balance, free, largestTrade, buffered },
      'balance-monitor: cleared insufficient flag — user recovered',
    );
    await sendMessage({
      channel: 'logs',
      text:
        `✅ Track D balance: user_id=${key.user_id} recovered. ` +
        `free=$${free.toFixed(2)} ≥ largest-trade need $${buffered.toFixed(2)}. Trading resumed.`,
      disable_notification: true,
    }).catch(() => {});
  }
  // If still insufficient, do nothing. The cabinet UI shows the banner
  // until the user tops up or balance grows enough that next tick clears it.
}

const largestSingleTradeStmt = db.prepare<[number], { max_margin: number | null }>(`
  SELECT MAX(notional_usd / leverage) AS max_margin
    FROM user_strategies
   WHERE user_id = ? AND enabled = 1 AND leverage > 0
`);

/** Per-trade margin needed for the SINGLE biggest enabled strategy.
 *  This is the realistic "could the next signal fire" threshold, vs
 *  the scary worst-case sum (which assumes all 9 strategies fire at
 *  the exact same tick — practically impossible across different
 *  symbols + timeframes). */
function getLargestSingleTradeMargin(userId: number): number {
  return largestSingleTradeStmt.get(userId)?.max_margin ?? 0;
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

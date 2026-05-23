/**
 * Crash-recovery monitor — audit M-NEW-4.
 *
 * Problem this catches: a server crash (OS-level, not graceful) between
 * `placeMarketOrder.ok` and `insertDecision.run()` leaves a position
 * open on Bybit that has NO corresponding decision row in our DB. The
 * Bybit-side safety SL still protects from runaway loss, but:
 *   - the user sees nothing in /account/trades (their funds appear stuck)
 *   - tpsl-monitor can't track it (no row to iterate)
 *   - strategy_exit webhook can't close it (findActiveUserDecisions
 *     returns empty)
 *   - reconcile path doesn't help because reconcile starts FROM a row
 *
 * Detection: every 10 minutes, for every active user, read
 * /v5/position/list (all symbols). For each Bybit position, look up
 * a matching active decision row (`bybit_qty` + `symbol` + `side`).
 * Mismatch → operator alert (Critical channel) with full context.
 *
 * We DO NOT auto-close or auto-insert. The orphan could legitimately
 * be a manual position the user opened on the Bybit website (we don't
 * own those). Operator decides per case.
 *
 * Costs: 1 `/v5/position/list` per active user every 10 min. At 50
 * users = 300 calls/h, well under Bybit's 50 req/s account-info cap.
 */

import cron from 'node-cron';
import pLimit from 'p-limit';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import {
  getDecryptedCreds,
  type ApiKeyRow,
} from '../db/repos/user-api-keys.js';
import { fetchAllPositions } from '../exchange/bybit-private.js';
import { findActiveByUser } from '../db/repos/decisions.js';
import { hasActiveAccess } from '../db/repos/user-subscriptions.js';
import { config } from '../config.js';

// Operator-controlled allowlist of user_ids that should NEVER receive
// orphan-position alerts. Parsed from ORPHAN_ALERT_SKIP_USER_IDS env once
// at module load — runtime changes require a service restart, which is
// fine for an ops-only toggle.
const SKIP_ORPHAN_ALERT_USER_IDS = new Set<number>(
  config.ORPHAN_ALERT_SKIP_USER_IDS
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
);

const limit = pLimit(5);
let running = false;

const listActiveKeysStmt = db.prepare<[], ApiKeyRow>(`
  SELECT k.* FROM user_api_keys k
   WHERE k.revoked_at IS NULL
     AND k.last_verified_at IS NOT NULL
`);

// Phase O — dedup alerts per orphan position so the operator doesn't get
// "ORPHAN POSITION DETECTED" every 10 minutes for the same manual trade.
//   - Map<fingerprint, last_alerted_ms>
//   - Fingerprint = user_id|symbol|side|qty_rounded — stable across ticks
//   - Alert at most once per 12 hours per fingerprint
//   - In-memory only: on server restart everyone gets one fresh alert
//     (acceptable; the operator wants to know after a restart anyway)
const ALERT_DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;
const alertedOrphans = new Map<string, number>();
function orphanFingerprint(
  userId: number,
  pos: { symbol: string; side: string | null; size: number },
): string {
  return `${userId}|${pos.symbol}|${pos.side ?? '?'}|${pos.size.toFixed(4)}`;
}
// Periodic cleanup so the map doesn't grow unbounded over months.
function pruneExpiredAlertCache(now: number): void {
  for (const [fp, ts] of alertedOrphans) {
    if (now - ts > ALERT_DEDUP_WINDOW_MS) alertedOrphans.delete(fp);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    pruneExpiredAlertCache(Date.now());
    const keys = listActiveKeysStmt.all();
    if (keys.length === 0) return;
    await Promise.allSettled(keys.map((k) => limit(() => processOne(k))));
  } finally {
    running = false;
  }
}

async function processOne(key: ApiKeyRow): Promise<void> {
  if (!hasActiveAccess(key.user_id)) return;
  // Operator skip-list — user opens manual positions on Bybit deliberately
  // (e.g. operator's own account), no point re-detecting them as orphans.
  if (SKIP_ORPHAN_ALERT_USER_IDS.has(key.user_id)) return;
  let creds;
  try {
    creds = getDecryptedCreds(key);
  } catch (err) {
    logger.error({ err, userId: key.user_id }, 'recovery: decrypt failed');
    return;
  }
  const res = await fetchAllPositions(creds);
  if (!res.ok) {
    logger.warn(
      { userId: key.user_id, code: res.code, msg: res.msg },
      'recovery: fetchAllPositions failed',
    );
    return;
  }
  if (res.positions.length === 0) return;

  const ourRows = findActiveByUser(key.user_id);
  const orphans = [];
  for (const pos of res.positions) {
    // Match: a row with same symbol + side + qty within tolerance.
    // 1% qty tolerance covers fee deductions in size (rare for linear
    // perps but not impossible) and any tiny rounding diffs.
    const matched = ourRows.find((r) => {
      if (r.symbol !== pos.symbol) return false;
      if (r.side !== pos.side) return false;
      if (!r.bybit_qty) return false;
      return Math.abs(r.bybit_qty - pos.size) / pos.size < 0.01;
    });
    if (!matched) orphans.push(pos);
  }

  if (orphans.length === 0) return;

  // Dedup: only keep orphans we haven't alerted about in the last 12 hours.
  const now = Date.now();
  const newOrphans = orphans.filter((p) => {
    const fp = orphanFingerprint(key.user_id, p);
    const last = alertedOrphans.get(fp);
    if (last && now - last < ALERT_DEDUP_WINDOW_MS) return false;
    alertedOrphans.set(fp, now);
    return true;
  });
  if (newOrphans.length === 0) {
    // All orphans already alerted in this window — silent and log only.
    logger.info(
      { userId: key.user_id, suppressedCount: orphans.length },
      'recovery: orphans still present but alerts suppressed (dedup window)',
    );
    return;
  }
  const summary = newOrphans
    .map((p) => `${p.symbol} ${p.side ?? '?'} ${p.size} @${p.avgPrice} (SL=${p.stopLoss || 'none'})`)
    .join('; ');
  logger.error({ userId: key.user_id, orphans: summary }, 'recovery: orphan positions detected');
  // Critical alert — operator must investigate. NOT routed through the
  // batch queue: orphans usually mean an OS-crash incident, operator
  // must see it immediately. Subsequent ticks within ALERT_DEDUP_WINDOW_MS
  // for the same fingerprint are suppressed.
  await sendMessage({
    channel: 'logs',
    text:
      `🚨 <b>ORPHAN POSITION DETECTED</b>\n` +
      `user_id=${key.user_id} has ${newOrphans.length} open position(s) on Bybit with NO matching ` +
      `active decision row:\n<code>${summary}</code>\n\n` +
      `<i>Likely cause: server crashed between placeMarketOrder and insertDecision, or user opened the ` +
      `position manually on Bybit. Investigate before closing — may be intentional. ` +
      `Re-alert suppressed for 12 hours.</i>`,
    disable_notification: false,
  }).catch((err) => {
    logger.error({ err }, 'recovery: alert send failed');
  });
}

export function startRecoveryMonitorJob(): void {
  cron.schedule('*/10 * * * *', () => {
    void tick().catch((err) => logger.error({ err }, 'recovery-monitor tick threw'));
  });
  logger.info('recovery monitor cron started (every 10 min)');
}

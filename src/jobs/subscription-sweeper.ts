/**
 * Subscription lifecycle housekeeping.
 *
 * Two crons in one file:
 *   1. Sweeper (every 5 min) — flip status to 'expired' for any sub
 *      whose access_until has passed. Without this, cabinet UI keeps
 *      showing «Демо доступ · −5 дней» which is confusing and the
 *      operator can't quickly tell which trials need converting.
 *
 *   2. Expiry notifier (daily 09:00 UTC) — for any sub expiring in the
 *      next 24-48h that hasn't been notified yet, send a heads-up to
 *      the Logs channel (and DM the user if we had their TG user_id —
 *      future). Sets `expiry_notified_at` so we don't ping twice.
 *
 * VIP subs are skipped — their access_until is sentinel year-2099,
 * so they'll never match either query in practice.
 */

import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { listOverdue, setStatus } from '../db/repos/user-subscriptions.js';
import type { SubscriptionRow } from '../db/repos/user-subscriptions.js';
import { closeAllUserPositions } from '../strategies/user-fanout.js';

const findExpiringSoonStmt = db.prepare<[number, number], SubscriptionRow & { phone: string | null; display_name: string | null }>(`
  SELECT s.*, r.phone, r.display_name
    FROM user_subscriptions s
    JOIN registrations r ON r.id = s.user_id
   WHERE s.status IN ('trial', 'active')
     AND s.plan = 'standard'
     AND s.access_until BETWEEN ? AND ?
     AND s.expiry_notified_at IS NULL
`);

const markNotifiedStmt = db.prepare(`
  UPDATE user_subscriptions SET expiry_notified_at = ?, updated_at = ? WHERE user_id = ?
`);

async function sweepExpired(): Promise<void> {
  const overdue = listOverdue();
  if (overdue.length === 0) return;
  for (const sub of overdue) {
    try {
      // Audit C2 — close open positions BEFORE flipping to 'expired'.
      // Without this, the user's access lapses while positions on Bybit
      // are still open and bound to their key. fanOutExit later won't
      // include them (listEligibleTargets filters expired), so a normal
      // strategy_exit signal can't close their position via our system.
      // The Bybit-side safety SL would still trigger on adverse move,
      // but a winning position would stay open indefinitely. Close
      // cleanly now while the key is still active.
      const closeStats = await closeAllUserPositions(sub.user_id, 'strategy_exit');
      if (closeStats.attempted > 0) {
        logger.info(
          { user_id: sub.user_id, closeStats },
          'sub-sweeper: closed positions before expiring',
        );
      }
      setStatus(sub.user_id, 'expired');
      logger.info({ user_id: sub.user_id }, 'sub-sweeper: status → expired');
    } catch (err) {
      logger.error({ err, user_id: sub.user_id }, 'sub-sweeper: expire flow failed');
    }
  }
}

async function notifyExpiringSoon(): Promise<void> {
  const now = Date.now();
  const tomorrow = now + 24 * 3600 * 1000;
  const dayAfter = now + 48 * 3600 * 1000;
  const rows = findExpiringSoonStmt.all(tomorrow, dayAfter);
  if (rows.length === 0) return;
  for (const r of rows) {
    const name = r.display_name ?? '<i>no name</i>';
    const text =
      `⏰ <b>Триал истекает через 24-48 часов</b>\n` +
      `🪪 ${escapeHtml(name)}\n` +
      `📞 <code>${r.phone ?? '—'}</code>\n` +
      `Истечёт: ${new Date(r.access_until).toISOString()}\n` +
      `<i>Напомните оператору связаться для продления.</i>`;
    try {
      await sendMessage({ channel: 'logs', text, disable_notification: false });
      markNotifiedStmt.run(Date.now(), Date.now(), r.user_id);
      logger.info({ user_id: r.user_id }, 'sub-sweeper: expiry notice sent');
    } catch (err) {
      logger.error({ err, user_id: r.user_id }, 'sub-sweeper: expiry notice failed');
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

export function startSubscriptionSweeperJob(): void {
  // Sweeper: every 5 minutes. SQLite is fast, query is indexed.
  cron.schedule('*/5 * * * *', () => {
    void sweepExpired().catch((err) => {
      logger.error({ err }, 'sub-sweeper tick failed');
    });
  });
  // Notifier: daily at 09:00 UTC.
  cron.schedule('0 9 * * *', () => {
    void notifyExpiringSoon();
  });
  logger.info('subscription-sweeper cron started (sweep 5min, notify daily 09:00 UTC)');
}

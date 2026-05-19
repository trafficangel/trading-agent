/**
 * user_subscriptions repo — per-user access state for SaaS copytrading.
 *
 * Auto-created on first phone-OTP registration with status='trial' and
 * access_until = now + TRACK_D_TRIAL_DAYS. Admin extends manually until
 * payment automation is built.
 */

import { db } from '../client.js';
import { config } from '../../config.js';

export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'cancelled';

export type SubscriptionRow = {
  id: number;
  user_id: number;
  status: SubscriptionStatus;
  trial_started_at: number;
  access_until: number;
  manually_extended_by: string | null;
  manual_extension_note: string | null;
  created_at: number;
  updated_at: number;
};

const insertStmt = db.prepare(`
  INSERT INTO user_subscriptions
    (user_id, status, trial_started_at, access_until, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?)
`);

const findByUserStmt = db.prepare<[number], SubscriptionRow>(`
  SELECT * FROM user_subscriptions WHERE user_id = ? LIMIT 1
`);

const extendStmt = db.prepare(`
  UPDATE user_subscriptions
     SET access_until = ?, status = ?, manually_extended_by = ?,
         manual_extension_note = ?, updated_at = ?
   WHERE user_id = ?
`);

const setStatusStmt = db.prepare(`
  UPDATE user_subscriptions SET status = ?, updated_at = ? WHERE user_id = ?
`);

const listExpiringStmt = db.prepare<[number, number], SubscriptionRow>(`
  SELECT * FROM user_subscriptions
   WHERE status IN ('trial', 'active') AND access_until BETWEEN ? AND ?
   ORDER BY access_until ASC
`);

const listExpiredStillActiveStmt = db.prepare<[number], SubscriptionRow>(`
  SELECT * FROM user_subscriptions
   WHERE status IN ('trial', 'active') AND access_until < ?
`);

/** Initialise a fresh trial subscription on registration. Idempotent —
 *  if a row already exists (race / re-registration) we keep the
 *  original trial period. */
export function ensureTrialFor(userId: number): SubscriptionRow {
  const existing = findByUserStmt.get(userId);
  if (existing) return existing;
  const now = Date.now();
  const trialMs = config.TRACK_D_TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const accessUntil = now + trialMs;
  insertStmt.run(userId, 'trial', now, accessUntil, now, now);
  const created = findByUserStmt.get(userId);
  if (!created) {
    throw new Error(`ensureTrialFor: failed to read back row for user_id=${userId}`);
  }
  return created;
}

export function findSubscription(userId: number): SubscriptionRow | null {
  return findByUserStmt.get(userId) ?? null;
}

/** Return true when the user currently has access (status != expired/cancelled
 *  AND access_until > now). */
export function hasActiveAccess(userId: number, now = Date.now()): boolean {
  const sub = findByUserStmt.get(userId);
  if (!sub) return false;
  if (sub.status === 'expired' || sub.status === 'cancelled') return false;
  return sub.access_until > now;
}

/**
 * Admin extends a subscription. `extraDays` is added to whichever is
 * later: current access_until or now() — so extending an expired sub
 * grants `extraDays` from today, not from the past expiry date.
 */
export function adminExtend(
  userId: number,
  extraDays: number,
  adminEmail: string,
  note: string | null,
): SubscriptionRow {
  const sub = findByUserStmt.get(userId);
  if (!sub) throw new Error(`adminExtend: no subscription for user_id=${userId}`);
  const now = Date.now();
  const base = Math.max(sub.access_until, now);
  const newAccessUntil = base + extraDays * 24 * 60 * 60 * 1000;
  // Status: extending a paying user keeps them 'active'; extending an
  // expired/trial user promotes them to 'active' (assumed payment).
  const newStatus: SubscriptionStatus = 'active';
  extendStmt.run(newAccessUntil, newStatus, adminEmail, note ?? null, now, userId);
  const updated = findByUserStmt.get(userId);
  if (!updated) throw new Error('adminExtend: row vanished');
  return updated;
}

export function setStatus(userId: number, status: SubscriptionStatus): void {
  setStatusStmt.run(status, Date.now(), userId);
}

/** Used by the expiry-sweeper cron: returns subs that should flip to
 *  status='expired'. Caller iterates + calls setStatus(). */
export function listOverdue(now = Date.now()): SubscriptionRow[] {
  return listExpiredStillActiveStmt.all(now);
}

/** Used by the "your trial expires soon" notifier (future feature). */
export function listExpiringBetween(start: number, end: number): SubscriptionRow[] {
  return listExpiringStmt.all(start, end);
}

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
/** 'standard' = pays per tier. 'comp' = complimentary lifetime free
 *  access (operator / partners) — grantable on top of ANY tier,
 *  independent of the VIP *tier* (which is just a paid $580/mo tier). */
export type SubscriptionPlan = 'standard' | 'comp';

/** When granting comp (free lifetime) access we set access_until to far
 *  future (year 2099) so the column stays meaningful + sortable;
 *  hasActiveAccess() also short-circuits on plan='comp' so the date is
 *  just a backstop. */
export const COMP_ACCESS_UNTIL = Date.UTC(2099, 11, 31, 23, 59, 59);

export type SubscriptionRow = {
  id: number;
  user_id: number;
  status: SubscriptionStatus;
  plan: SubscriptionPlan;
  trial_started_at: number;
  access_until: number;
  manually_extended_by: string | null;
  manual_extension_note: string | null;
  created_at: number;
  updated_at: number;
  /** User-controlled trading pause. NULL = active, ms = paused at.
   *  When set, fan-out skips this user; open positions keep running. */
  trading_paused_at: number | null;
  /** TRACK E — auto-tier. 'starter' by default for new rows. */
  tier_id: string;
  /** Phase G — user's CHOSEN tier (set by /account/subscription/select-tier).
   *  NULL until they visit the picker. May differ from tier_id (which is
   *  the ACTIVE tier set by assignTier once balance is sufficient). */
  selected_tier_id: string | null;
  /** TRACK E — VIP override fields. NULL = use tier defaults. */
  tier_override_strategies: string | null;  // JSON array
  tier_override_margin: number | null;
  tier_override_leverage: string | null;    // JSON map
  /** TRACK E — anti-flap state for transition timing. */
  tier_transition_target_id: string | null;
  tier_transition_first_seen_at: number | null;
  /** TRACK E Phase E2 — money-back guarantee accounting.
   *  paid_started_at: ms when the user first transitioned to PAID. Until set,
   *  the user is on trial / bonus and the guarantee doesn't apply. */
  paid_started_at: number | null;
  last_pnl_guarantee_at: number | null;
  last_pnl_guarantee_month: string | null;       // YYYY-MM
  last_pnl_guarantee_pnl_usd: number | null;     // negative value when applied
};

// TRACK E — trial users get tier_id='standard' for a better first
// impression (5 strategies, larger margin pool than starter). If they
// connect a key with low balance, balance-monitor's evaluateTierTransition
// will downgrade them within 72h as normal.
const insertStmt = db.prepare(`
  INSERT INTO user_subscriptions
    (user_id, status, trial_started_at, access_until, tier_id, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, 'standard', ?, ?)
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

/** Return true when the user currently has access. VIP plan grants
 *  unconditional access (no trial countdown, no expiry). Standard plan
 *  requires status != expired/cancelled AND access_until > now.
 *  Paused state is NOT considered here — paused users still have access
 *  (they need to be able to log into the cabinet to unpause). For
 *  fan-out gating use isTradingActive() instead. */
export function hasActiveAccess(userId: number, now = Date.now()): boolean {
  const sub = findByUserStmt.get(userId);
  if (!sub) return false;
  if (sub.plan === 'comp') return sub.status !== 'cancelled';
  if (sub.status === 'expired' || sub.status === 'cancelled') return false;
  return sub.access_until > now;
}

/** Stricter check used right before fan-out fires an order: hasActiveAccess
 *  AND the user hasn't paused trading. Defends against the race where
 *  the user clicks "Pause" between listEligibleTargets() and the actual
 *  placeMarketOrder call. */
export function isTradingActive(userId: number, now = Date.now()): boolean {
  if (!hasActiveAccess(userId, now)) return false;
  const sub = findByUserStmt.get(userId);
  return !!sub && sub.trading_paused_at === null;
}

/**
 * Admin extends a subscription. `extraDays` is added to whichever is
 * later: current access_until or now() — so extending an expired sub
 * grants `extraDays` from today, not from the past expiry date.
 *
 * Phase E2: by default this marks paid_started_at on first call (so the
 * money-back guarantee starts counting). Pass `markPaidStart: false` for
 * free/bonus extensions (Bybit-referral bonus, gift extension by operator)
 * that don't represent a paid month.
 */
export function adminExtend(
  userId: number,
  extraDays: number,
  adminEmail: string,
  note: string | null,
  opts: { markPaidStart?: boolean } = {},
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
  // Stamp paid_started_at the FIRST time admin extends as a paid renewal.
  // Bybit-bonus and free extensions should pass markPaidStart=false to
  // skip this side-effect.
  const markPaidStart = opts.markPaidStart !== false;
  if (markPaidStart && !sub.paid_started_at) {
    db.prepare('UPDATE user_subscriptions SET paid_started_at = ?, updated_at = ? WHERE user_id = ?')
      .run(now, now, userId);
  }
  const updated = findByUserStmt.get(userId);
  if (!updated) throw new Error('adminExtend: row vanished');
  return updated;
}

/** TRACK E Phase E2 — apply money-back guarantee for a given user/month.
 *  Idempotent: callers must check `last_pnl_guarantee_month` before calling.
 *  Extends access_until by ~30 days (no charge for next month) and stamps
 *  the audit fields. */
export function applyPnlGuarantee(
  userId: number,
  monthYyyymm: string,
  pnlUsd: number,
): SubscriptionRow {
  const sub = findByUserStmt.get(userId);
  if (!sub) throw new Error(`applyPnlGuarantee: no subscription for user_id=${userId}`);
  const now = Date.now();
  const base = Math.max(sub.access_until, now);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const newAccessUntil = base + THIRTY_DAYS_MS;
  db.prepare(`
    UPDATE user_subscriptions
       SET access_until = ?,
           status = 'active',
           last_pnl_guarantee_at = ?,
           last_pnl_guarantee_month = ?,
           last_pnl_guarantee_pnl_usd = ?,
           updated_at = ?
     WHERE user_id = ?
  `).run(newAccessUntil, now, monthYyyymm, pnlUsd, now, userId);
  const updated = findByUserStmt.get(userId);
  if (!updated) throw new Error('applyPnlGuarantee: row vanished');
  return updated;
}

/** Returns users eligible for the monthly PnL-guarantee sweep:
 *   - status='active' (paying subs only, not trial/expired/cancelled)
 *   - plan='standard' (VIP has its own success-fee accounting)
 *   - paid_started_at IS NOT NULL AND paid_started_at < startOfPrevMonth
 *     (must have been paying for the FULL evaluated month)
 *   - last_pnl_guarantee_month != evaluatedMonth (idempotency)
 */
export function listPnlGuaranteeCandidates(
  startOfPrevMonth: number,
  evaluatedMonthYyyymm: string,
): SubscriptionRow[] {
  return db.prepare<[number, string], SubscriptionRow>(`
    SELECT * FROM user_subscriptions
     WHERE status = 'active'
       AND plan = 'standard'
       AND paid_started_at IS NOT NULL
       AND paid_started_at < ?
       AND (last_pnl_guarantee_month IS NULL OR last_pnl_guarantee_month != ?)
  `).all(startOfPrevMonth, evaluatedMonthYyyymm);
}

export function setStatus(userId: number, status: SubscriptionStatus): void {
  setStatusStmt.run(status, Date.now(), userId);
}

/** Phase G — store the user's tier choice without necessarily activating it.
 *  assignTier (called separately when balance is sufficient) is what
 *  actually creates user_strategies rows. */
export function setSelectedTier(userId: number, tierId: string | null): void {
  db.prepare('UPDATE user_subscriptions SET selected_tier_id = ?, updated_at = ? WHERE user_id = ?')
    .run(tierId, Date.now(), userId);
}

const cancelStmt = db.prepare(`
  UPDATE user_subscriptions
     SET status = 'cancelled',
         manually_extended_by = ?,
         manual_extension_note = ?,
         updated_at = ?
   WHERE user_id = ?
`);

/**
 * Audit H6 — explicit cancel state. Distinct from 'expired' (natural
 * end-of-paid-period) — 'cancelled' means the user (or admin acting on
 * their behalf) deliberately ended the subscription before its expiry.
 * Both block trading via hasActiveAccess(), but the cabinet UI shows
 * different copy ("отменена" vs "истекла") and admin can filter on
 * status to follow up. Re-activating a cancelled user requires explicit
 * adminExtend() or setPlan() — the cancel doesn't lapse on its own.
 *
 * Trading positions are NOT closed here — call closeAllUserPositions
 * from the caller if needed. (Future cabinet "cancel my subscription"
 * button will call both.)
 */
export function cancelSubscription(
  userId: number,
  byAdmin: string,
  reason: string | null = null,
): void {
  cancelStmt.run(byAdmin, reason, Date.now(), userId);
}

const setPausedStmt = db.prepare(`
  UPDATE user_subscriptions SET trading_paused_at = ?, updated_at = ? WHERE user_id = ?
`);

/** Pause/resume the user's autotrading globally. While paused,
 *  listEligibleTargets excludes them so no new orders fan out;
 *  existing open positions keep running normally. */
export function setTradingPaused(userId: number, paused: boolean): void {
  setPausedStmt.run(paused ? Date.now() : null, Date.now(), userId);
}

/** List user_ids with trading currently ENABLED — used by the admin
 *  emergency-stop button to figure out who to pause. */
const listTradingActiveUserIdsStmt = db.prepare<[number], { user_id: number }>(`
  SELECT user_id FROM user_subscriptions
   WHERE status IN ('trial', 'active')
     AND access_until > ?
     AND trading_paused_at IS NULL
`);
export function listTradingActiveUserIds(now = Date.now()): number[] {
  return listTradingActiveUserIdsStmt.all(now).map((r) => r.user_id);
}

/** Bulk-pause every currently-trading user in one transaction. Returns
 *  the number of rows touched. Used by /admin/emergency-stop. */
const bulkPauseStmt = db.prepare(`
  UPDATE user_subscriptions
     SET trading_paused_at = ?, updated_at = ?
   WHERE status IN ('trial', 'active')
     AND access_until > ?
     AND trading_paused_at IS NULL
`);
export function bulkPauseAllTrading(): number {
  const now = Date.now();
  const res = bulkPauseStmt.run(now, now, now);
  return res.changes;
}

/** Bulk-resume every paused user. WARNING: this clears trading_paused_at
 *  for users who paused themselves too — operator should call this only
 *  when undoing an emergency stop, not as a routine action. */
const bulkResumeStmt = db.prepare(`
  UPDATE user_subscriptions
     SET trading_paused_at = NULL, updated_at = ?
   WHERE trading_paused_at IS NOT NULL
`);
export function bulkResumeAllTrading(): number {
  const res = bulkResumeStmt.run(Date.now());
  return res.changes;
}

const setPlanStmt = db.prepare(`
  UPDATE user_subscriptions
     SET plan = ?, status = ?, access_until = ?,
         manually_extended_by = ?, manual_extension_note = ?, updated_at = ?
   WHERE user_id = ?
`);

/**
 * Promote a user to VIP (perpetual access) or demote them back to
 * standard. The audit fields (manually_extended_by + note) are
 * overwritten on every change so the operator can trace who flipped
 * the plan and why.
 *
 * Granting comp (free lifetime): status forced to 'active', access_until
 * pushed to COMP_ACCESS_UNTIL (year 2099). Revoking to standard: status
 * forced to 'expired' and access_until set to now() — the operator should
 * then manually extend if they want the user to keep paid access.
 */
export function setPlan(
  userId: number,
  plan: SubscriptionPlan,
  byAdmin: string,
  note: string | null = null,
): SubscriptionRow {
  const sub = findByUserStmt.get(userId);
  if (!sub) throw new Error(`setPlan: no subscription for user_id=${userId}`);
  const now = Date.now();
  const nextStatus: SubscriptionStatus = plan === 'comp' ? 'active' : 'expired';
  const nextAccess = plan === 'comp' ? COMP_ACCESS_UNTIL : now;
  setPlanStmt.run(plan, nextStatus, nextAccess, byAdmin, note, now, userId);
  const updated = findByUserStmt.get(userId);
  if (!updated) throw new Error('setPlan: row vanished');
  return updated;
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

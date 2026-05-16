/**
 * Session management for the gated stats area.
 *
 * Schema is in migration 013. We store:
 *   - `registrations` row per verified phone (90-day sessions)
 *   - `verification_attempts` row per in-flight code request
 *
 * Cookie strategy:
 *   - `sid` (90 days) — points at registrations.session_id
 *   - `pending_auth` (10 min) — request_id between /auth/start and
 *     /auth/verify
 *
 * Both HttpOnly + Secure + SameSite=Lax. Cookie values are not signed
 * (we don't store anything sensitive in them); the session_id itself
 * is a 128-bit random string, unguessable.
 */

import crypto from 'node:crypto';
import { db } from '../db/client.js';

export const SESSION_COOKIE = 'sid';
export const PENDING_COOKIE = 'pending_auth';
export const SESSION_TTL_DAYS = 90;
export const PENDING_TTL_SEC = 600; // 10 min

export function hashPhone(phoneE164: string): string {
  return crypto.createHash('sha256').update(phoneE164.trim()).digest('hex');
}

export function generateSessionId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

type RegistrationRow = {
  id: number;
  phone_hash: string;
  tg_user_id: number | null;
  session_id: string;
  created_at: number;
  last_seen_at: number;
};

const findBySessionStmt = db.prepare<[string], RegistrationRow>(
  `SELECT * FROM registrations WHERE session_id = ?`,
);

const findByPhoneStmt = db.prepare<[string], RegistrationRow>(
  `SELECT * FROM registrations WHERE phone_hash = ? ORDER BY id DESC LIMIT 1`,
);

const insertRegistrationStmt = db.prepare(`
  INSERT INTO registrations (
    phone_hash, tg_user_id, session_id, created_at, last_seen_at,
    ip_first, user_agent_first
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeenStmt = db.prepare(`
  UPDATE registrations SET last_seen_at = ? WHERE session_id = ?
`);

const updateSessionStmt = db.prepare(`
  UPDATE registrations
  SET session_id = ?, last_seen_at = ?
  WHERE id = ?
`);

const countStmt = db.prepare<[], { c: number }>(
  `SELECT COUNT(*) AS c FROM registrations`,
);

const recentStmt = db.prepare<[number], { c: number }>(
  `SELECT COUNT(*) AS c FROM registrations WHERE created_at >= ?`,
);

export function findSession(sessionId: string): RegistrationRow | null {
  return findBySessionStmt.get(sessionId) ?? null;
}

export function touchSession(sessionId: string): void {
  updateLastSeenStmt.run(Date.now(), sessionId);
}

/**
 * Register a verified phone. If we've seen this phone before, rotate
 * the session_id (so a new device gets a fresh cookie) and return that.
 * If not, create a new registration row.
 */
export function registerOrRefresh(
  phoneHash: string,
  ip: string | null,
  userAgent: string | null,
  tgUserId?: number | null,
): { sessionId: string; isNew: boolean } {
  const sessionId = generateSessionId();
  const now = Date.now();
  const existing = findByPhoneStmt.get(phoneHash);
  if (existing) {
    updateSessionStmt.run(sessionId, now, existing.id);
    return { sessionId, isNew: false };
  }
  insertRegistrationStmt.run(
    phoneHash,
    tgUserId ?? null,
    sessionId,
    now,
    now,
    ip,
    userAgent,
  );
  return { sessionId, isNew: true };
}

// --- verification_attempts (pending verification state) ---

type VerifAttemptRow = {
  request_id: string;
  phone_hash: string;
  code: string | null;
  created_at: number;
  attempts: number;
  ip: string | null;
  user_agent: string | null;
};

const findAttemptStmt = db.prepare<[string], VerifAttemptRow>(
  `SELECT * FROM verification_attempts WHERE request_id = ?`,
);

const insertAttemptStmt = db.prepare(`
  INSERT INTO verification_attempts (request_id, phone_hash, code, created_at, attempts, ip, user_agent)
  VALUES (?, ?, ?, ?, 0, ?, ?)
`);

const incAttemptStmt = db.prepare(
  `UPDATE verification_attempts SET attempts = attempts + 1 WHERE request_id = ?`,
);

const deleteAttemptStmt = db.prepare(
  `DELETE FROM verification_attempts WHERE request_id = ?`,
);

const purgeOldStmt = db.prepare(
  `DELETE FROM verification_attempts WHERE created_at < ?`,
);

export function recordVerificationAttempt(
  requestId: string,
  phoneHash: string,
  code: string,
  ip: string | null,
  userAgent: string | null,
): void {
  // Purge anything older than 1h to keep the table tidy.
  purgeOldStmt.run(Date.now() - 60 * 60 * 1000);
  insertAttemptStmt.run(requestId, phoneHash, code, Date.now(), ip, userAgent);
}

export function getVerificationAttempt(requestId: string): VerifAttemptRow | null {
  return findAttemptStmt.get(requestId) ?? null;
}

export function bumpVerificationAttempts(requestId: string): void {
  incAttemptStmt.run(requestId);
}

export function clearVerificationAttempt(requestId: string): void {
  deleteAttemptStmt.run(requestId);
}

// --- Stats for admin / dashboards ---

export function getRegistrationStats(): { total: number; last24h: number; last7d: number } {
  const now = Date.now();
  return {
    total: countStmt.get()?.c ?? 0,
    last24h: recentStmt.get(now - 24 * 60 * 60 * 1000)?.c ?? 0,
    last7d: recentStmt.get(now - 7 * 24 * 60 * 60 * 1000)?.c ?? 0,
  };
}

/**
 * admin_audit_log — privileged action history.
 *
 * Every state-changing admin endpoint writes a row here in the SAME
 * transaction as the mutation. Survives log rotation, queryable by
 * user_id or by time range.
 */

import { db } from '../client.js';

export type AdminAction =
  | 'set_plan'
  | 'extend_subscription'
  | 'revoke_key'
  | 'force_close_position'
  | 'cancel_subscription'
  | 'delete_user'
  | 'assign_tier'
  | 'emergency_stop'
  | 'resume_all_trading';

const insertStmt = db.prepare(`
  INSERT INTO admin_audit_log
    (ts, admin_email, target_user_id, action, before_json, after_json, note, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const listForUserStmt = db.prepare(`
  SELECT * FROM admin_audit_log
   WHERE target_user_id = ?
   ORDER BY ts DESC
   LIMIT ?
`);

const listRecentStmt = db.prepare(`
  SELECT * FROM admin_audit_log ORDER BY ts DESC LIMIT ?
`);

export function recordAdminAction(input: {
  adminEmail: string;
  targetUserId: number | null;
  action: AdminAction;
  before: unknown;
  after: unknown;
  note?: string | null;
  ip?: string | null;
}): void {
  insertStmt.run(
    Date.now(),
    input.adminEmail,
    input.targetUserId,
    input.action,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.note ?? null,
    input.ip ?? null,
  );
}

export type AuditRow = {
  id: number;
  ts: number;
  admin_email: string;
  target_user_id: number | null;
  action: string;
  before_json: string | null;
  after_json: string | null;
  note: string | null;
  ip: string | null;
};

export function listAuditForUser(userId: number, limit = 50): AuditRow[] {
  return listForUserStmt.all(userId, limit) as AuditRow[];
}

export function listRecentAudit(limit = 100): AuditRow[] {
  return listRecentStmt.all(limit) as AuditRow[];
}

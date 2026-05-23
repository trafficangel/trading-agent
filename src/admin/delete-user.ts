/**
 * Admin: hard-delete a user account.
 *
 * Used by:
 *   - scripts/delete-user.ts (CLI for ops)
 *   - POST /admin/users/:id/delete (admin button)
 *
 * Sequence (matches the long-standing script behaviour):
 *   1. Close all open Bybit positions on the user's account via
 *      closeAllUserPositions(strategy_exit). Failures are LOGGED, not
 *      raised — we still want the DB rows gone afterwards so the user
 *      can re-register cleanly.
 *   2. Cascade DELETE the rows in dependency order:
 *        user_tier_history → user_strategies → user_api_keys
 *        → user_subscriptions → decisions → verification_attempts
 *        → registrations
 *      All inside a single transaction.
 *
 * Idempotent: re-running on an already-deleted user is a no-op (returns
 * { deleted: false, reason: 'not_found' }).
 *
 * Caller is responsible for any audit log entry — we just do the work.
 */

import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { closeAllUserPositions } from '../strategies/user-fanout.js';

export type DeleteUserResult =
  | { deleted: false; reason: 'not_found' }
  | {
      deleted: true;
      userId: number;
      phone: string;
      positionsClosed: { attempted: number; succeeded: number; failed: number } | null;
      positionsCloseError: string | null;
      summary: Record<string, number>;
    };

const findByPhoneStmt = db.prepare<[string], { id: number; phone: string }>(
  'SELECT id, phone FROM registrations WHERE phone = ?',
);
const findByIdStmt = db.prepare<[number], { id: number; phone: string }>(
  'SELECT id, phone FROM registrations WHERE id = ?',
);

/** Find by phone (e.g. '+79780654223') OR by numeric id. Returns null
 *  when not found. */
export function resolveUserTarget(
  identifier: string | number,
): { id: number; phone: string } | null {
  if (typeof identifier === 'number' || /^\d+$/.test(identifier)) {
    const id = typeof identifier === 'number' ? identifier : Number.parseInt(identifier, 10);
    return findByIdStmt.get(id) ?? null;
  }
  return findByPhoneStmt.get(identifier) ?? null;
}

const DELETE_STATEMENTS: ReadonlyArray<readonly [string, 'user_id' | 'phone' | 'reg_id']> = [
  ['DELETE FROM user_tier_history WHERE user_id = ?', 'user_id'],
  ['DELETE FROM user_strategies WHERE user_id = ?', 'user_id'],
  ['DELETE FROM user_api_keys WHERE user_id = ?', 'user_id'],
  ['DELETE FROM user_subscriptions WHERE user_id = ?', 'user_id'],
  ['DELETE FROM decisions WHERE user_id = ?', 'user_id'],
  ['DELETE FROM verification_attempts WHERE phone = ?', 'phone'],
  // admin_audit_log has a FK to registrations(id). We preserve the
  // audit history (action / before / after / note are still valuable
  // even without the user link) but NULL out the link so DELETE FROM
  // registrations doesn't trip the FK constraint.
  ['UPDATE admin_audit_log SET target_user_id = NULL WHERE target_user_id = ?', 'reg_id'],
  ['DELETE FROM registrations WHERE id = ?', 'reg_id'],
];

/**
 * Close-then-delete cascade. See file header for the ordering rationale.
 */
export async function deleteUserCascade(
  identifier: string | number,
): Promise<DeleteUserResult> {
  const target = resolveUserTarget(identifier);
  if (!target) {
    return { deleted: false, reason: 'not_found' };
  }

  // 1. Best-effort close on Bybit. Don't raise — we still want the DB
  //    gone afterwards so re-registration is clean.
  let positionsClosed: { attempted: number; succeeded: number; failed: number } | null = null;
  let positionsCloseError: string | null = null;
  try {
    const stats = await closeAllUserPositions(target.id, 'strategy_exit');
    positionsClosed = stats;
    if (stats.attempted > 0) {
      logger.info({ userId: target.id, stats }, 'delete-user: closed Bybit positions');
    }
  } catch (err) {
    positionsCloseError = (err as Error).message ?? String(err);
    logger.error(
      { err, userId: target.id },
      'delete-user: closeAllUserPositions failed (continuing with DB cleanup)',
    );
  }

  // 2. Cascade DELETE in one transaction. better-sqlite3 transactions
  //    are sync — we already finished the async Bybit step above.
  const tx = db.transaction(() => {
    const summary: Record<string, number> = {};
    for (const [sql, paramKind] of DELETE_STATEMENTS) {
      const param =
        paramKind === 'phone' ? target.phone
        : paramKind === 'reg_id' ? target.id
        : target.id;
      const result = db.prepare(sql).run(param);
      const table = sql.match(/DELETE FROM (\w+)/)?.[1] ?? '???';
      summary[table] = result.changes;
    }
    return summary;
  });

  const summary = tx();
  logger.info(
    { userId: target.id, phone: target.phone, summary, positionsCloseError },
    'delete-user: cascade DELETE complete',
  );

  return {
    deleted: true,
    userId: target.id,
    phone: target.phone,
    positionsClosed,
    positionsCloseError,
    summary,
  };
}

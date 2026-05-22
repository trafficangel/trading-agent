/**
 * One-off admin script: cleanly delete a user account.
 *
 * Usage:
 *   pnpm tsx scripts/delete-user.ts <phone>
 *   pnpm tsx scripts/delete-user.ts +79780654223
 *
 * Sequence:
 *   1. Resolve user_id from phone.
 *   2. Close all open positions on Bybit (market reduce-only) via the same
 *      helper used by /account/api-key/revoke.
 *   3. DELETE rows cascading: user_tier_history → user_strategies →
 *      user_api_keys → user_subscriptions → decisions → verification_attempts
 *      → registrations.
 *
 * Idempotent: re-running on already-deleted user prints "not found" and exits 0.
 */

import { db } from '../src/db/client.js';
import { logger } from '../src/lib/logger.js';
import { closeAllUserPositions } from '../src/strategies/user-fanout.js';

const phone = process.argv[2];
if (!phone) {
  console.error('Usage: tsx scripts/delete-user.ts <phone>');
  process.exit(1);
}

const reg = db.prepare<[string], { id: number; display_name: string | null }>(
  'SELECT id, display_name FROM registrations WHERE phone = ?',
).get(phone);
if (!reg) {
  logger.info({ phone }, 'delete-user: registration not found, nothing to do');
  process.exit(0);
}
const userId = reg.id;
logger.info({ userId, phone, name: reg.display_name }, 'delete-user: target located');

async function main() {
  // 1. Close open Bybit positions if any
  try {
    const stats = await closeAllUserPositions(userId, 'strategy_exit');
    if (stats.attempted > 0) {
      logger.info({ userId, stats }, 'delete-user: closed Bybit positions');
    } else {
      logger.info({ userId }, 'delete-user: no open positions to close');
    }
  } catch (err) {
    logger.error({ err, userId }, 'delete-user: closeAllUserPositions failed (continuing anyway)');
  }

  // 2. Delete in dependency order — children first, then parent
  const tx = db.transaction(() => {
    const stmts = [
      'DELETE FROM user_tier_history WHERE user_id = ?',
      'DELETE FROM user_strategies WHERE user_id = ?',
      'DELETE FROM user_api_keys WHERE user_id = ?',
      'DELETE FROM user_subscriptions WHERE user_id = ?',
      'DELETE FROM decisions WHERE user_id = ?',
      "DELETE FROM verification_attempts WHERE phone = ?",
      'DELETE FROM registrations WHERE id = ?',
    ];
    const summary: Record<string, number> = {};
    for (const sql of stmts) {
      const isPhoneScope = sql.includes('phone');
      const isIdScope = sql.includes('registrations WHERE id');
      const param = isPhoneScope ? phone : isIdScope ? userId : userId;
      const result = db.prepare(sql).run(param);
      const table = sql.match(/DELETE FROM (\w+)/)?.[1] ?? '???';
      summary[table] = result.changes;
    }
    return summary;
  });

  const summary = tx();
  logger.info({ userId, phone, summary }, 'delete-user: cascade DELETE complete');
  console.log(JSON.stringify({ userId, phone, summary }, null, 2));
}

void main().then(() => process.exit(0)).catch((err) => {
  logger.error({ err, userId }, 'delete-user: failed');
  process.exit(1);
});

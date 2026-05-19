/**
 * Operator one-shot — manually fan a single user into an existing
 * shadow decision. Used to recover a user from a fan-out that failed
 * the first time (e.g. Bybit returned 10001 because of Hedge mode,
 * we've since fixed our code, the user's account still needs the trade).
 *
 * What it does:
 *   1. DELETE the failed user_decision row tied to the shadow + user
 *      (so the C2 idempotency pre-flight doesn't refuse the replay).
 *   2. Re-run the entry path through user-fanout's executeUserEntry —
 *      includes the new switchToOneWayMode step, so a Hedge-mode
 *      account is auto-flipped to One-Way before the order goes out.
 *   3. Logs the new decision row id (or the failure reason).
 *
 * Usage:
 *   pnpm tsx scripts/manual-user-entry.ts <shadow_decision_id> <user_id>
 *
 * Example:
 *   pnpm tsx scripts/manual-user-entry.ts 208 2
 */

import { db } from '../src/db/client.js';
import { logger } from '../src/lib/logger.js';
import { fanOutEntry } from '../src/strategies/user-fanout.js';
import {
  findDecisionById,
  findUserDecisionByParent,
} from '../src/db/repos/decisions.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shadowId = parseInt(args[0] ?? '', 10);
  const userId = parseInt(args[1] ?? '', 10);
  if (!Number.isFinite(shadowId) || !Number.isFinite(userId)) {
    console.error('Usage: pnpm tsx scripts/manual-user-entry.ts <shadow_decision_id> <user_id>');
    process.exit(1);
  }

  const shadow = findDecisionById(shadowId);
  if (!shadow) {
    console.error(`Shadow decision ${shadowId} not found`);
    process.exit(1);
  }
  if (shadow.user_id !== null) {
    console.error(`Decision ${shadowId} has user_id=${shadow.user_id} — that's not a shadow row.`);
    process.exit(1);
  }
  if (!shadow.strategy_id || !shadow.side || !shadow.entry || !shadow.sl) {
    console.error(`Shadow decision ${shadowId} is missing strategy_id / side / entry / sl.`);
    process.exit(1);
  }
  if (shadow.status !== 'active') {
    console.error(
      `Warning: shadow decision ${shadowId} status=${shadow.status} (not active). ` +
        `Continuing anyway since the user is being added retroactively.`,
    );
  }

  // Remove failed/placeholder rows from previous fan-out attempts so
  // the C2 idempotency guard (partial unique index on
  // parent_decision_id+user_id) doesn't refuse the new INSERT.
  const existing = findUserDecisionByParent(shadowId, userId);
  if (existing !== null) {
    console.error(`Existing user decision ${existing} for parent=${shadowId} user=${userId} — deleting first.`);
    db.prepare(`DELETE FROM decisions WHERE id = ?`).run(existing);
  }

  console.error(
    `Replaying fan-out for user_id=${userId} on shadow_id=${shadowId} (${shadow.strategy_id} ` +
      `${shadow.symbol} ${shadow.side} entry=${shadow.entry} sl=${shadow.sl})…`,
  );

  // fanOutEntry walks every eligible user; we only want this one. To
  // limit the blast radius we filter by directly invoking the entry
  // path with a fan-out scope of one user. The simplest path: call
  // fanOutEntry as normal — the other eligible users have either
  // already been processed (their existing rows skip via the pre-flight
  // idempotency check) or are still eligible (they SHOULD be processed
  // too, since this is a real signal they missed).
  const res = await fanOutEntry({
    shadowDecisionId: shadowId,
    strategyId: shadow.strategy_id,
    symbol: shadow.symbol,
    side: shadow.side as 'long' | 'short',
    entry: shadow.entry,
    sl: shadow.sl,
    rawWebhook: shadow.raw_response,
  });

  console.error(
    `fanOutEntry done: attempted=${res.attempted}, succeeded=${res.succeeded}, failed=${res.failed}`,
  );

  // Show the row that was created for the target user.
  const newRow = findUserDecisionByParent(shadowId, userId);
  if (newRow === null) {
    console.error(`No user decision row was created for user_id=${userId}.`);
    console.error(`Likely cause: user is currently ineligible (sub expired, paused, no key, insufficient balance).`);
    process.exit(1);
  }
  const row = db.prepare(`SELECT id, status, side, entry, sl, exchange_order_id, bybit_qty, bybit_avg_price, order_error FROM decisions WHERE id = ?`).get(newRow);
  console.error(`New user decision row:`, row);
  logger.info({ shadowId, userId, newRow: row }, 'manual-user-entry: done');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

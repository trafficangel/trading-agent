/**
 * One-off admin script: cleanly delete a user account.
 *
 * Usage:
 *   pnpm tsx scripts/delete-user.ts <phone-or-id>
 *   pnpm tsx scripts/delete-user.ts +79780654223
 *   pnpm tsx scripts/delete-user.ts 42
 *
 * Implementation: thin wrapper around `deleteUserCascade()` from
 * src/admin/delete-user.ts. Same code-path as the admin button on
 * /admin so behaviour stays in sync.
 *
 * Idempotent: re-running on already-deleted user prints «not found»
 * and exits 0.
 */

import { logger } from '../src/lib/logger.js';
import { deleteUserCascade } from '../src/admin/delete-user.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: tsx scripts/delete-user.ts <phone-or-id>');
  process.exit(1);
}
const target: string = arg;

async function main() {
  const result = await deleteUserCascade(target);
  if (!result.deleted) {
    logger.info({ arg }, 'delete-user: not found, nothing to do');
    process.exit(0);
  }
  console.log(JSON.stringify({
    userId: result.userId,
    phone: result.phone,
    positionsClosed: result.positionsClosed,
    positionsCloseError: result.positionsCloseError,
    summary: result.summary,
  }, null, 2));
}

void main().then(() => process.exit(0)).catch((err) => {
  logger.error({ err }, 'delete-user: failed');
  process.exit(1);
});

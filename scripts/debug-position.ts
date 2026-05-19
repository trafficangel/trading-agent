/**
 * Operator debug — read the Bybit state for a given user.
 * Shows fetchPosition + recent executions for the symbol.
 *
 * Usage:
 *   pnpm tsx scripts/debug-position.ts <user_id> <SYMBOL>
 */

import { findActiveKey, getDecryptedCreds } from '../src/db/repos/user-api-keys.js';
import { fetchPosition, fetchExecutions } from '../src/exchange/bybit-private.js';

async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  const symbol = process.argv[3] ?? 'BTCUSDT';
  if (!Number.isFinite(userId)) {
    console.error('Usage: pnpm tsx scripts/debug-position.ts <user_id> <SYMBOL>');
    process.exit(1);
  }
  const k = findActiveKey(userId);
  if (!k) {
    console.error('No active key for user', userId);
    process.exit(1);
  }
  const c = getDecryptedCreds(k);

  const p = await fetchPosition(c, symbol);
  console.log('fetchPosition:', JSON.stringify(p, null, 2));

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const ex = await fetchExecutions(c, { symbol, startTime: since, limit: 50 });
  if (ex.ok) {
    console.log(`\nrecent executions (last 24h, ${ex.rows.length} rows):`);
    for (const e of ex.rows) {
      console.log(
        ' ',
        new Date(e.execTime).toISOString(),
        e.side,
        'qty=' + e.execQty,
        '@' + e.execPrice,
        'closedSize=' + e.closedSize,
        'orderLinkId=' + e.orderLinkId,
      );
    }
  } else {
    console.log('fetchExecutions failed:', ex.code, ex.msg);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});

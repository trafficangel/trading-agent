import { db } from '../src/db/client.js';
import { hlTradeAccounting } from '../src/exchange/hyperliquid-private.js';
import { logger } from '../src/lib/logger.js';

type Row = { id: number; coin: string; opened_at: number; closed_at: number };
const limitArg = Number(process.argv[process.argv.indexOf('--limit') + 1] ?? 20);
const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(50, Math.floor(limitArg))) : 20;
const rows = db.prepare<[number], Row>(`
  SELECT id, coin, opened_at, closed_at
    FROM wick_fade_log
   WHERE mode='live' AND closed_at IS NOT NULL
     AND (pnl_source IS NULL OR pnl_source != 'fills-v1')
   ORDER BY opened_at ASC
   LIMIT ?
`).all(limit);
const update = db.prepare(`
  UPDATE wick_fade_log
     SET entry_px=?, qty=?, exit_px=?, pnl_pct=?, entry_notional_usd=?, exit_notional_usd=?,
         gross_pnl_usd=?, fee_usd=?, funding_usd=?, net_pnl_usd=?, accounting_fill_count=?, pnl_source='fills-v1'
   WHERE id=?
`);

let updated = 0;
let skipped = 0;
let rateLimited = false;
for (const row of rows) {
  const result = await hlTradeAccounting({ coin: row.coin, openedAt: row.opened_at, closedAt: row.closed_at });
  if (!result.ok && /\b429\b|too many requests/i.test(result.msg)) {
    rateLimited = true;
    logger.warn({ id: row.id, coin: row.coin }, 'wick-fade accounting backfill stopped by rate limit');
    break;
  }
  if (!result.ok || !result.data?.complete) {
    skipped += 1;
    logger.warn({ id: row.id, coin: row.coin, msg: result.ok ? 'incomplete fills' : result.msg }, 'wick-fade accounting backfill skipped');
    continue;
  }
  const a = result.data;
  update.run(a.entryAvgPx, a.entryQty, a.exitAvgPx, +a.netPnlPct.toFixed(3), a.entryNotionalUsd, a.exitNotionalUsd, a.grossPnlUsd, a.feesUsd, a.fundingUsd, a.netPnlUsd, a.fillCount, row.id);
  updated += 1;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

logger.info({ candidates: rows.length, updated, skipped, rateLimited, limit }, 'wick-fade accounting backfill complete');
db.close();

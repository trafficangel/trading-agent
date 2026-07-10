import { db } from '../src/db/client.js';
import { hlTradeAccounting } from '../src/exchange/hyperliquid-private.js';
import { logger } from '../src/lib/logger.js';

type Row = {
  id: number;
  coin: string;
  opened_at: number;
  closed_at: number;
};

const PUBLIC_START_FALLBACK_MS = Date.UTC(2026, 6, 8, 18, 14, 0);
const all = process.argv.includes('--all');
const runtime = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const configuredStart = Number(runtime.get('hl_momentum_public_start_ms')?.value ?? PUBLIC_START_FALLBACK_MS);
const startMs = all ? 0 : (Number.isFinite(configuredStart) && configuredStart > 0 ? configuredStart : PUBLIC_START_FALLBACK_MS);
const rows = db.prepare<[number], Row>(`
  SELECT id, coin, opened_at, closed_at
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL
     AND opened_at >= ?
     AND (pnl_source IS NULL OR pnl_source != 'fills-v1')
   ORDER BY opened_at ASC
`).all(startMs);
const update = db.prepare(`
  UPDATE hl_momentum_live_log
     SET entry_px = ?, qty = ?, exit_px = ?, pnl_pct = ?,
         entry_notional_usd = ?, exit_notional_usd = ?, gross_pnl_usd = ?,
         fee_usd = ?, funding_usd = ?, net_pnl_usd = ?, accounting_fill_count = ?, pnl_source = 'fills-v1'
   WHERE id = ?
`);

let updated = 0;
let skipped = 0;
for (const row of rows) {
  const result = await hlTradeAccounting({ coin: row.coin, openedAt: row.opened_at, closedAt: row.closed_at });
  if (!result.ok || !result.data?.complete) {
    skipped += 1;
    logger.warn({ id: row.id, coin: row.coin, msg: result.ok ? 'incomplete fills' : result.msg }, 'hl momentum accounting backfill skipped');
    continue;
  }
  const a = result.data;
  update.run(
    a.entryAvgPx,
    a.entryQty,
    a.exitAvgPx,
    Math.round(a.netPnlPct * 1000) / 1000,
    a.entryNotionalUsd,
    a.exitNotionalUsd,
    a.grossPnlUsd,
    a.feesUsd,
    a.fundingUsd,
    a.netPnlUsd,
    a.fillCount,
    row.id,
  );
  updated += 1;
}

logger.info({ candidates: rows.length, updated, skipped, startMs, all }, 'hl momentum accounting backfill complete');
db.close();

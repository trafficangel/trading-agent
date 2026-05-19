/**
 * One-shot backfill — recompute pnl_pct / pnl_r for Track D user
 * decisions closed before audit C1 (2026-05-19) where the fan-out
 * exit passed swapped (sl, closePrice) into calcPnl.
 *
 * Scope: rows with user_id IS NOT NULL AND status='closed' AND
 *        close_price IS NOT NULL. Recompute against the same
 *        original_sl / sl / entry the live code uses now.
 *
 * Idempotent: re-running on already-correct rows is a no-op (the new
 * values match the existing ones). Prints a per-row diff so an
 * operator can spot-check before applying.
 *
 * Run:
 *   pnpm tsx scripts/backfill-user-pnl.ts --dry-run   # preview
 *   pnpm tsx scripts/backfill-user-pnl.ts --apply     # write
 */

import { db } from '../src/db/client.js';
import { calcPnl } from '../src/lib/pnl.js';
import { logger } from '../src/lib/logger.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const dryRun = args.has('--dry-run') || !apply;

if (!apply && !dryRun) {
  console.error('Pass either --dry-run or --apply');
  process.exit(2);
}

type Row = {
  id: number;
  user_id: number | null;
  side: string | null;
  entry: number | null;
  sl: number | null;
  original_sl: number | null;
  close_price: number | null;
  pnl_pct: number | null;
  pnl_r: number | null;
  symbol: string;
  strategy_id: string | null;
};

const rows = db
  .prepare<unknown[], Row>(
    `SELECT id, user_id, side, entry, sl, original_sl, close_price, pnl_pct, pnl_r, symbol, strategy_id
       FROM decisions
      WHERE user_id IS NOT NULL
        AND status = 'closed'
        AND close_price IS NOT NULL
        AND side IN ('long', 'short')
        AND entry IS NOT NULL
      ORDER BY id ASC`,
  )
  .all();

const updateStmt = db.prepare(`UPDATE decisions SET pnl_pct = ?, pnl_r = ? WHERE id = ?`);

let changed = 0;
let unchanged = 0;

console.log(`Found ${rows.length} closed user decisions. Mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

for (const r of rows) {
  const slForR = r.original_sl ?? r.sl ?? r.entry!;
  const correct = calcPnl(r.side as 'long' | 'short', r.entry!, slForR, r.close_price!);
  const wasPct = r.pnl_pct;
  const wasR = r.pnl_r;
  const samePct = wasPct !== null && Math.abs(wasPct - correct.pnlPct) < 0.005;
  const sameR = wasR !== null && Math.abs(wasR - correct.pnlR) < 0.005;

  if (samePct && sameR) {
    unchanged++;
    continue;
  }
  changed++;
  console.log(
    `id=${r.id} user=${r.user_id} ${r.symbol} ${r.side} entry=${r.entry} sl=${slForR} close=${r.close_price}` +
      `  was: pct=${wasPct} R=${wasR}  →  now: pct=${correct.pnlPct} R=${correct.pnlR}`,
  );
  if (apply) {
    updateStmt.run(correct.pnlPct, correct.pnlR, r.id);
  }
}

console.log(`\nSummary: ${changed} rows ${apply ? 'updated' : 'would be updated'}, ${unchanged} unchanged.`);
if (!apply && changed > 0) {
  console.log('Re-run with --apply to write the changes.');
}
logger.info({ changed, unchanged, applied: apply }, 'backfill-user-pnl done');

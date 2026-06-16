/**
 * HL microstructure collector status — confirms hl_micro is filling.
 * Run on the VPS: pnpm tsx scripts/hl-micro-status.ts
 */
import { db } from '../src/db/client.js';

type Row = { coin: string; n: number; first_ts: number; last_ts: number; with_oi: number; with_cvd: number };
const rows = db.prepare<[], Row>(`
  SELECT coin, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
         SUM(CASE WHEN oi IS NOT NULL THEN 1 ELSE 0 END) AS with_oi,
         SUM(CASE WHEN trades > 0 THEN 1 ELSE 0 END) AS with_cvd
  FROM hl_micro GROUP BY coin ORDER BY coin
`).all();

const now = Date.now();
const ageMin = (ts: number) => Math.round((now - ts) / 60000);
console.log('=== hl_micro per coin (rows / span / freshness) ===');
if (rows.length === 0) { console.log('  (empty — collector not yet writing)'); process.exit(0); }
for (const r of rows) {
  const spanH = ((r.last_ts - r.first_ts) / 3.6e6).toFixed(1);
  console.log(`  ${r.coin.padEnd(5)} rows ${String(r.n).padStart(5)}  span ${spanH}h  last ${ageMin(r.last_ts)}m ago  | oi-rows ${r.with_oi}  cvd-rows ${r.with_cvd}`);
}

const coin = rows[0]!.coin;
console.log(`\n=== latest 6 minutes · ${coin} ===`);
const recent = db.prepare<[string], { ts: number; cvd_delta: number; trades: number; oi: number | null; funding: number | null; book_imb: number | null; mid: number | null }>(`
  SELECT ts, cvd_delta, trades, oi, funding, book_imb, mid FROM hl_micro WHERE coin = ? ORDER BY ts DESC LIMIT 6
`).all(coin);
for (const r of recent) {
  const t = new Date(r.ts).toISOString().slice(11, 16);
  console.log(`  ${t}  cvd ${String(Math.round(r.cvd_delta * 1000) / 1000).padStart(9)}  trd ${String(r.trades).padStart(4)}  oi ${r.oi ?? '—'}  fund ${r.funding ?? '—'}  imb ${r.book_imb ?? '—'}  mid ${r.mid ?? '—'}`);
}
db.close();

/**
 * Calibration report: groups closed decisions by confidence bucket and
 * shows actual win-rate / avg-R / expectancy per bucket. Tells us if the
 * model's stated confidence correlates with real outcomes.
 *
 * Also breaks down by:
 *   - cited level (POC vs swing vs wall vs ...)
 *   - cascade present
 *   - btc_alignment
 *   - prompt_version
 *
 * Usage:
 *   pnpm tsx scripts/analyze-calibration.ts
 *
 * On the VPS:
 *   sudo -u trader bash -lc "cd ~/apps/trading-agent && pnpm tsx scripts/analyze-calibration.ts"
 */
import { db } from '../src/db/client.js';

type Row = {
  id: number;
  decision: string;
  side: string | null;
  pnl_r: number | null;
  pnl_pct: number | null;
  features_json: string | null;
};

const rows = db
  .prepare<[], Row>(
    `SELECT id, decision, side, pnl_r, pnl_pct, features_json
     FROM decisions
     WHERE decision = 'OPEN' AND status = 'closed' AND pnl_r IS NOT NULL`,
  )
  .all();

if (rows.length === 0) {
  console.log('No closed OPEN decisions yet. Need at least a handful to compute calibration.');
  process.exit(0);
}

console.log(`\n=== Calibration report — ${rows.length} closed trades ===\n`);

type Bucket = { count: number; wins: number; sumR: number; sumPct: number };
function emptyBucket(): Bucket {
  return { count: 0, wins: 0, sumR: 0, sumPct: 0 };
}
function printBucket(label: string, b: Bucket): void {
  if (b.count === 0) {
    console.log(`  ${label.padEnd(24)} —`);
    return;
  }
  const winrate = ((b.wins / b.count) * 100).toFixed(0);
  const avgR = (b.sumR / b.count).toFixed(2);
  const avgPct = (b.sumPct / b.count).toFixed(2);
  console.log(
    `  ${label.padEnd(24)} n=${String(b.count).padStart(3)}  win=${winrate.padStart(3)}%  avgR=${avgR.padStart(6)}  avg%=${avgPct.padStart(7)}`,
  );
}

// === By confidence bucket ===
const byConf = new Map<string, Bucket>();
// === By cited level ===
const byLevel = new Map<string, Bucket>();
// === By cascade ===
const byCascade = new Map<string, Bucket>();
// === By btc_alignment ===
const byBtc = new Map<string, Bucket>();
// === By prompt_version ===
const byPrompt = new Map<string, Bucket>();

for (const r of rows) {
  if (r.pnl_r === null) continue;
  const isWin = r.pnl_r > 0;
  const features = r.features_json ? (JSON.parse(r.features_json) as Record<string, unknown>) : {};

  const conf = String(features.confidence_bucket ?? 'unknown');
  const cb = byConf.get(conf) ?? emptyBucket();
  cb.count++;
  if (isWin) cb.wins++;
  cb.sumR += r.pnl_r;
  cb.sumPct += r.pnl_pct ?? 0;
  byConf.set(conf, cb);

  const levels = Array.isArray(features.cited_levels) ? (features.cited_levels as string[]) : [];
  for (const lvl of levels) {
    const lb = byLevel.get(lvl) ?? emptyBucket();
    lb.count++;
    if (isWin) lb.wins++;
    lb.sumR += r.pnl_r;
    lb.sumPct += r.pnl_pct ?? 0;
    byLevel.set(lvl, lb);
  }

  const cascade = String(features.cascade ?? 'none');
  const cc = byCascade.get(cascade) ?? emptyBucket();
  cc.count++;
  if (isWin) cc.wins++;
  cc.sumR += r.pnl_r;
  cc.sumPct += r.pnl_pct ?? 0;
  byCascade.set(cascade, cc);

  const btc = String(features.btc_alignment ?? 'unknown');
  const bb = byBtc.get(btc) ?? emptyBucket();
  bb.count++;
  if (isWin) bb.wins++;
  bb.sumR += r.pnl_r;
  bb.sumPct += r.pnl_pct ?? 0;
  byBtc.set(btc, bb);

  const pv = String(features.prompt_version ?? 'unknown');
  const pb = byPrompt.get(pv) ?? emptyBucket();
  pb.count++;
  if (isWin) pb.wins++;
  pb.sumR += r.pnl_r;
  pb.sumPct += r.pnl_pct ?? 0;
  byPrompt.set(pv, pb);
}

console.log('By confidence bucket:');
for (const k of ['<0.40', '0.40-0.50', '0.50-0.60', '0.60-0.70', '>=0.70']) {
  printBucket(k, byConf.get(k) ?? emptyBucket());
}

console.log('\nBy cited level (each trade may contribute to several):');
const sortedLevels = Array.from(byLevel.entries()).sort((a, b) => b[1].sumR - a[1].sumR);
for (const [k, v] of sortedLevels) printBucket(k, v);

console.log('\nBy cascade context:');
for (const [k, v] of byCascade) printBucket(k, v);

console.log('\nBy BTC alignment:');
for (const [k, v] of byBtc) printBucket(k, v);

console.log('\nBy prompt version (git hash at decision time):');
for (const [k, v] of byPrompt) printBucket(k, v);

console.log();
process.exit(0);

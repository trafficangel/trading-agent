/**
 * CROSS-ASSET (ratio-spread) SWEEP+VERIFY. For each alt: align its klines 1:1
 * with BTC's (same tf/window, intersect by timestamp), feed BTC closes into
 * ratioSpread, sweep params, 4-fold walk-forward + cost-stress, cross-symbol
 * survival. Evaluated at HL TAKER 0.07 (conservative) AND HL MAKER 0.04 (the
 * band entry can rest a limit), since the research flagged it fee-sensitive.
 * Run on the VPS. pnpm tsx scripts/sweep-xasset.ts  → data/sweep-xasset-results.json
 */

import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import { ratioSpread } from '../src/backtest/strategies/families-xasset.js';

const TAKER = 0.07, MAKER = 0.04;
const ALTS = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const WIN: Record<string, number> = { '15': 320, '30': 440, '60': 540 };
const TIMESTOP: Record<string, number> = { '15': 48, '30': 32, '60': 24 };

function net(r: number[], fee: number) { let s = 0; for (const x of r) s += x - fee; return Math.round(s * 10) / 10; }
function pf(r: number[], fee: number) { let gp = 0, gl = 0; for (const x of r) { const y = x - fee; if (y >= 0) gp += y; else gl += -y; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[], fee: number) { return r.length ? Math.round((r.filter((x) => x - fee > 0).length / r.length) * 100) : 0; }
function maxDD(r: number[], fee: number) { let c = 0, p = 0, d = 0; for (const x of r) { c += x - fee; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds4(r: number[], fee: number) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) if (net(r.slice(f * k, f === 3 ? r.length : (f + 1) * k), fee) > 0) pos++; return pos; }

type Combo = { entryZ: number; exitZ: number; N: number; betaWin: number; stopZ: number };
const COMBOS: Combo[] = [];
for (const entryZ of [2.0, 2.5]) for (const N of [60, 96]) for (const betaWin of [0, 500]) COMBOS.push({ entryZ, exitZ: 0.25, N, betaWin, stopZ: 3.0 });

type Row = { sig: string; alt: string; tf: string; n: number; net: number; net2: number; mkr: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

function align(alt: Candle[], btc: Candle[]): { c: Candle[]; ref: number[] } {
  const m = new Map<number, number>();
  for (const b of btc) m.set(b.t, b.c);
  const c: Candle[] = []; const ref: number[] = [];
  for (const a of alt) { const r = m.get(a.t); if (r != null) { c.push(a); ref.push(r); } }
  return { c, ref };
}

(async () => {
  const rows: Row[] = [];
  console.log(`Cross-asset ratio-spread sweep · ${ALTS.length} alts × tf{15,30,60} × ${COMBOS.length} combos · HL taker ${TAKER}/maker ${MAKER}\n`);
  for (const tf of ['15', '30', '60']) {
    const days = WIN[tf]!;
    let btc: Candle[] = [];
    try { btc = await getKlines('BTCUSDT', tf, NOW - days * 86_400_000, NOW); } catch (e) { process.stderr.write(`BTC ${tf}: ${(e as Error).message}\n`); continue; }
    for (const alt of ALTS) {
      let altK: Candle[] = [];
      try { altK = await getKlines(alt, tf, NOW - days * 86_400_000, NOW); } catch { continue; }
      const { c, ref } = align(altK, btc);
      if (c.length < 200) continue;
      for (const cm of COMBOS) {
        const strat = ratioSpread(alt, tf, ref, cm.entryZ, cm.exitZ, cm.N, cm.betaWin, cm.stopZ);
        const r = runBacktest(strat, c, { kind: 'time', bars: TIMESTOP[tf]! }).tradesLog.map((t) => t.realizedPct);
        if (r.length < 20) continue;
        const cut = Math.floor(r.length * 0.7);
        const isN = net(r.slice(0, cut), TAKER), oosN = net(r.slice(cut), TAKER);
        const f = folds4(r, TAKER);
        const n1 = net(r, TAKER), n2 = net(r, TAKER * 2), mkr = net(r, MAKER);
        const green = r.length >= 30 && n1 > 0 && pf(r, TAKER) > 1.2 && isN > 0 && oosN > 0 && n2 > 0 && (r.length >= 16 ? f >= 3 : true);
        rows.push({ sig: `z${cm.entryZ}N${cm.N}b${cm.betaWin}-${tf}`, alt, tf, n: r.length, net: n1, net2: n2, mkr, pf: pf(r, TAKER), wr: wr(r, TAKER), dd: maxDD(r, TAKER), isN, oosN, folds: f, green });
      }
    }
    process.stderr.write(`  tf ${tf} done\n`);
  }
  writeFileSync('data/sweep-xasset-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.alt.padEnd(9)} ${r.tf.padEnd(3)} ${r.sig.padEnd(16)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(7)} ×2 ${String(r.net2).padStart(7)} mkr ${String(r.mkr).padStart(7)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(6)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const bySig = new Map<string, Row[]>();
  for (const r of rows) { const a = bySig.get(r.sig) ?? []; a.push(r); bySig.set(r.sig, a); }
  const robust = [...bySig.entries()].map(([sig, rs]) => ({ sig, green: rs.filter((r) => r.green).length, rs })).filter((x) => x.green >= 4).sort((a, b) => b.green - a.green);
  console.log(`===== ROBUST signatures (taker-green on ≥4/${ALTS.length} alts) =====`);
  if (!robust.length) console.log('  — none robust at taker —');
  for (const x of robust) { console.log(`\n  ◆ ${x.sig} → ${x.green}/${ALTS.length}`); console.log(x.rs.filter((r) => r.green).sort((a, b) => b.net - a.net).map(line).join('\n')); }
  const greenT = rows.filter((r) => r.green).length;
  const greenM = rows.filter((r) => r.mkr > 0 && r.net2 <= 0).length;
  console.log(`\nTaker-green rows: ${greenT}. (Maker-only-positive rows: ${greenM} — would need maker execution.)`);
  console.log('Top 12 by taker-net:'); console.log(rows.sort((a, b) => b.net - a.net).slice(0, 12).map(line).join('\n'));
  console.log('\nFull → data/sweep-xasset-results.json. ROBUST (≥4 alts) = worth the lab; single-alt = data-mining.');
})().catch((e) => { console.error(e); process.exit(1); });

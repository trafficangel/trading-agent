/**
 * ORDER-FLOW SWEEP+VERIFY on REAL HL microstructure (Reservoir backfill in hl_micro):
 *   - liqCascadeFade  (real liquidation-volume spikes; full ~10.5mo history)
 *   - bookImbalance   (top-5 L2 depth imbalance; ~5.7mo from Dec-2025)
 * Kill-battery: cross-symbol survival + 4-fold walk-forward + cost-stress at HL
 * taker 0.07%. Green = candidate; ROBUST (≥4 coins) = worth the lab.
 * Run on the VPS (needs hl_micro + Bybit klines). pnpm tsx scripts/sweep-orderflow.ts
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type SlMode } from '../src/backtest/engine.js';
import { loadMicroAligned, type MicroAligned } from '../src/backtest/micro.js';
import { liqCascadeFade, bookImbalance } from '../src/backtest/strategies/families-flow.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { type Candle } from '../src/backtest/indicators.js';

const TAKER = 0.07;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = 340;

function net(r: number[], fee: number) { let s = 0; for (const x of r) s += x - fee; return Math.round(s * 10) / 10; }
function pf(r: number[], fee: number) { let gp = 0, gl = 0; for (const x of r) { const y = x - fee; if (y >= 0) gp += y; else gl += -y; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[], fee: number) { return r.length ? Math.round((r.filter((x) => x - fee > 0).length / r.length) * 100) : 0; }
function maxDD(r: number[], fee: number) { let c = 0, p = 0, d = 0; for (const x of r) { c += x - fee; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds4(r: number[], fee: number) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) if (net(r.slice(f * k, f === 3 ? r.length : (f + 1) * k), fee) > 0) pos++; return pos; }

type Combo = { fam: string; sig: string; tf: string; build: (coin: string, m: MicroAligned) => CustomStrategy; slMode: SlMode };
function combos(): Combo[] {
  const out: Combo[] = [];
  for (const tf of ['15', '30']) {
    const H = tf === '15' ? 6 : 4;
    for (const liqK of [3, 4, 6]) for (const vb of [3, 5]) for (const vt of [0.008, 0.015])
      out.push({ fam: 'liqcasc', sig: `K${liqK}vb${vb}vt${vt}-${tf}`, tf, build: (coin, m) => liqCascadeFade(coin, tf, m, liqK, 96, vb, vt, 'both'), slMode: { kind: 'atr+time', mult: 5, period: 14, bars: H } });
    for (const it of [0.3, 0.4, 0.5]) for (const mode of ['mom', 'rev'] as const)
      out.push({ fam: 'bookimb', sig: `i${it}${mode}-${tf}`, tf, build: (coin, m) => bookImbalance(coin, tf, m, it, mode), slMode: { kind: 'time', bars: H } });
  }
  return out;
}

type Row = { fam: string; sig: string; coin: string; tf: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; m: MicroAligned }>();
  const cmbs = combos();
  console.log(`Order-flow sweep · ${SYMBOLS.length} coins · ${cmbs.length} configs · HL taker ${TAKER}%\n`);
  for (const cmb of cmbs) {
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      const ck = `${sym}-${cmb.tf}`;
      let cm = cache.get(ck);
      if (!cm) {
        try {
          const c = await getKlines(sym, cmb.tf, NOW - DAYS * 86_400_000, NOW);
          cm = { c, m: loadMicroAligned(coin, cmb.tf, c) }; cache.set(ck, cm);
        } catch (e) { process.stderr.write(`${sym} ${cmb.tf}: ${(e as Error).message}\n`); continue; }
      }
      if (cm.c.length < 200 || cm.m.withData < 100) continue;
      const r = runBacktest(cmb.build(coin, cm.m), cm.c, cmb.slMode).tradesLog.map((t) => t.realizedPct);
      if (r.length < 15) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut), TAKER), oosN = net(r.slice(cut), TAKER);
      const f = folds4(r, TAKER);
      const n1 = net(r, TAKER), n2 = net(r, TAKER * 2);
      const green = r.length >= 20 && n1 > 0 && pf(r, TAKER) > 1.2 && isN > 0 && oosN > 0 && n2 > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ fam: cmb.fam, sig: cmb.sig, coin, tf: cmb.tf, n: r.length, net: n1, net2: n2, pf: pf(r, TAKER), wr: wr(r, TAKER), dd: maxDD(r, TAKER), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cmb.fam} ${cmb.sig} done\n`);
  }
  writeFileSync('data/sweep-orderflow-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(9)} ${r.tf.padEnd(3)} ${r.sig.padEnd(16)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(7)} ×2 ${String(r.net2).padStart(7)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(6)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  for (const fam of ['liqcasc', 'bookimb']) {
    const fr = rows.filter((r) => r.fam === fam);
    const bySig = new Map<string, Row[]>();
    for (const r of fr) { const a = bySig.get(r.sig) ?? []; a.push(r); bySig.set(r.sig, a); }
    const robust = [...bySig.entries()].map(([sig, rs]) => ({ sig, green: rs.filter((r) => r.green).length, rs })).filter((x) => x.green >= 4).sort((a, b) => b.green - a.green);
    console.log(`\n===== ${fam.toUpperCase()} — ROBUST signatures (green on ≥4/${SYMBOLS.length}) =====`);
    if (!robust.length) console.log('  — none robust —');
    for (const x of robust) { console.log(`\n  ◆ ${x.sig} → ${x.green}/${SYMBOLS.length}`); console.log(x.rs.filter((r) => r.green).sort((a, b) => b.net - a.net).map(line).join('\n')); }
    console.log(`\n  ${fam}: ${fr.filter((r) => r.green).length} green rows; top by net:`);
    console.log(fr.sort((a, b) => b.net - a.net).slice(0, 6).map(line).join('\n'));
  }
  console.log(`\nFull → data/sweep-orderflow-results.json. ROBUST (≥4 coins) = worth the lab.`);
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * CVD-EXHAUSTION LIQUIDATION-CLIMAX FADE sweep (idea #4, 1m event-driven) on real
 * HL micro (liq full ~10.5mo + CVD backfill). Kill-battery: cross-symbol survival
 * (ROBUST≥5) + 4-fold walk-forward + cost-stress at HL taker 0.07%. PRE-REGISTERED
 * power gate: require N≥25 closed trades per surviving coin and ≥5 coins / ≥150
 * total events — else UNTESTABLE (don't promote on lucky fires).
 * Run on the VPS AFTER the CVD fillsonly backfill completes. pnpm tsx scripts/sweep-cvdexh.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type SlMode } from '../src/backtest/engine.js';
import { loadMicroAligned, type MicroAligned } from '../src/backtest/micro.js';
import { cvdExhaustionFade } from '../src/backtest/strategies/families-flow.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { type Candle } from '../src/backtest/indicators.js';

const TAKER = 0.07;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 120);

function net(r: number[], fee: number) { let s = 0; for (const x of r) s += x - fee; return Math.round(s * 10) / 10; }
function pf(r: number[], fee: number) { let gp = 0, gl = 0; for (const x of r) { const y = x - fee; if (y >= 0) gp += y; else gl += -y; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[], fee: number) { return r.length ? Math.round((r.filter((x) => x - fee > 0).length / r.length) * 100) : 0; }
function maxDD(r: number[], fee: number) { let c = 0, p = 0, d = 0; for (const x of r) { c += x - fee; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds4(r: number[], fee: number) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) if (net(r.slice(f * k, f === 3 ? r.length : (f + 1) * k), fee) > 0) pos++; return pos; }

type Combo = { sig: string; build: (coin: string, m: MicroAligned) => CustomStrategy; slMode: SlMode };
const COMBOS: Combo[] = [];
for (const liqK of [4, 5, 6]) for (const cvdK of [3, 4]) for (const H of [20, 30, 40])
  COMBOS.push({ sig: `lq${liqK}cv${cvdK}H${H}`, build: (coin, m) => cvdExhaustionFade(coin, '1', m, liqK, cvdK), slMode: { kind: 'time', bars: H } });

type Row = { sig: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; m: MicroAligned }>();
  console.log(`CVD-exhaustion sweep · 1m · ${SYMBOLS.length} coins · ${COMBOS.length} configs · ${DAYS}d · HL taker ${TAKER}%\n`);
  for (const cmb of COMBOS) {
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      let cm = cache.get(sym);
      if (!cm) {
        try { const c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); cm = { c, m: loadMicroAligned(coin, '1', c) }; cache.set(sym, cm); }
        catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); continue; }
      }
      if (cm.c.length < 500 || cm.m.withData < 500) continue;
      const r = runBacktest(cmb.build(coin, cm.m), cm.c, cmb.slMode).tradesLog.map((t) => t.realizedPct);
      if (r.length < 10) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut), TAKER), oosN = net(r.slice(cut), TAKER);
      const f = folds4(r, TAKER);
      const n1 = net(r, TAKER), n2 = net(r, TAKER * 2);
      const green = r.length >= 25 && n1 > 0 && pf(r, TAKER) > 1.3 && isN > 0 && oosN > 0 && n2 > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ sig: cmb.sig, coin, n: r.length, net: n1, net2: n2, pf: pf(r, TAKER), wr: wr(r, TAKER), dd: maxDD(r, TAKER), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cmb.sig} done\n`);
  }
  writeFileSync('data/sweep-cvdexh-results.json', JSON.stringify(rows, null, 2));
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(9)} ${r.sig.padEnd(14)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(7)} ×2 ${String(r.net2).padStart(7)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(6)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const bySig = new Map<string, Row[]>();
  for (const r of rows) { const a = bySig.get(r.sig) ?? []; a.push(r); bySig.set(r.sig, a); }
  const robust = [...bySig.entries()].map(([sig, rs]) => ({ sig, green: rs.filter((r) => r.green).length, rs })).filter((x) => x.green >= 5).sort((a, b) => b.green - a.green);
  const totalEvents = rows.reduce((s, r) => s + r.n, 0) / Math.max(1, COMBOS.length);
  console.log(`===== ROBUST signatures (green on ≥5/${SYMBOLS.length}) =====`);
  if (!robust.length) console.log('  — none robust —');
  for (const x of robust) { console.log(`\n  ◆ ${x.sig} → ${x.green}/${SYMBOLS.length}`); console.log(x.rs.filter((r) => r.green).sort((a, b) => b.net - a.net).map(line).join('\n')); }
  console.log(`\nTop by net:`); console.log(rows.sort((a, b) => b.net - a.net).slice(0, 8).map(line).join('\n'));
  console.log(`\nGreen rows: ${rows.filter((r) => r.green).length}. Avg events/config ≈ ${totalEvents.toFixed(0)} (need ≥150 total / ≥25 per surviving coin — else UNTESTABLE).`);
  console.log('Full → data/sweep-cvdexh-results.json');
})().catch((e) => { console.error(e); process.exit(1); });

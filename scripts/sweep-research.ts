/**
 * RESEARCH-FAMILY SWEEP+VERIFY (batch 1: session-momentum #1, cascade-fade #2).
 * One pass = sweep param grids × 10 coins at HL taker fee, with 4-fold walk-
 * forward + cost-stress ×2/×3, and CROSS-SYMBOL survival per config signature
 * (a config is ROBUST only if green on ≥4 coins — single-coin = data-mining).
 * Run on the VPS (Bybit klines geo-blocked locally). pnpm tsx scripts/sweep-research.ts
 * Writes data/sweep-research-results.json.
 */

import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type SlMode } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { sessionMomentum, cascadeFade, absorptionFailRetest, nrSqueezeExpansion, bbwSqueezePctRank, insideBarCoil } from '../src/backtest/strategies/families-research.js';

const HL_TAKER = 0.07;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();

type Combo = { fam: 'session' | 'cascade' | 'absorp' | 'volcomp'; sig: string; tf: string; days: number; build: (s: string) => CustomStrategy; slMode: SlMode };

const combos: Combo[] = [];
// #1 session-momentum (taker; ATR slMode = crash guard, day-roll 'flat' = real exit)
for (const tf of ['30', '60']) for (const em of [1320, 1380, 1410]) for (const J of [1, 2]) for (const am of [1.5, 2.0])
  combos.push({ fam: 'session', sig: `em${em}J${J}a${am}-${tf}`, tf, days: tf === '60' ? 720 : 540, build: (s) => sessionMomentum(s, tf, em, J, 'both'), slMode: { kind: 'atr', mult: am, period: 14 } });
// #2 cascade-fade (taker; time vs atr+time exit)
for (const tf of ['15', '30']) {
  const H = tf === '15' ? 6 : 4; const days = tf === '15' ? 320 : 440;
  for (const vb of [3, 5]) for (const vm of [1.5, 2.0]) for (const vk of [2.5, 3]) for (const ig of [false, true]) for (const sm of ['time', 'at'] as const)
    combos.push({ fam: 'cascade', sig: `vb${vb}vm${vm}vk${vk}${ig ? 'i' : ''}${sm === 'time' ? 'T' : 'AT'}-${tf}`, tf, days, build: (s) => cascadeFade(s, tf, vb, vm, vk, 20, ig, 'both'), slMode: sm === 'time' ? { kind: 'time', bars: H } : { kind: 'atr+time', mult: 6, period: 14, bars: H } });
}
// #3 absorption-fail-retest (volume-climax wick rejection; pure time-stop exit) — the design-sweep survivor
for (const tf of ['15', '30']) for (const vk of [2.5, 3, 4]) for (const vl of [20, 30]) for (const wf of [0.5, 0.6]) for (const ib of [[0.35, 0.65], [0.45, 0.55]] as const) for (const tb of [4, 6, 8])
  combos.push({ fam: 'absorp', sig: `vk${vk}vl${vl}w${Math.round(wf * 100)}i${Math.round(ib[0] * 100)}b${tb}-${tf}`, tf, days: 400, build: (s) => absorptionFailRetest(s, tf, vk, vl, wf, ib[0], ib[1]), slMode: { kind: 'time', bars: tb } });
// #4-6 vol-compression family (squeeze → directional expansion breakout; SlMode time vs atr+time exit)
for (const tf of ['15', '30']) {
  const H = tf === '15' ? 8 : 6; const days = tf === '15' ? 320 : 440;
  const sl = (sm: 'time' | 'at'): SlMode => sm === 'time' ? { kind: 'time', bars: H } : { kind: 'atr+time', mult: 3, period: 14, bars: H };
  for (const nr of [4, 7]) for (const xk of [1.2, 1.5]) for (const sm of ['time', 'at'] as const)
    combos.push({ fam: 'volcomp', sig: `nr${nr}x${Math.round(xk * 100)}${sm === 'time' ? 'T' : 'AT'}-${tf}`, tf, days, build: (s) => nrSqueezeExpansion(s, tf, nr, xk), slMode: sl(sm) });
  for (const rl of [50, 100]) for (const pc of [0.2, 0.3]) for (const sm of ['time', 'at'] as const)
    combos.push({ fam: 'volcomp', sig: `bbw20r${rl}p${Math.round(pc * 100)}${sm === 'time' ? 'T' : 'AT'}-${tf}`, tf, days, build: (s) => bbwSqueezePctRank(s, tf, 20, rl, pc), slMode: sl(sm) });
  for (const mi of [1, 2, 3]) for (const sm of ['time', 'at'] as const)
    combos.push({ fam: 'volcomp', sig: `coil${mi}${sm === 'time' ? 'T' : 'AT'}-${tf}`, tf, days, build: (s) => insideBarCoil(s, tf, mi), slMode: sl(sm) });
}

function net(r: number[], fee: number) { let s = 0; for (const x of r) s += x - fee; return Math.round(s * 10) / 10; }
function pf(r: number[], fee: number) { let gp = 0, gl = 0; for (const x of r) { const y = x - fee; if (y >= 0) gp += y; else gl += -y; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[], fee: number) { return r.length ? Math.round((r.filter((x) => x - fee > 0).length / r.length) * 100) : 0; }
function maxDD(r: number[], fee: number) { let c = 0, p = 0, d = 0; for (const x of r) { c += x - fee; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds4(r: number[], fee: number) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) if (net(r.slice(f * k, f === 3 ? r.length : (f + 1) * k), fee) > 0) pos++; return pos; }

type Row = { fam: string; sig: string; coin: string; tf: string; n: number; net: number; net2: number; net3: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const cache = new Map<string, Candle[]>();
  const rows: Row[] = [];
  console.log(`Research sweep · ${combos.length} configs × ${SYMBOLS.length} coins · HL taker ${HL_TAKER}%\n`);
  for (const cmb of combos) {
    for (const coin of SYMBOLS) {
      const ck = `${coin}-${cmb.tf}-${cmb.days}`;
      let candles = cache.get(ck);
      if (!candles) { try { candles = await getKlines(coin, cmb.tf, NOW - cmb.days * 86_400_000, NOW); cache.set(ck, candles); } catch (e) { process.stderr.write(`  ${coin} ${cmb.tf}: ${(e as Error).message}\n`); continue; } }
      const strat = cmb.build(coin);
      if (candles.length < strat.warmup + 50) continue;
      const r = runBacktest(strat, candles, cmb.slMode).tradesLog.map((t) => t.realizedPct);
      const minN = cmb.fam === 'session' ? 40 : 15; const pfMin = cmb.fam === 'session' ? 1.15 : 1.3;
      if (r.length < 10) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut), HL_TAKER), oosN = net(r.slice(cut), HL_TAKER);
      const f = folds4(r, HL_TAKER);
      const n1 = net(r, HL_TAKER), n2 = net(r, HL_TAKER * 2), n3 = net(r, HL_TAKER * 3);
      const foldsOk = r.length >= 16 ? f >= 3 : (isN > 0 && oosN > 0);
      const green = r.length >= minN && n1 > 0 && pf(r, HL_TAKER) > pfMin && isN > 0 && oosN > 0 && n2 > 0 && foldsOk;
      rows.push({ fam: cmb.fam, sig: cmb.sig, coin, tf: cmb.tf, n: r.length, net: n1, net2: n2, net3: n3, pf: pf(r, HL_TAKER), wr: wr(r, HL_TAKER), dd: maxDD(r, HL_TAKER), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cmb.fam} ${cmb.sig} done\n`);
  }
  writeFileSync('data/sweep-research-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(9)} ${r.tf.padEnd(3)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(7)} ×2 ${String(r.net2).padStart(7)} ×3 ${String(r.net3).padStart(7)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(6)} folds ${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  for (const fam of ['session', 'cascade', 'absorp', 'volcomp']) {
    const fr = rows.filter((r) => r.fam === fam);
    // cross-symbol robustness: signatures green on >=4 coins
    const bySig = new Map<string, Row[]>();
    for (const r of fr) { const a = bySig.get(r.sig) ?? []; a.push(r); bySig.set(r.sig, a); }
    const robust = [...bySig.entries()].map(([sig, rs]) => ({ sig, green: rs.filter((r) => r.green).length, rows: rs })).filter((x) => x.green >= 4).sort((a, b) => b.green - a.green);
    console.log(`\n===== ${fam.toUpperCase()} — ROBUST signatures (green on ≥4/10 coins) =====`);
    if (!robust.length) console.log('  — none robust —');
    for (const x of robust) {
      console.log(`\n  ◆ ${x.sig}  → green ${x.green}/10 coins`);
      console.log(x.rows.filter((r) => r.green).sort((a, b) => b.net - a.net).map(line).join('\n'));
    }
    const greens = fr.filter((r) => r.green).length;
    console.log(`\n  ${fam}: ${greens} green rows across ${bySig.size} signatures.`);
  }
  console.log(`\nFull dump → data/sweep-research-results.json. Green = candidate; ROBUST (≥4 coins) = worth the lab. Single-coin greens are likely data-mining.`);
})().catch((e) => { console.error(e); process.exit(1); });

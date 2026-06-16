/**
 * IDEA #5 — LIQUIDATION-VACUUM MAKER PROVISIONING (custom maker-fill backtest).
 * Forced-liquidation flow empties one side of the book and overshoots; price
 * snaps back as the book refills. Instead of crossing the spread to FADE (the
 * taker liqCascadeFade died at ×2 fee), we REST a passive limit into the flush —
 * forced sellers fill US at a better price (maker), we exit into the snapback.
 * Needs ONLY liquidations (full ~10.5mo) + 1m klines — NO CVD, testable now.
 *
 * Faithful maker model: on a cascade bar i, rest an entry limit at close·(1∓d);
 * FILL only if a later bar within TTL touches it (entry = the limit price, maker).
 * Exit: maker target limit at +/−`tgt` (snapback) | catastrophe SL (taker) |
 * max-hold (taker). Honest adverse selection: if the flush blows through the
 * limit we ARE filled and then eat the continued move via SL/time.
 * Kill-battery: cross-symbol ROBUST≥4 + 4-fold walk-forward + cost-stress.
 * Run on the VPS. pnpm tsx scripts/backtest-liqvacuum.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 60);
const MK = 0.02, TK = 0.045; // HL maker / taker per side %

function rollMean(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] ?? 0; if (i >= W) s -= a[i - W] ?? 0; out[i] = s / Math.min(i + 1, W); }
  return out;
}

type Cfg = { sig: string; liqK: number; d: number; tgt: number; sl: number; ttl: number; hold: number; velBars: number; velThr: number };
const CFGS: Cfg[] = [];
for (const liqK of [4, 6]) for (const d of [0.002, 0.004]) for (const tgt of [0.004, 0.006]) for (const velThr of [0.005, 0.008])
  CFGS.push({ sig: `K${liqK}d${d}t${tgt}v${velThr}`, liqK, d, tgt, sl: 0.015, ttl: 10, hold: 30, velBars: 3, velThr });

/** returns realized NET % per trade for one coin+config (maker model). */
function runVacuum(c: Candle[], liq: (number | null)[], cfg: Cfg): number[] {
  const liqAvg = rollMean(liq, 240);
  const out: number[] = []; const n = c.length;
  let i = 250;
  while (i < n - 1) {
    const lq = liq[i]; const la = liqAvg[i];
    if (lq == null || !(la! > 0) || lq < cfg.liqK * la!) { i++; continue; }
    const ref = c[i - cfg.velBars]; if (!ref) { i++; continue; }
    const down = (ref.c - c[i]!.c) / ref.c;   // >0 = price fell into the flush
    const up = -down;
    let side: 1 | -1 | 0 = 0;
    if (down >= cfg.velThr) side = 1; else if (up >= cfg.velThr) side = -1;
    if (side === 0) { i++; continue; }
    const limit = side === 1 ? c[i]!.c * (1 - cfg.d) : c[i]!.c * (1 + cfg.d);
    // rest the maker limit; fill only if a later bar touches it within TTL
    let fi = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + cfg.ttl); j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fi = j; break; } }
    if (fi < 0) { i++; continue; }                     // unfilled — missed cascade costs nothing
    const entry = limit;
    const tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    const slPx = side === 1 ? entry * (1 - cfg.sl) : entry * (1 + cfg.sl);
    let exit = 0; let exitFee = TK;                    // default exit = taker (time/SL)
    let k = fi + 1; const kmax = Math.min(n - 1, fi + cfg.hold);
    for (; k <= kmax; k++) {
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; exitFee = TK; break; }   // catastrophe first
      if (side === 1 ? c[k]!.h >= tgtPx : c[k]!.l <= tgtPx) { exit = tgtPx; exitFee = MK; break; } // maker snapback
    }
    if (exit === 0) { exit = c[kmax]!.c; exitFee = TK; }                                            // time exit
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - MK - exitFee);                    // entry maker + exit fee
    i = k + 1;                                          // step past the trade
  }
  return out;
}

function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], extra: number) { return Math.round(r.reduce((s, x) => s + x - extra, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; liq: (number | null)[] }>();
  console.log(`Liq-vacuum MAKER backtest · 1m · ${SYMBOLS.length} coins · ${CFGS.length} configs · ${DAYS}d · maker ${MK}/taker ${TK}%\n`);
  for (const cfg of CFGS) {
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      let cm = cache.get(sym);
      if (!cm) { try { const c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); cm = { c, liq: loadMicroAligned(coin, '1', c).liq }; cache.set(sym, cm); } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); continue; } }
      if (cm.c.length < 500) continue;
      const r = runVacuum(cm.c, cm.liq, cfg);
      if (r.length < 15) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.3 && isN > 0 && oosN > 0 && netStress(r, MK + TK) > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ sig: cfg.sig, coin, n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cfg.sig} done\n`);
  }
  writeFileSync('data/liqvacuum-results.json', JSON.stringify(rows, null, 2));
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(9)} ${r.sig.padEnd(20)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(7)} +cost ${String(r.net2).padStart(7)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(6)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const bySig = new Map<string, Row[]>();
  for (const r of rows) { const a = bySig.get(r.sig) ?? []; a.push(r); bySig.set(r.sig, a); }
  const robust = [...bySig.entries()].map(([sig, rs]) => ({ sig, g: rs.filter((r) => r.green).length, rs })).filter((x) => x.g >= 4).sort((a, b) => b.g - a.g);
  console.log(`===== ROBUST (green on ≥4/${SYMBOLS.length}) =====`);
  if (!robust.length) console.log('  — none robust —');
  for (const x of robust) { console.log(`\n  ◆ ${x.sig} → ${x.g}/${SYMBOLS.length}`); console.log(x.rs.filter((r) => r.green).sort((a, b) => b.net - a.net).map(line).join('\n')); }
  console.log(`\nGreen rows: ${rows.filter((r) => r.green).length}. Top by net:`); console.log(rows.sort((a, b) => b.net - a.net).slice(0, 8).map(line).join('\n'));
  console.log('\n(+cost column = survives an EXTRA maker+taker round-trip of fees = adverse-selection cushion.) Full → data/liqvacuum-results.json');
})().catch((e) => { console.error(e); process.exit(1); });

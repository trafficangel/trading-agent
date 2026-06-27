/**
 * BIG-SEARCH batch-2 — the 4 most-distinct survivors of the design workflow (the 14 simple indicators
 * returned 0/560; these add the UNDER-EXPLORED dimensions: regime-gating, HTF confluence, adaptive
 * EXITS, and price-action structure). Self-contained backtests (each owns its adaptive exit + hard
 * SL + max-hold), look-ahead-safe (reads <= i, entry at close[i], exits scan forward). LOWER hook bar
 * + Kelly/expectancy/Sharpe money-mgmt metrics. Run on the VPS. pnpm tsx scripts/sweep-bigsearch.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { sma, ema, atr, rsi, rollingStd, type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 320);
const TK = 0.07;

const trade = (side: 1 | -1, entry: number, exit: number) => (side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100 - TK;

/** S1 regimeGated: efficiency-ratio gate → RSI-MR in ranging / Donchian-momentum in trending. */
function regimeGated(c: Candle[], erLo: number, erHi: number): number[] {
  const n = c.length; const close = c.map((x) => x.c); const RS = rsi(c, 14); const m20 = sma(close, 20); const a = atr(c, 14);
  const N = 14, D = 20; const out: number[] = []; let g = -1;
  const donHi = (i: number) => { let h = -Infinity; for (let j = i - D; j < i; j++) h = Math.max(h, c[j]!.h); return h; };
  const donLo = (i: number) => { let l = Infinity; for (let j = i - D; j < i; j++) l = Math.min(l, c[j]!.l); return l; };
  for (let i = 60; i < n - 1; i++) {
    if (i <= g) continue;
    let chg = 0; for (let j = i - N + 1; j <= i; j++) chg += Math.abs(c[j]!.c - c[j - 1]!.c);
    const er = chg > 0 ? Math.abs(c[i]!.c - c[i - N]!.c) / chg : 0;
    let side: 1 | -1 | 0 = 0; let mode: 'mr' | 'mom' = 'mr';
    if (er < erLo) { if (RS[i - 1]! < 30 && RS[i]! >= 30) side = 1; else if (RS[i - 1]! > 70 && RS[i]! <= 70) side = -1; mode = 'mr'; }
    else if (er > erHi) { if (c[i]!.c > donHi(i)) side = 1; else if (c[i]!.c < donLo(i)) side = -1; mode = 'mom'; }
    if (side === 0) continue;
    const entry = c[i]!.c; const aE = a[i]!; let exit = 0; const kmax = Math.min(n - 1, i + (mode === 'mr' ? 30 : 20));
    let best = entry; let k = i + 1;
    for (; k <= kmax; k++) {
      const slPx = mode === 'mr' ? (side === 1 ? entry - 2.2 * aE : entry + 2.2 * aE) : (side === 1 ? best - 3 * aE : best + 3 * aE);
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; break; }
      if (mode === 'mr') { if (side === 1 ? c[k]!.c >= m20[k]! : c[k]!.c <= m20[k]!) { exit = c[k]!.c; break; } } // mean-touch
      else { best = side === 1 ? Math.max(best, c[k]!.c) : Math.min(best, c[k]!.c); } // trail tracks best
    }
    if (exit === 0) exit = c[kmax]!.c;
    out.push(trade(side, entry, exit)); g = kmax;
  }
  return out;
}

/** S2 htfTrendPullback: 4h EMA-trend gate (group 15m→4h) → 15m pullback-to-EMA20 entry, exit on stall. */
function htfTrendPullback(c: Candle[], gpb: number): number[] {
  const n = c.length; const close = c.map((x) => x.c); const e20 = ema(close, 20); const a = atr(c, 14);
  // build 4h closes from completed groups of gpb bars, htf state per bar (causal: only completed groups)
  const htf = new Array<number>(n).fill(0); // +1 up, -1 down
  const g4: number[] = []; // 4h closes
  for (let i = 0; i < n; i++) {
    if (i > 0 && Math.floor(i / gpb) !== Math.floor((i - 1) / gpb)) g4.push(c[i - 1]!.c); // close a 4h group
    if (g4.length >= 27) { const ef = ema(g4, 8), es = ema(g4, 21); const L = g4.length - 1; const slope = g4.length > 7 ? es[L]! - es[L - 6]! : 0; htf[i] = ef[L]! > es[L]! && slope > 0 ? 1 : ef[L]! < es[L]! && slope < 0 ? -1 : 0; }
  }
  const out: number[] = []; let gd = -1;
  for (let i = 60; i < n - 1; i++) {
    if (i <= gd || htf[i] === 0) continue;
    const s = htf[i];
    // pullback: 2 down-closes into rising ema20 (for up), then a reclaim close>ema20
    const pulled = s === 1 ? (c[i - 1]!.c < c[i - 2]!.c && c[i]!.c > e20[i]! && c[i - 1]!.c <= e20[i - 1]!) : (c[i - 1]!.c > c[i - 2]!.c && c[i]!.c < e20[i]! && c[i - 1]!.c >= e20[i - 1]!);
    if (!pulled) continue;
    const side = s as 1 | -1; const entry = c[i]!.c; const aE = a[i]!; let exit = 0; const kmax = Math.min(n - 1, i + 12);
    let k = i + 1;
    for (; k <= kmax; k++) {
      const slPx = side === 1 ? entry - 2.5 * aE : entry + 2.5 * aE;
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; break; }
      if (side === 1 ? c[k]!.c < e20[k]! : c[k]!.c > e20[k]!) { exit = c[k]!.c; break; }     // momentum stall = exit
      if (htf[k] !== s) { exit = c[k]!.c; break; }                                            // HTF flip = exit
    }
    if (exit === 0) exit = c[kmax]!.c;
    out.push(trade(side, entry, exit)); gd = kmax;
  }
  return out;
}

/** S3 movingBandMR: z-MR entry + exit-to-the-MOVING-band (drifts toward price as vol decays). */
function movingBandMR(c: Candle[], p: number, kEnt: number, exitK: number): number[] {
  const n = c.length; const close = c.map((x) => x.c); const mid = sma(close, p); const sd = rollingStd(close, p);
  const out: number[] = []; let g = -1;
  for (let i = p + 2; i < n - 1; i++) {
    if (i <= g) continue;
    let side: 1 | -1 | 0 = 0;
    if (c[i]!.c < mid[i]! - kEnt * sd[i]!) side = 1; else if (c[i]!.c > mid[i]! + kEnt * sd[i]!) side = -1;
    if (side === 0) continue;
    const entry = c[i]!.c; const slPct = 0.05; let exit = 0; const kmax = Math.min(n - 1, i + 8); let k = i + 1;
    for (; k <= kmax; k++) {
      const slPx = side === 1 ? entry * (1 - slPct) : entry * (1 + slPct);
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; break; }
      const tgt = side === 1 ? mid[k]! + exitK * sd[k]! : mid[k]! - exitK * sd[k]!;   // MOVING band target (drifts)
      if (side === 1 ? c[k]!.h >= tgt : c[k]!.l <= tgt) { exit = tgt; break; }
    }
    if (exit === 0) exit = c[kmax]!.c;
    out.push(trade(side, entry, exit)); g = kmax;
  }
  return out;
}

/** S4 failedBreakoutStopRun: sweep a confirmed swing pivot then close back inside → fade (structural stop). */
function failedBreakoutStopRun(c: Candle[], L: number): number[] {
  const n = c.length; const a = atr(c, 14); const out: number[] = []; let g = -1;
  // confirmed pivots known at j+L
  const isHigh = (j: number) => { for (let m = 1; m <= L; m++) if (!(c[j]!.h > c[j - m]!.h && c[j]!.h > c[j + m]!.h)) return false; return true; };
  const isLow = (j: number) => { for (let m = 1; m <= L; m++) if (!(c[j]!.l < c[j - m]!.l && c[j]!.l < c[j + m]!.l)) return false; return true; };
  for (let i = 60; i < n - 1; i++) {
    if (i <= g) continue;
    // most recent confirmed swing high/low (pivot at j confirmed when i >= j+L)
    let H = -Infinity, Lo = Infinity;
    for (let j = i - L - 1; j >= Math.max(L, i - 40); j--) { if (H === -Infinity && isHigh(j)) H = c[j]!.h; if (Lo === Infinity && isLow(j)) Lo = c[j]!.l; if (H > -Infinity && Lo < Infinity) break; }
    let side: 1 | -1 | 0 = 0; let stop = 0; let tgt = 0;
    if (H > -Infinity && c[i]!.h > H && c[i]!.c < H) { side = -1; stop = c[i]!.h + 0.2 * a[i]!; tgt = c[i]!.c * (1 - 0.005); } // swept high, closed back below → short
    else if (Lo < Infinity && c[i]!.l < Lo && c[i]!.c > Lo) { side = 1; stop = c[i]!.l - 0.2 * a[i]!; tgt = c[i]!.c * (1 + 0.005); }
    if (side === 0) continue;
    const entry = c[i]!.c; let exit = 0; const kmax = Math.min(n - 1, i + 12); let k = i + 1;
    for (; k <= kmax; k++) {
      if (side === 1 ? c[k]!.l <= stop : c[k]!.h >= stop) { exit = stop; break; }
      if (side === 1 ? c[k]!.h >= tgt : c[k]!.l <= tgt) { exit = tgt; break; }
    }
    if (exit === 0) exit = c[kmax]!.c;
    out.push(trade(side, entry, exit)); g = kmax;
  }
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }
function kelly(r: number[]) { const m = mean(r); const v = mean(r.map((x) => (x - m) ** 2)); return v > 0 ? Math.round((m / v) * 100) / 100 : 0; }
function sharpe(r: number[]) { const m = mean(r); const sd = Math.sqrt(mean(r.map((x) => (x - m) ** 2))); return sd > 0 ? Math.round((m / sd) * 100) / 100 : 0; }

type Variant = { name: string; tf: string; fn: (c: Candle[]) => number[] };
const VARIANTS: Variant[] = [
  { name: 'regimeGated-l30h45', tf: '15', fn: (c) => regimeGated(c, 0.30, 0.45) },
  { name: 'regimeGated-l25h40', tf: '15', fn: (c) => regimeGated(c, 0.25, 0.40) },
  { name: 'htfTrendPull-15', tf: '15', fn: (c) => htfTrendPullback(c, 16) },
  { name: 'htfTrendPull-5', tf: '5', fn: (c) => htfTrendPullback(c, 48) },
  { name: 'movingBandMR-20k2x0', tf: '15', fn: (c) => movingBandMR(c, 20, 2.0, 0) },
  { name: 'movingBandMR-20k2xn5', tf: '15', fn: (c) => movingBandMR(c, 20, 2.0, -0.5) },
  { name: 'failedBreakStopRun-L3', tf: '5', fn: (c) => failedBreakoutStopRun(c, 3) },
  { name: 'failedBreakStopRun-L2', tf: '5', fn: (c) => failedBreakoutStopRun(c, 2) },
];

type Row = { v: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; exp: number; kelly: number; sharpe: number; isN: number; oosN: number; folds: number; hook: boolean };

(async () => {
  const rows: Row[] = []; const cache = new Map<string, Candle[]>();
  console.log(`BIG-SEARCH batch-2 · ${VARIANTS.length} strategies × 10 coins · ${DAYS}d · HL taker ${TK}% · hook = net2>0 + IS/OOS+ + folds≥3 (single-coin OK) + Kelly>0\n`);
  for (const v of VARIANTS) {
    for (const sym of SYMBOLS) {
      const ck = `${sym}-${v.tf}`; let c = cache.get(ck);
      if (!c) { try { c = await getKlines(sym, v.tf, NOW - DAYS * 86_400_000, NOW); cache.set(ck, c); } catch { continue; } }
      if (c.length < 800) continue;
      const r = v.fn(c); if (r.length < 25) continue;
      const cut = Math.floor(r.length * 0.7); const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r); const n2 = net(r, TK);
      const hook = r.length >= 30 && net(r) > 0 && n2 > 0 && pf(r) > 1.1 && isN > 0 && oosN > 0 && f >= 3 && kelly(r) > 0;
      rows.push({ v: v.name, coin: sym.replace('USDT', ''), n: r.length, net: net(r), net2: n2, pf: pf(r), wr: wr(r), exp: Math.round(mean(r) * 1000) / 1000, kelly: kelly(r), sharpe: sharpe(r), isN, oosN, folds: f, hook });
    }
  }
  writeFileSync('data/bigsearch-results.json', JSON.stringify(rows, null, 2));
  const hooks = rows.filter((r) => r.hook).sort((a, b) => b.net2 - a.net2);
  console.log(`===== HOOKS (real edge after cost + IS/OOS+) — ${hooks.length} found =====`);
  console.log('   coin  strategy               N    net  +cost   PF  WR%  exp%/tr  KELLY  Sharpe  IS/OOS');
  for (const r of hooks) console.log(`✅ ${r.coin.padEnd(5)} ${r.v.padEnd(22)} ${String(r.n).padStart(4)} ${String(r.net).padStart(6)} ${String(r.net2).padStart(6)} ${String(r.pf).padStart(4)} ${String(r.wr).padStart(3)} ${String(r.exp).padStart(7)} ${String(r.kelly).padStart(6)} ${String(r.sharpe).padStart(6)}  ${r.isN}/${r.oosN}`);
  console.log('\n===== per-strategy: best coin (net2) + how many coins net2>0 =====');
  for (const v of VARIANTS) { const fr = rows.filter((r) => r.v === v.name); if (!fr.length) continue; const pos = fr.filter((r) => r.net2 > 0).length; const best = fr.slice().sort((a, b) => b.net2 - a.net2)[0]!; console.log(`  ${v.name.padEnd(22)} ${pos}/${fr.length} coins net2>0 · best ${best.coin} net2 ${best.net2} PF ${best.pf} K ${best.kelly} IS/OOS ${best.isN}/${best.oosN}`); }
  console.log(`\n(${hooks.length} hooks / ${rows.length} tested. Full → data/bigsearch-results.json)`);
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * CVD-MOMENTUM vs CVD-FADE (A/B by construction) — the order-flow CONTINUATION test.
 *
 * Our maker/reversion graveyard (book-refill, velocity-trigger, mark-pull, large-print
 * climax) all FADE aggressive flow and all died to ADVERSE SELECTION. That repeated
 * failure is itself evidence the aggressive flow on HL is INFORMED. The unexplored,
 * data-implied inversion: don't fade the flow — RIDE it. When rolling CVD pushes hard
 * AND price confirms (breakout in the same direction), enter WITH the flow on a 5m/15m
 * bar and ride the continuation.
 *
 * A/B (direction refutation, the whole point): FOLLOW arm enters WITH the CVD push;
 * FADE arm enters AGAINST it on the SAME triggers. If FOLLOW is green where FADE is red
 * → flow is informed and continuation is the edge. If FADE wins → we were right to fade
 * all along and the deaths were execution, not direction. If neither → no flow edge here.
 *
 * Entry is TAKER both sides (momentum can't always rest passive) → must overcome a full
 * taker RT (~0.09%) + a +cost stress of an extra RT. Bars = 5m and 15m (per-minute CVD
 * summed into bars). Causal: signal uses bars ≤ i, enter at close[i], exits scan forward.
 *
 * Runs on the recent contiguous CVD cluster (~11d) — PRELIMINARY cross-symbol read, same
 * caveat as mark-pull's 9d. Run on the VPS. pnpm tsx scripts/backtest-cvd-momentum.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 20);
const MK = 0.02, TK = 0.045; // HL maker / taker per side %

/** Aggregate 1m candles + per-minute CVD into BAR-minute bars (look-ahead-safe). */
function toBars(c: Candle[], cvd: (number | null)[], barMin: number): { o: number; h: number; l: number; cl: number; t: number; cvd: number | null }[] {
  const out: { o: number; h: number; l: number; cl: number; t: number; cvd: number | null }[] = [];
  const step = barMin * 60_000;
  let i = 0;
  while (i < c.length) {
    const t0 = Math.floor(c[i]!.t / step) * step;
    let o = c[i]!.o, h = c[i]!.h, l = c[i]!.l, cl = c[i]!.c, sum = 0, any = false;
    let j = i;
    for (; j < c.length && c[j]!.t < t0 + step; j++) {
      h = Math.max(h, c[j]!.h); l = Math.min(l, c[j]!.l); cl = c[j]!.c;
      const v = cvd[j]; if (v != null) { sum += v; any = true; }
    }
    out.push({ o, h, l, cl, t: t0, cvd: any ? sum : null });
    i = j;
  }
  return out;
}

function rollStd(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0, ss = 0; const buf: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0; buf.push(x); s += x; ss += x * x;
    if (buf.length > W) { const old = buf.shift()!; s -= old; ss -= old * old; }
    const n = buf.length; const mean = s / n; out[i] = Math.sqrt(Math.max(0, ss / n - mean * mean));
  }
  return out;
}

type Cfg = { sig: string; core: string; bar: number; L: number; N: number; z: number; tgt: number; sl: number; hold: number; follow: boolean };
const CFGS: Cfg[] = [];
for (const bar of [5, 15]) for (const L of [3, 5]) for (const z of [1.5, 2, 2.5]) for (const tgt of [0.004, 0.008]) for (const follow of [true, false]) {
  const core = `b${bar}L${L}z${z}t${tgt}`;
  CFGS.push({ sig: `${core}${follow ? '_F' : '_R'}`, core, bar, L, N: 50, z, tgt, sl: 0.01, hold: 8, follow });
}

/** realized NET % per trade. Taker both sides. side = direction of the CVD push (FOLLOW) or its inverse (FADE). */
function run(bars: { o: number; h: number; l: number; cl: number; t: number; cvd: number | null }[], cfg: Cfg): number[] {
  const n = bars.length;
  // rolling-L CVD sum + its rolling-N std for a z-score; price return over L bars for the confirm
  const rollCvd: (number | null)[] = new Array(n).fill(null);
  for (let i = cfg.L - 1; i < n; i++) {
    let s = 0, ok = true;
    for (let k = 0; k < cfg.L; k++) { const v = bars[i - k]!.cvd; if (v == null) { ok = false; break; } s += v; }
    rollCvd[i] = ok ? s : null;
  }
  const std = rollStd(rollCvd, cfg.N);
  const out: number[] = [];
  let i = cfg.N + cfg.L;
  while (i < n - 1) {
    const rc = rollCvd[i]; const sd = std[i];
    if (rc == null || !(sd! > 0)) { i++; continue; }
    const zc = rc / sd!;
    if (Math.abs(zc) < cfg.z) { i++; continue; }
    const ref = bars[i - cfg.L]; if (!ref) { i++; continue; }
    const ret = (bars[i]!.cl - ref.cl) / ref.cl;     // price move over the lookback
    const pushUp = zc > 0;                            // CVD net buying
    // confirm: price must agree with the flow (a real breakout, not chop)
    if (pushUp ? ret <= 0 : ret >= 0) { i++; continue; }
    const flowSide: 1 | -1 = pushUp ? 1 : -1;
    const side: 1 | -1 = cfg.follow ? flowSide : (flowSide === 1 ? -1 : 1);
    const entry = bars[i]!.cl;                         // taker at bar close (signal known at close)
    const tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    const slPx = side === 1 ? entry * (1 - cfg.sl) : entry * (1 + cfg.sl);
    let exit = 0;
    let k = i + 1; const kmax = Math.min(n - 1, i + cfg.hold);
    for (; k <= kmax; k++) {
      if (side === 1 ? bars[k]!.l <= slPx : bars[k]!.h >= slPx) { exit = slPx; break; }
      if (side === 1 ? bars[k]!.h >= tgtPx : bars[k]!.l <= tgtPx) { exit = tgtPx; break; }
    }
    if (exit === 0) { exit = bars[kmax]!.cl; }
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - TK - TK);                         // taker entry + taker exit
    i = k + 1;
  }
  return out;
}

function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], extra: number) { return Math.round(r.reduce((s, x) => s + x - extra, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; core: string; follow: boolean; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; cvd: (number | null)[]; cov: number }>();
  console.log(`CVD-MOMENTUM vs FADE · 1m→5m/15m bars · ${SYMBOLS.length} coins · ${CFGS.length} configs (follow/fade A/B) · ${DAYS}d · TAKER ${TK}%/side\n`);
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    try { const c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); const m = loadMicroAligned(coin, '1', c); cache.set(sym, { c, cvd: m.cvd, cov: m.coverage }); }
    catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); }
  }
  for (const cfg of CFGS) {
    for (const sym of SYMBOLS) {
      const cm = cache.get(sym); if (!cm || cm.c.length < 500) continue;
      const bars = toBars(cm.c, cm.cvd, cfg.bar);
      const r = run(bars, cfg);
      if (r.length < 20) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && netStress(r, MK + TK) > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ sig: cfg.sig, core: cfg.core, follow: cfg.follow, coin: sym.replace('USDT', ''), n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cfg.sig} done\n`);
  }
  const covLine = [...cache.entries()].map(([s, cm]) => `${s.replace('USDT', '')}:${cm.cov}`).join(' ');
  console.log(`cvd coverage in window: ${covLine}\n`);
  writeFileSync('data/cvd-momentum-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(18)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robust = (follow: boolean) => { const m = new Map<string, string[]>(); for (const r of rows.filter((x) => x.follow === follow && x.green)) { const a = m.get(r.core) ?? []; a.push(r.coin); m.set(r.core, a); } return [...m.entries()].map(([core, coins]) => ({ core, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length); };

  const fOn = robust(true); const fOff = robust(false);
  console.log('===== A/B: FOLLOW (ride flow) vs FADE (against flow) · cross-symbol robust ≥4 =====');
  console.log(`  FOLLOW: ${fOn.length ? fOn.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log(`  FADE  : ${fOff.length ? fOff.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log('\n===== VERDICT =====');
  const onBest = fOn[0]?.coins.length ?? 0; const offBest = fOff[0]?.coins.length ?? 0;
  if (onBest >= 4 && onBest > offBest) console.log(`  ✓ CANDIDATE — FOLLOW robust ${onBest}/10 {${fOn[0]!.coins.join(',')}} > FADE (${offBest}) → flow is INFORMED, continuation is the edge. Confirm on a 2nd window (region-instance CVD backfill) before any capital.`);
  else if (offBest >= 4 && offBest > onBest) console.log(`  ✓ CANDIDATE (FADE) — FADE robust ${offBest}/10 {${fOff[0]!.coins.join(',')}} > FOLLOW (${onBest}) → reversion direction was right; the maker deaths were EXECUTION not direction. Re-test with patient maker entry.`);
  else console.log(`  ✗ KILL — FOLLOW ${onBest}/10, FADE ${offBest}/10 (need ≥4 and a clear winner). No directional flow edge on this window.`);

  console.log('\n===== green rows (detail) =====');
  const gr = rows.filter((r) => r.green); if (gr.length) console.log(gr.sort((a, b) => b.net2 - a.net2).slice(0, 16).map(line).join('\n')); else console.log('  — none green —');
  console.log('\n(+cost = survives an EXTRA maker+taker RT.) Full → data/cvd-momentum-results.json');
})().catch((e) => { console.error(e); process.exit(1); });

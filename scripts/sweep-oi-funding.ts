/**
 * OI-GATE (A) + HL↔BYBIT FUNDING-DIVERGENCE (B) sweep — the two angles the 2026
 * microstructure literature converges on (OI + funding + liquidations), applied
 * to OUR one verified edge (funding-flip).
 *
 * BASE SIGNAL (verbatim from the validated flip): per coin, HL hourly funding
 * z-scored over W; if |z|>=zThr occurred within the last `fw` hours and funding
 * then FLIPS SIGN by bar i, enter a snap-back AWAY from the wiped side; pure
 * `hold`-hour time-stop. Validated on ETH+ADA.
 *
 * A — does BYBIT OI carry information about WHICH flips snap back? First an
 * HONEST STRATIFIED DIAGNOSTIC (bucket flips by OI percentile / dOI sign, compare
 * per-bucket expectancy — reveals signal before we commit a threshold), then
 * GATE variants scored with the full kill-battery + Kelly. PLACEBO: circular-
 * shift the OI series → any apparent gate improvement must vanish.
 *
 * B — z-score each venue's funding vs its own history (unit-free, sidesteps the
 * HL-1h vs Bybit-8h cadence); trade the cross-venue SPREAD blow-out (fade the
 * more-extreme venue), and test flip CONFIRM (both venues crowded) vs DIVERGE
 * (only HL). PLACEBO: shuffle Bybit funding → divergence signal must die.
 *
 * Data: hl_micro.funding (700d) + bybit_micro.oi/funding (400d) + 1h klines, all
 * on the VPS. Causal (settled funding, OI<=decision, enter at close[i]). Cost =
 * HL taker 0.07% RT, stressed x2/x3.   Run on the VPS:
 *   pnpm tsx scripts/sweep-oi-funding.ts [days] [PLACEBO=oi|byfund]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned, loadBybitAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const DAYS = Number(process.argv[2] ?? 395); // overlap window of bybit_micro (≈400d) — stay just inside it
const PLACEBO = (process.env.PLACEBO ?? '') as '' | 'oi' | 'byfund';
const NOW = Date.now();
const HL_TAKER = 0.07;
const FLIP = { W: 360, zThr: 2, fw: 6, hold: 24 }; // the validated base config

// ── rolling helpers (all causal: window is [i-L+1, i], every element <= i) ──
function rollMeanStd(a: (number | null)[], i: number, W: number): { m: number; sd: number } {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}
function pctRank(a: (number | null)[], i: number, L: number): number | null {
  const v = a[i]; if (v == null) return null;
  let cnt = 0, tot = 0;
  for (let j = Math.max(0, i - L + 1); j <= i; j++) { const x = a[j]; if (x != null) { tot++; if (x <= v) cnt++; } }
  return tot < L / 2 ? null : cnt / tot;
}
function relChange(a: (number | null)[], i: number, k: number): number | null {
  const v = a[i], p = a[i - k]; if (v == null || p == null || p === 0) return null; return (v - p) / Math.abs(p);
}

// ── metrics (net% per trade; taker already subtracted in the trade builder) ──
function sum(r: number[], extra = 0) { return Math.round(r.reduce((s, x) => s + x - extra, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }
function kelly(r: number[]) { // f* ≈ μ/σ² in fraction units; expectancy = mean%; per-trade Sharpe = mean/sd
  const n = r.length; if (n < 2) return { mean: 0, sd: 0, kelly: 0, sharpe: 0 };
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const varc = r.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  const sd = Math.sqrt(varc);
  const muF = mean / 100, sdF = sd / 100;
  const k = sdF > 0 ? muF / (sdF * sdF) : 0;
  return { mean: Math.round(mean * 1000) / 1000, sd: Math.round(sd * 1000) / 1000, kelly: Math.round(k * 100) / 100, sharpe: sd > 0 ? Math.round((mean / sd) * 100) / 100 : 0 };
}
const green = (r: number[]) => {
  if (r.length < 15) return false;
  const cut = Math.floor(r.length * 0.7);
  const isN = sum(r.slice(0, cut)), oosN = sum(r.slice(cut));
  return sum(r) > 0 && pf(r) > 1.25 && isN > 0 && oosN > 0 && sum(r, HL_TAKER) > 0 && (r.length >= 16 ? folds(r) >= 3 : true);
};

type Flip = { i: number; side: 1 | -1 };
/** the validated flip events (causal): index + snap-back side. */
function flipEvents(c: Candle[], hlF: (number | null)[]): Flip[] {
  const out: Flip[] = []; const n = c.length;
  for (let i = FLIP.W; i < n - 1; i++) {
    const { m, sd } = rollMeanStd(hlF, i, FLIP.W); if (!(sd > 0)) continue;
    const prevWin = hlF.slice(Math.max(0, i - FLIP.fw - 1), i);
    const wasPos = prevWin.some((v) => v != null && (v - m) / sd >= FLIP.zThr);
    const wasNeg = prevWin.some((v) => v != null && (v - m) / sd <= -FLIP.zThr);
    const now = hlF[i], prev = hlF[i - 1]; if (now == null || prev == null) continue;
    if (wasPos && prev > 0 && now <= 0) out.push({ i, side: 1 });
    else if (wasNeg && prev < 0 && now >= 0) out.push({ i, side: -1 });
  }
  return out;
}
function tradeRet(c: Candle[], f: Flip): number {
  const n = c.length; const entry = c[f.i]!.c; const exit = c[Math.min(n - 1, f.i + FLIP.hold)]!.c;
  const gross = f.side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
  return gross - HL_TAKER;
}

type Row = { kind: string; cfg: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; folds: number; isN: number; oosN: number; mean: number; kelly: number; sharpe: number; green: boolean };
function mkRow(kind: string, cfg: string, coin: string, r: number[]): Row {
  const cut = Math.floor(r.length * 0.7); const km = kelly(r);
  return { kind, cfg, coin, n: r.length, net: sum(r), net2: sum(r, HL_TAKER), pf: pf(r), wr: wr(r), folds: folds(r), isN: sum(r.slice(0, cut)), oosN: sum(r.slice(cut)), mean: km.mean, kelly: km.kelly, sharpe: km.sharpe, green: green(r) };
}

(async () => {
  console.log(`OI-GATE (A) + HL↔Bybit FUNDING-DIVERGENCE (B) · 1h · flip W${FLIP.W}z${FLIP.zThr}fw${FLIP.fw}h${FLIP.hold} · ${DAYS}d · taker ${HL_TAKER}%${PLACEBO ? ` · PLACEBO=${PLACEBO}` : ''}\n`);
  type Pack = { c: Candle[]; hlF: (number | null)[]; oi: (number | null)[]; byF: (number | null)[]; flips: Flip[]; oiCov: number; fCov: number };
  const data = new Map<string, Pack>();
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    try {
      const c = await getKlines(sym, '60', NOW - DAYS * 86_400_000, NOW);
      const hlF = loadMicroAligned(coin, '60', c).funding;
      const by = loadBybitAligned(coin, '60', c);
      let oi = by.oi; let byF = by.funding;
      if (PLACEBO === 'oi') { const sh = Math.floor(oi.length / 2) + 137; oi = oi.map((_, i) => oi[(i + sh) % oi.length]!); }
      if (PLACEBO === 'byfund') { const sh = Math.floor(byF.length / 2) + 91; byF = byF.map((_, i) => byF[(i + sh) % byF.length]!); }
      const flips = flipEvents(c, hlF);
      data.set(sym, { c, hlF, oi, byF, flips, oiCov: by.oiCov, fCov: by.fndCov });
      process.stderr.write(`  ${coin}: ${c.length} bars · oiCov ${Math.round(by.oiCov * 100)}% · byFndCov ${Math.round(by.fndCov * 100)}% · ${flips.length} flips\n`);
    } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); }
  }

  // ===== A0: STRATIFIED DIAGNOSTIC — does Bybit OI state separate good flips from bad? =====
  console.log('===== A0 · STRATIFIED DIAGNOSTIC (all flips, bucketed by Bybit-OI state) =====');
  console.log('  per coin: flip return split by OI-percentile tercile (L=720h) and dOI sign (k=6h). mean% (n).');
  const OI_PCT_L = 720, DOI_K = 6;
  for (const [sym, d] of data) {
    if (d.flips.length < 8) continue;
    const lo: number[] = [], mi: number[] = [], hi: number[] = [], rise: number[] = [], fall: number[] = [], all: number[] = [];
    for (const f of d.flips) {
      const ret = tradeRet(d.c, f); all.push(ret);
      const pr = pctRank(d.oi, f.i, OI_PCT_L);
      if (pr != null) { if (pr < 1 / 3) lo.push(ret); else if (pr < 2 / 3) mi.push(ret); else hi.push(ret); }
      const dc = relChange(d.oi, f.i, DOI_K);
      if (dc != null) { (dc >= 0 ? rise : fall).push(ret); }
    }
    const cell = (a: number[]) => a.length ? `${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3)}(${a.length})` : '—';
    console.log(`  ${sym.replace('USDT', '').padEnd(5)} all ${cell(all).padEnd(11)} | OI lo ${cell(lo).padEnd(11)} mid ${cell(mi).padEnd(11)} hi ${cell(hi).padEnd(11)} | dOI↑ ${cell(rise).padEnd(11)} dOI↓ ${cell(fall)}`);
  }
  console.log('');

  const rows: Row[] = [];

  // ===== A: OI-GATE variants on the flip =====
  for (const [sym, d] of data) {
    const coin = sym.replace('USDT', '');
    const baseR = d.flips.map((f) => tradeRet(d.c, f));
    if (baseR.length >= 12) rows.push(mkRow('A:flip-base', 'base', coin, baseR));
    // OI percentile gate (take flip only when OI percentile >= thr)
    for (const thr of [0.5, 0.6, 0.7, 0.8]) {
      const r = d.flips.filter((f) => { const pr = pctRank(d.oi, f.i, OI_PCT_L); return pr != null && pr >= thr; }).map((f) => tradeRet(d.c, f));
      if (r.length >= 12) rows.push(mkRow('A:oiPct≥', `p${thr}`, coin, r));
    }
    // OI z-score gate
    for (const zt of [0.5, 1, 1.5]) {
      const r = d.flips.filter((f) => { const { m, sd } = rollMeanStd(d.oi, f.i, OI_PCT_L); if (!(sd > 0)) return false; const z = (d.oi[f.i]! - m) / sd; return d.oi[f.i] != null && z >= zt; }).map((f) => tradeRet(d.c, f));
      if (r.length >= 12) rows.push(mkRow('A:oiZ≥', `z${zt}`, coin, r));
    }
    // dOI gate: OI building (rising) vs flushing (falling) into the flip
    for (const dir of ['rise', 'fall'] as const) {
      for (const k of [6, 12]) {
        const r = d.flips.filter((f) => { const dc = relChange(d.oi, f.i, k); return dc != null && (dir === 'rise' ? dc > 0 : dc < 0); }).map((f) => tradeRet(d.c, f));
        if (r.length >= 12) rows.push(mkRow(`A:dOI-${dir}`, `k${k}`, coin, r));
      }
    }
  }

  // ===== B: HL↔Bybit funding divergence =====
  for (const [sym, d] of data) {
    const coin = sym.replace('USDT', '');
    const n = d.c.length;
    // B1: cross-venue funding-z SPREAD blow-out → fade the more-extreme venue, hold time-stop
    for (const W of [180, 360]) for (const thr of [1.5, 2, 2.5]) {
      const r: number[] = []; let guard = -1;
      for (let i = Math.max(W, FLIP.W); i < n - 1; i++) {
        if (i <= guard) continue;
        const hl = rollMeanStd(d.hlF, i, W), by = rollMeanStd(d.byF, i, W);
        if (!(hl.sd > 0) || !(by.sd > 0) || d.hlF[i] == null || d.byF[i] == null) continue;
        const zHL = (d.hlF[i]! - hl.m) / hl.sd, zBy = (d.byF[i]! - by.m) / by.sd;
        const spread = zHL - zBy;
        if (Math.abs(spread) < thr) continue;
        const side: 1 | -1 = spread > 0 ? -1 : 1; // HL more-long(+) → fade short
        const entry = d.c[i]!.c, exit = d.c[Math.min(n - 1, i + FLIP.hold)]!.c;
        r.push((side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100 - HL_TAKER);
        guard = i + FLIP.hold;
      }
      if (r.length >= 12) rows.push(mkRow('B:divSpread', `W${W}t${thr}`, coin, r));
    }
    // B2: flip CONFIRM — verified flip AND Bybit funding also extreme on the wiped side (subset)
    // B3: flip DIVERGE — verified flip but Bybit funding NOT extreme (complement)
    for (const W of [360]) for (const zt of [1, 1.5]) {
      const confirm: number[] = [], diverge: number[] = [];
      for (const f of d.flips) {
        const by = rollMeanStd(d.byF, f.i, W); if (!(by.sd > 0) || d.byF[f.i] == null) { diverge.push(tradeRet(d.c, f)); continue; }
        const zBy = (d.byF[f.i]! - by.m) / by.sd;
        // wiped side: side=1 (long snapback) means LONG crowd capitulated → Bybit was also long-crowded ⇒ zBy high(+)
        const byExtremeOnWiped = f.side === 1 ? zBy >= zt : zBy <= -zt;
        (byExtremeOnWiped ? confirm : diverge).push(tradeRet(d.c, f));
      }
      if (confirm.length >= 12) rows.push(mkRow('B:flipConfirm', `W${W}z${zt}`, coin, confirm));
      if (diverge.length >= 12) rows.push(mkRow('B:flipDiverge', `W${W}z${zt}`, coin, diverge));
    }
  }

  writeFileSync('data/oi-funding-results.json', JSON.stringify(rows, null, 1));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.kind.padEnd(14)} ${r.cfg.padEnd(9)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +c ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)} f${r.folds} IS/OOS ${r.isN}/${r.oosN} | exp ${r.mean} K ${r.kelly} Sh ${r.sharpe}`;
  // group by kind, show base + any green, and the best non-green per kind for context
  const kinds = [...new Set(rows.map((r) => r.kind))];
  for (const k of kinds) {
    const fr = rows.filter((r) => r.kind === k);
    const greens = fr.filter((r) => r.green).sort((a, b) => b.net2 - a.net2);
    console.log(`===== ${k} — ${greens.length} green / ${fr.length} =====`);
    if (greens.length) console.log(greens.slice(0, 8).map(line).join('\n'));
    else console.log(fr.sort((a, b) => b.net2 - a.net2).slice(0, 3).map(line).join('\n'));
    console.log('');
  }
  // robust summary: any gate config green on >=2 coins
  const byCfg = new Map<string, string[]>();
  for (const r of rows.filter((x) => x.green && (x.kind.startsWith('A:oi') || x.kind.startsWith('A:dOI') || x.kind.startsWith('B:')))) { const key = `${r.kind} ${r.cfg}`; const a = byCfg.get(key) ?? []; a.push(r.coin); byCfg.set(key, a); }
  const robust = [...byCfg.entries()].filter(([, c]) => c.length >= 2).sort((a, b) => b[1].length - a[1].length);
  console.log('===== CONDITIONED configs green on >=2 coins =====');
  console.log(robust.length ? robust.map(([k, c]) => `  ◆ ${k} -> ${c.length} {${c.sort().join(',')}}`).join('\n') : '  — none —');
  console.log('\nFull -> data/oi-funding-results.json');
})().catch((e) => { console.error(e); process.exit(1); });

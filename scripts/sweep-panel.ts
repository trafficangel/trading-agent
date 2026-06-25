/**
 * PANEL (cross-sectional, dollar-neutral) sweep — the "new alpha" probes the edge-source
 * ideation surfaced. Two market-neutral strategies on the 10-coin basket, where panel-wide
 * beta (the thing that sinks every directional bet) cancels:
 *   (A) XS PRICE REVERSAL — rank coins by trailing-L return; LONG the bottom-k (laggards),
 *       SHORT the top-k (leaders); hold H; non-overlapping rebalance. Harvests relative reversion.
 *   (B) LIQ-IMBALANCE XS — rank by signed liquidation pressure (liq_vol signed by bar-return:
 *       down-bar liq = forced selling); LONG the most-forced-sold, SHORT the most-forced-bought.
 *       Monetizes the ~10.5mo liq_vol column as a cross-sectional sort (NOT the killed single-symbol
 *       liqCascadeFade trigger — this is the dollar-neutral spread wrapper, the only novel part).
 *
 * It's ONE portfolio, so robustness = sub-period folds + IS/OOS + cost-stress x2/x3 + a config
 * PLATEAU (not a lone spike). Cost = full RT on BOTH legs per rebalance (HL taker 0.07% => 0.14%/turn).
 * Causal: rank uses returns/liq up to bar t; the basket earns the FORWARD H-bar return. Run on the VPS.
 * pnpm tsx scripts/sweep-panel.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 320);
const TF = '240'; // 4h bars
const FEE_RT = 0.07; // HL taker round-trip %

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], perTurn: number) { return Math.round(r.reduce((s, x) => s + x - perTurn, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function sharpe(r: number[]) { if (r.length < 2) return 0; const m = mean(r); const sd = Math.sqrt(mean(r.map((x) => (x - m) ** 2))); return sd > 0 ? Math.round((m / sd) * 100) / 100 : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Aligned = { ts: number[]; close: number[][]; liq: number[][] }; // [t][coin]

async function buildPanel(): Promise<Aligned> {
  const maps: Map<number, { c: number; liq: number }>[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const candles: Candle[] = await getKlines(sym, TF, NOW - DAYS * 86_400_000, NOW);
    const m = loadMicroAligned(coin, TF, candles);
    const mp = new Map<number, { c: number; liq: number }>();
    for (let i = 0; i < candles.length; i++) mp.set(candles[i]!.t, { c: candles[i]!.c, liq: m.liq[i] ?? 0 });
    maps.push(mp);
  }
  // spine = timestamps present in ALL coins
  const spine = [...maps[0]!.keys()].filter((ts) => maps.every((mp) => mp.has(ts))).sort((a, b) => a - b);
  const close: number[][] = []; const liq: number[][] = [];
  for (const ts of spine) { close.push(maps.map((mp) => mp.get(ts)!.c)); liq.push(maps.map((mp) => mp.get(ts)!.liq)); }
  return { ts: spine, close, liq };
}

/** XS price reversal: long bottom-k trailing-return, short top-k. Returns per-rebalance net %. */
function runReversal(P: Aligned, L: number, H: number, k: number): number[] {
  const N = P.ts.length; const out: number[] = [];
  for (let t = L; t + H < N; t += H) {
    const trail = P.close[t]!.map((c, i) => c / P.close[t - L]![i]! - 1);
    const order = [...trail.keys()].sort((a, b) => trail[a]! - trail[b]!);
    const longIdx = order.slice(0, k); const shortIdx = order.slice(order.length - k);
    const fwd = (i: number) => P.close[t + H]![i]! / P.close[t]![i]! - 1;
    const gross = (mean(longIdx.map(fwd)) - mean(shortIdx.map(fwd))) * 100;
    out.push(gross - 2 * FEE_RT);
  }
  return out;
}

/** LIQ-imbalance XS: signed-liq (by bar return) over window W, normalized by trailing-median liq;
 *  long the most-forced-sold (most negative), short the most-forced-bought. */
function runLiqXS(P: Aligned, W: number, H: number, k: number, normLook: number): number[] {
  const N = P.ts.length; const nc = SYMBOLS.length; const out: number[] = [];
  // signed liq per bar per coin
  const signed: number[][] = P.liq.map((row, t) => row.map((lq, i) => (t > 0 ? lq * (P.close[t]![i]! < P.close[t - 1]![i]! ? -1 : 1) : 0)));
  const start = Math.max(W, normLook);
  for (let t = start; t + H < N; t += H) {
    const score = new Array<number>(nc).fill(0); let valid = true;
    for (let i = 0; i < nc; i++) {
      let s = 0; for (let j = t - W + 1; j <= t; j++) s += signed[j]![i]!;
      // trailing median of |liq| over normLook for scale
      const win: number[] = []; for (let j = t - normLook + 1; j <= t; j++) win.push(Math.abs(P.liq[j]![i]!));
      win.sort((a, b) => a - b); const med = win[Math.floor(win.length / 2)] || 0;
      score[i] = med > 0 ? s / (med * W) : 0; // normalized signed pressure
    }
    if (!valid) continue;
    const order = [...score.keys()].sort((a, b) => score[a]! - score[b]!);
    const longIdx = order.slice(0, k); const shortIdx = order.slice(order.length - k); // most-sold long, most-bought short
    const fwd = (i: number) => P.close[t + H]![i]! / P.close[t]![i]! - 1;
    const gross = (mean(longIdx.map(fwd)) - mean(shortIdx.map(fwd))) * 100;
    out.push(gross - 2 * FEE_RT);
  }
  return out;
}

type Row = { strat: string; sig: string; n: number; net: number; net2: number; net3: number; pf: number; wr: number; sharpe: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };
function evalSeries(strat: string, sig: string, r: number[]): Row | null {
  if (r.length < 16) return null;
  const cut = Math.floor(r.length * 0.7);
  const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
  const n1 = net(r), n2 = netStress(r, 2 * FEE_RT), n3 = netStress(r, 4 * FEE_RT);
  const green = r.length >= 20 && n1 > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && n2 > 0 && f >= 3;
  return { strat, sig, n: r.length, net: n1, net2: n2, net3: n3, pf: pf(r), wr: wr(r), sharpe: sharpe(r), dd: dd(r), isN, oosN, folds: f, green };
}

(async () => {
  console.log(`PANEL cross-sectional sweep · ${SYMBOLS.length} coins · 4h · ${DAYS}d · dollar-neutral · cost ${2 * FEE_RT}%/rebalance (x2/x3 stress)\n`);
  const P = await buildPanel();
  console.log(`aligned spine: ${P.ts.length} 4h-bars (${(P.ts.length / 6).toFixed(0)}d common to all 10 coins)`);
  const liqCov = P.liq.filter((row) => row.some((x) => x > 0)).length / P.ts.length;
  console.log(`liq coverage on spine: ${(liqCov * 100).toFixed(0)}%\n`);

  const rows: Row[] = [];
  // (A) XS price reversal
  for (const L of [18, 30, 42]) for (const H of [18, 30, 42]) for (const k of [2, 3]) {
    const row = evalSeries('reversal', `L${L}H${H}k${k}`, runReversal(P, L, H, k)); if (row) rows.push(row);
  }
  // (B) liq-imbalance XS
  for (const W of [6, 12, 18]) for (const H of [18, 30]) for (const k of [2, 3]) {
    const row = evalSeries('liqXS', `W${W}H${H}k${k}`, runLiqXS(P, W, H, k, 60)); if (row) rows.push(row);
  }
  writeFileSync('data/panel-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.sig.padEnd(12)} N${String(r.n).padStart(3)} net ${String(r.net).padStart(6)} x2 ${String(r.net2).padStart(6)} x3 ${String(r.net3).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% Sh ${String(r.sharpe).padStart(5)} DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  for (const strat of ['reversal', 'liqXS']) {
    const fr = rows.filter((r) => r.strat === strat).sort((a, b) => b.net2 - a.net2);
    const greens = fr.filter((r) => r.green).length;
    console.log(`===== ${strat.toUpperCase()} — ${greens}/${fr.length} configs green (incl. x2 cost) =====`);
    console.log(fr.map(line).join('\n') || '  — none —');
    console.log('');
  }
  console.log('VERDICT: a real panel edge = a PLATEAU of green configs (not 1 spike) surviving x2 cost + folds + IS/OOS.');
  console.log('If green: next gate = collinearity vs the slow MR book + per-coin leg dropout. Full → data/panel-results.json');
})().catch((e) => { console.error(e); process.exit(1); });

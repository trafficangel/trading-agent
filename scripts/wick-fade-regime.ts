/**
 * WICK-FADE REGIME SPLIT — Simons-style regime conditioning as a GATE candidate for the live wick-fade.
 * Question: does deep-fade PnL depend on the REGIME at the decision bar — (a) trend ALIGNMENT of the
 * dislocation (counter-trend dip/spike vs with-trend continuation) and (b) volatility tercile? This is the
 * cheap honest PRECURSOR to a full HMM: both encode the same information (vol/trend state); if a simple
 * split shows nothing real, an HMM re-encoding won't rescue it. Context is computed at the DECISION bar
 * (known at quote time — no look-ahead). MAJORS run as CONTROLS (a "favorable bucket" that lights them up
 * = artifact, per the controls-catch-artifacts lesson). Descriptive first pass: per-bucket net + CATASTROPHE
 * rate + t-stat of counter-vs-with; the full gate battery (K100 null, cost ladder) runs only on a real,
 * controls-clean effect. Live-relevant hypothesis: catastrophes (GOAT) cluster in the WITH-trend bucket.
 * Bybit data (RUN ON VPS; cached from prior scans → fast). X=0.03 fixed (live config).
 *   pnpm tsx scripts/wick-fade-regime.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const ALTS = ['DOGE', 'ICP', 'NEAR', 'ATOM', 'TON', 'CRV', 'ENA', 'TIA', '1000PEPE', 'RENDER', 'POPCAT', 'JUP', 'AR', 'BLUR', 'LTC', 'GOAT', 'EIGEN', 'MANTA'];
const MAJORS = ['BTC', 'ETH', 'SOL', 'LINK']; // controls — must stay dead in any "favorable" bucket
const TF = String(process.argv[2] ?? '5');
const X = 0.03, WIN_DAYS = 180, WINDOWS = [0, 180, 360];
const Hfill = 6, exitH = 12, STOP = 0.03;
const VOL_W = 96, RANK_W = 1440, RANK_STEP = 5, SMA_W = 288, TREND_BAND = 0.005;

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

type Align = 'counter' | 'flat' | 'with';
type Trade = { g: number; cat: boolean; vol: 0 | 1 | 2; align: Align };

function contextSeries(c: Candle[]): { vol: number[]; sma: number[] } {
  const n = c.length;
  const ret = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) ret[i] = Math.log(c[i]!.c / c[i - 1]!.c);
  const vol = new Array<number>(n).fill(NaN);
  let s = 0, ss = 0;
  for (let i = 1; i < n; i++) {
    s += ret[i]!; ss += ret[i]! * ret[i]!;
    if (i > VOL_W) { s -= ret[i - VOL_W]!; ss -= ret[i - VOL_W]! * ret[i - VOL_W]!; }
    if (i >= VOL_W) { const m = s / VOL_W; vol[i] = Math.sqrt(Math.max(0, ss / VOL_W - m * m)); }
  }
  const sma = new Array<number>(n).fill(NaN);
  let s2 = 0;
  for (let i = 0; i < n; i++) { s2 += c[i]!.c; if (i >= SMA_W) s2 -= c[i - SMA_W]!.c; if (i >= SMA_W - 1) sma[i] = s2 / SMA_W; }
  return { vol, sma };
}

function volTercile(vol: number[], i: number): 0 | 1 | 2 | null {
  if (i < VOL_W + RANK_W) return null;
  let cnt = 0, tot = 0;
  for (let j = i - RANK_STEP; j >= i - RANK_W; j -= RANK_STEP) { const v = vol[j]; if (!Number.isFinite(v)) continue; tot++; if (v! < vol[i]!) cnt++; }
  if (tot < 100) return null;
  const r = cnt / tot;
  return r < 1 / 3 ? 0 : r < 2 / 3 ? 1 : 2;
}

function simulate(c: Candle[]): Trade[] {
  const n = c.length; const out: Trade[] = []; let guard = -1;
  const { vol, sma } = contextSeries(c);
  for (let i = VOL_W + RANK_W; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    const sm = sma[i]; if (!Number.isFinite(sm)) continue;
    const trend = mid > sm! * (1 + TREND_BAND) ? 1 : mid < sm! * (1 - TREND_BAND) ? -1 : 0;
    const vt = volTercile(vol, i); if (vt == null) continue;
    for (const side of [1, -1] as const) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1; for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      // alignment of the DISLOCATION vs the prevailing trend: long fill = flush DOWN (trend up → counter-trend
      // dip; trend down → with-trend knife). short fill = spike UP (trend up → with-trend momo; down → counter).
      const align: Align = trend === 0 ? 'flat' : side === 1 ? (trend === 1 ? 'counter' : 'with') : (trend === 1 ? 'with' : 'counter');
      const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
      let exit = c[Math.min(n - 1, fb + exitH)]!.c; let cat = false;
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; cat = true; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; break; }
      }
      out.push({ g: (side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100, cat, vol: vt, align });
      guard = fb + 1;
    }
  }
  return out;
}

function bucketRow(label: string, tr: Trade[]): void {
  if (tr.length < 15) { console.log(`${label.padEnd(16)} n=${tr.length} — too few`); return; }
  const g = tr.map((t) => t.g);
  const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
  const catPct = Math.round(tr.filter((t) => t.cat).length / tr.length * 1000) / 10;
  console.log(`${label.padEnd(16)} ${String(tr.length).padStart(6)}  ${mean(g).toFixed(3).padStart(7)} ${String(net(0.10)).padStart(8)} ${String(net(0.15)).padStart(8)}  ${String(catPct).padStart(5)}%  ${String(kelly(g.map((x) => x - 0.10))).padStart(6)}`);
}

function tStat(a: number[], b: number[]): number {
  if (a.length < 10 || b.length < 10) return 0;
  const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
  return se > 0 ? (mean(a) - mean(b)) / se : 0;
}

async function collect(coins: string[]): Promise<Trade[]> {
  const all: Trade[] = [];
  for (const coin of coins) {
    let got = 0;
    for (const off of WINDOWS) {
      const end = Date.now() - off * 86_400_000;
      try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); if (c.length >= 3000) { const t = simulate(c); all.push(...t); got += t.length; } } catch { /* no data window */ }
    }
    process.stderr.write(`  ${coin}: ${got} trades\n`);
  }
  return all;
}

function report(name: string, tr: Trade[]): void {
  console.log(`\n=== ${name} · X=3% · pooled ${tr.length} trades ===`);
  console.log('bucket             n     avgG%   net@.10  net@.15   cat%   Kelly');
  for (const a of ['counter', 'flat', 'with'] as const) bucketRow(`align=${a}`, tr.filter((t) => t.align === a));
  for (const v of [0, 1, 2] as const) bucketRow(`vol=${['low', 'mid', 'high'][v]}`, tr.filter((t) => t.vol === v));
  bucketRow('counter+high', tr.filter((t) => t.align === 'counter' && t.vol === 2));
  bucketRow('with+high', tr.filter((t) => t.align === 'with' && t.vol === 2));
  const co = tr.filter((t) => t.align === 'counter').map((t) => t.g), wi = tr.filter((t) => t.align === 'with').map((t) => t.g);
  console.log(`counter-vs-with: Δavg=${(mean(co) - mean(wi)).toFixed(3)}%/trade, t=${tStat(co, wi).toFixed(2)}`);
}

(async () => {
  console.log(`WICK-FADE REGIME SPLIT · ${TF}m · X=3% · trend-align (SMA288 ±0.5%) × vol-tercile (96-bar vol vs 5d rank) · context at decision bar\n`);
  const alts = await collect(ALTS);
  const majors = await collect(MAJORS);
  report('ALTS (live set)', alts);
  report('MAJORS (controls — must stay dead)', majors);
  console.log('\nRead: a real regime gate needs |t|≥3 on alts AND the same bucket NOT lighting up majors. Then → full battery (K100 null, cost ladder) before touching the runner. Hypothesis: catastrophes cluster in align=with.');
})().catch((e) => { console.error(e); process.exit(1); });

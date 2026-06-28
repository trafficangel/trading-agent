/**
 * REGIME-CONDITIONED VPIN — the decisive fast-market dig. Raw VPIN-follow at 15m was REAL but is
 * DECAYING + direction-unstable (old window=follow, recent=mixed) → hypothesis: the DIRECTION depends
 * on REGIME. Gate toxicity by an efficiency-ratio (ER) trend/range regime:
 *   follow-trend: high VPIN + trending (ER>erThr) → ride the toxic flow (momentum)
 *   fade-range:   high VPIN + ranging (ER<erThr) → fade it (exhaustion → revert)
 *   follow-all:   baseline (the decaying raw follow), for comparison
 *
 * CORE FILTER = CROSS-WINDOW PERSISTENCE across 3 independent ~180d windows (kills multiple-testing
 * lottery winners — a real edge repeats, a fluke doesn't). Per window the recalibrated KEEP applies
 * (N≥30, net>0 @real 0.07% cost, perm-null p<0.05, Kelly>0). ROBUST = KEEP in ≥2/3 windows.
 * Causal (VPIN/ER from bars ≤ i, enter close[i]). Run on the VPS: pnpm tsx scripts/vpin-regime.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const TF = String(process.argv[2] ?? '15');
const WIN_DAYS = 180;
const WINDOWS = [0, 180, 360]; // END_OFFSETs → 3 independent ~180d windows
const K = 20;
const COST = 0.07, SIGMA_W = 50, PCT_L = 400;

function erf(x: number): number { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;
const sd = (r: number[]) => { if (r.length < 2) return 0; const m = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1)); };
const kelly = (r: number[]) => { const m = mean(r) / 100, s = sd(r) / 100; return s > 0 ? m / (s * s) : 0; };

function bvc(c: Candle[]): { imb: number[]; vol: number[] } {
  const n = c.length; const dP: number[] = Array(n).fill(0); for (let i = 1; i < n; i++) dP[i] = c[i]!.c - c[i - 1]!.c;
  const imb: number[] = Array(n).fill(0); const vol: number[] = Array(n).fill(0);
  for (let i = SIGMA_W + 1; i < n; i++) { let s = 0, ss = 0; for (let j = i - SIGMA_W; j < i; j++) { s += dP[j]!; ss += dP[j]! * dP[j]!; } const m = s / SIGMA_W; const sig = Math.sqrt(Math.max(1e-12, ss / SIGMA_W - m * m)); const z = sig > 0 ? dP[i]! / sig : 0; imb[i] = c[i]!.v * (2 * normCdf(z) - 1); vol[i] = c[i]!.v; }
  return { imb, vol };
}
function vpinNet(imb: number[], vol: number[], nb: number): { vpin: (number | null)[]; net: number[] } {
  const n = imb.length; const vpin: (number | null)[] = Array(n).fill(null); const net: number[] = Array(n).fill(0); let sAbs = 0, sVol = 0, sNet = 0;
  for (let i = 0; i < n; i++) { sAbs += Math.abs(imb[i]!); sVol += vol[i]!; sNet += imb[i]!; if (i >= nb) { sAbs -= Math.abs(imb[i - nb]!); sVol -= vol[i - nb]!; sNet -= imb[i - nb]!; } if (i >= nb && sVol > 0) { vpin[i] = sAbs / sVol; net[i] = sNet; } }
  return { vpin, net };
}
/** efficiency ratio over erWin at i (causal, bars ≤ i): |Δ net| / Σ|Δ| ∈ [0,1]. high = trending. */
function effRatio(c: Candle[], i: number, erWin: number): number | null {
  if (i < erWin) return null; let denom = 0; for (let j = i - erWin + 1; j <= i; j++) denom += Math.abs(c[j]!.c - c[j - 1]!.c);
  return denom > 0 ? Math.abs(c[i]!.c - c[i - erWin]!.c) / denom : null;
}
function pctRank(a: (number | null)[], i: number, L: number): number | null { const v = a[i]; if (v == null) return null; let cc = 0, t = 0; for (let j = Math.max(0, i - L + 1); j <= i; j++) { const x = a[j]; if (x != null) { t++; if (x <= v) cc++; } } return t < L / 2 ? null : cc / t; }

type Cfg = { nb: number; thrPct: number; erWin: number; erThr: number; hold: number; mode: 'follow-trend' | 'fade-range' | 'follow-all' };
const CFGS: Cfg[] = [];
for (const nb of [20, 50]) for (const erThr of [0.3, 0.5]) for (const hold of [6, 12]) for (const mode of ['follow-trend', 'fade-range', 'follow-all'] as const)
  CFGS.push({ nb, thrPct: 0.9, erWin: 30, erThr, hold, mode });

function run(c: Candle[], vpin: (number | null)[], net: number[], er: (number | null)[], cfg: Cfg, shift = 0): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  const vS = shift ? vpin.map((_, i) => vpin[((i + shift) % n + n) % n]!) : vpin;
  const nS = shift ? net.map((_, i) => net[((i + shift) % n + n) % n]!) : net;
  for (let i = PCT_L; i < n - 1; i++) {
    if (i <= guard) continue;
    const pr = pctRank(vS, i, PCT_L); if (pr == null || pr < cfg.thrPct) continue;
    const flow = nS[i]!; if (flow === 0) continue; const e = er[i]; if (e == null) continue;
    const base = flow > 0 ? 1 : -1;
    let side: 1 | -1 | 0 = 0;
    if (cfg.mode === 'follow-all') side = base as 1 | -1;
    else if (cfg.mode === 'follow-trend') side = e > cfg.erThr ? base as 1 | -1 : 0;
    else side = e < cfg.erThr ? -base as 1 | -1 : 0; // fade-range
    if (side === 0) continue;
    const px = c[i]!.c, x = c[Math.min(n - 1, i + cfg.hold)]!.c;
    out.push((side === 1 ? (x - px) / px : (px - x) / px) * 100 - COST);
    guard = i + cfg.hold;
  }
  return out;
}

(async () => {
  console.log(`REGIME-CONDITIONED VPIN · ${TF}m · 3×${WIN_DAYS}d windows · cross-window persistence filter · real cost ${COST}%\n`);
  type W = { net: number; n: number; nullP: number; keep: boolean };
  type Res = { coin: string; cfg: string; w: W[]; persist: number };
  const results: Res[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const wins: { c: Candle[]; imb: number[]; vol: number[]; er30: (number | null)[] }[] = [];
    for (const off of WINDOWS) {
      const end = Date.now() - off * 86_400_000;
      let c: Candle[]; try { c = await getKlines(sym, TF, end - WIN_DAYS * 86_400_000, end); } catch { c = []; }
      if (c.length < PCT_L + 200) { wins.push({ c: [], imb: [], vol: [], er30: [] }); continue; }
      const { imb, vol } = bvc(c); const er30 = c.map((_, i) => effRatio(c, i, 30)); wins.push({ c, imb, vol, er30 });
    }
    if (wins.some((w) => w.c.length === 0)) { process.stderr.write(`${coin}: a window too short — skip\n`); continue; }
    for (const cfg of CFGS) {
      const w: W[] = [];
      for (const win of wins) {
        const { vpin, net } = vpinNet(win.imb, win.vol, cfg.nb);
        const r = run(win.c, vpin, net, win.er30, cfg);
        if (r.length < 30) { w.push({ net: 0, n: r.length, nullP: 1, keep: false }); continue; }
        const realNet = mean(r) * r.length;
        let nullP = 1;
        if (realNet > 0 && kelly(r) > 0) { let ge = 0; for (let s = 0; s < K; s++) { const off = Math.floor((win.c.length * (s + 1)) / (K + 1)) + 41 * (s + 1); const rn = run(win.c, vpin, net, win.er30, cfg, off); ge += (mean(rn) * rn.length >= realNet) ? 1 : 0; } nullP = ge / K; }
        w.push({ net: Math.round(realNet * 10) / 10, n: r.length, nullP, keep: r.length >= 30 && realNet > 0 && nullP < 0.05 && kelly(r) > 0 });
      }
      const persist = w.filter((x) => x.keep).length;
      results.push({ coin, cfg: `${cfg.mode} nb${cfg.nb} er${cfg.erThr} h${cfg.hold}`, w, persist });
    }
    process.stderr.write(`  ${coin} done\n`);
  }
  results.sort((a, b) => b.persist - a.persist || (b.w.reduce((s, x) => s + x.net, 0) - a.w.reduce((s, x) => s + x.net, 0)));
  const robust = results.filter((r) => r.persist >= 2);
  console.log(`===== ROBUST: KEEP in ≥2/3 independent windows (the real-not-lottery filter) — ${robust.length} =====`);
  const fmt = (r: Res) => `${r.persist}/3  ${r.coin.padEnd(5)} ${r.cfg.padEnd(26)} W0[net ${String(r.w[0]!.net).padStart(6)} p${r.w[0]!.nullP.toFixed(2)}] W1[net ${String(r.w[1]!.net).padStart(6)} p${r.w[1]!.nullP.toFixed(2)}] W2[net ${String(r.w[2]!.net).padStart(6)} p${r.w[2]!.nullP.toFixed(2)}]`;
  console.log(robust.length ? robust.slice(0, 30).map(fmt).join('\n') : '  — none persist across windows —');
  // config persistence across coins: a (mode,cfg) robust on multiple coins = strongest
  const byCfg = new Map<string, number>();
  for (const r of robust) byCfg.set(r.cfg, (byCfg.get(r.cfg) ?? 0) + 1);
  const top = [...byCfg.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  console.log(`\n===== (mode,cfg) robust on ≥2 coins =====\n${top.length ? top.map(([k, n]) => `  ◆ ${k} -> ${n} coins`).join('\n') : '  — none —'}`);
  console.log(`\ncontext — top 6 by total net across windows (incl. persist<2):\n${results.slice(0, 6).map(fmt).join('\n')}`);
})().catch((e) => { console.error(e); process.exit(1); });

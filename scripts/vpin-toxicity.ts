/**
 * VPIN ORDER-FLOW TOXICITY (Bulk Volume Classification) — a NEW, science-backed fast-signal
 * construction (Easley/López de Prado/O'Hara), testable on OHLCV ALONE (no tick data): classify each
 * bar's buy/sell split from the standardized price change (BVC: buyFrac = Φ(ΔP/σ)), accumulate a
 * rolling toxicity VPIN = Σ|buy−sell| / Σvol. High VPIN = one-sided informed flow = impending move.
 * 2026 lit: VPIN predicted BTC jumps (+59bps/trade hist, Sharpe 0.88) but the alpha is DECAYING.
 *
 * RECALIBRATED KILL LENS (operator: "kills not too strict — don't cut everything"): the verdict is NO
 * LONGER a conjunction of arbitrary hard thresholds (×3 cost AND IS/OOS-both AND folds AND cross-sym),
 * which over-kills. Instead — closer to a Deflated-Sharpe / permutation test:
 *   KEEP  ⇐  N≥30  AND  net>0 at the REAL 0.07% cost  AND  permutation-null p<0.05 (real beats a
 *            K-shuffle null of the signal) AND Kelly>0. (No ×3 cost, no both-halves, no cross-symbol.)
 * A real-but-marginal single-coin edge that money-mgmt can size now SURVIVES; pure noise still dies.
 *
 * Causal: ΔP/σ from bars ≤ i, VPIN from bars ≤ i, enter close[i]. Run on the VPS:
 *   pnpm tsx scripts/vpin-toxicity.ts [tf] [days] [K]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const TF = String(process.argv[2] ?? '5');
const DAYS = Number(process.argv[3] ?? 365);
const K = Number(process.argv[4] ?? 40);
const END_OFFSET = Number(process.argv[5] ?? 0); // days-ago to END the window — isolate an independent OOS regime
const NOW = Date.now() - END_OFFSET * 86_400_000;
const COST = 0.07; // real HL taker RT (NOT stressed — the recalibrated lens uses real cost)
const SIGMA_W = 50;

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;
const sd = (r: number[]) => { if (r.length < 2) return 0; const m = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1)); };

/** per-bar signed imbalance (buy−sell) and total vol via BVC, causal (σ from prior bars). */
function bvc(c: Candle[]): { imb: number[]; vol: number[] } {
  const n = c.length; const dP: number[] = Array(n).fill(0);
  for (let i = 1; i < n; i++) dP[i] = c[i]!.c - c[i - 1]!.c;
  const imb: number[] = Array(n).fill(0); const vol: number[] = Array(n).fill(0);
  for (let i = SIGMA_W + 1; i < n; i++) {
    let s = 0, ss = 0; for (let j = i - SIGMA_W; j < i; j++) { s += dP[j]!; ss += dP[j]! * dP[j]!; } // [i-W, i-1] strictly prior
    const m = s / SIGMA_W; const sig = Math.sqrt(Math.max(1e-12, ss / SIGMA_W - m * m));
    const z = sig > 0 ? dP[i]! / sig : 0;
    const bf = normCdf(z); const v = c[i]!.v;
    imb[i] = v * (2 * bf - 1); vol[i] = v; // signed: + = buy-dominant
  }
  return { imb, vol };
}
/** rolling VPIN (toxicity, [0,1]) + net signed flow over the last `nb` bars, causal. */
function vpinSeries(imb: number[], vol: number[], nb: number): { vpin: (number | null)[]; net: number[] } {
  const n = imb.length; const vpin: (number | null)[] = Array(n).fill(null); const net: number[] = Array(n).fill(0);
  let sAbs = 0, sVol = 0, sNet = 0;
  for (let i = 0; i < n; i++) {
    sAbs += Math.abs(imb[i]!); sVol += vol[i]!; sNet += imb[i]!;
    if (i >= nb) { sAbs -= Math.abs(imb[i - nb]!); sVol -= vol[i - nb]!; sNet -= imb[i - nb]!; }
    if (i >= nb && sVol > 0) { vpin[i] = sAbs / sVol; net[i] = sNet; }
  }
  return { vpin, net };
}
/** causal rolling percentile rank of vpin[i] within the last L bars. */
function pctRank(a: (number | null)[], i: number, L: number): number | null {
  const v = a[i]; if (v == null) return null; let c = 0, t = 0;
  for (let j = Math.max(0, i - L + 1); j <= i; j++) { const x = a[j]; if (x != null) { t++; if (x <= v) c++; } }
  return t < L / 2 ? null : c / t;
}

type Cfg = { nb: number; thrPct: number; hold: number; dir: 'follow' | 'fade' };
const CFGS: Cfg[] = [];
for (const nb of [20, 50]) for (const thrPct of [0.8, 0.9]) for (const hold of [6, 12, 24]) for (const dir of ['follow', 'fade'] as const) CFGS.push({ nb, thrPct, hold, dir });

const PCT_L = 500;
/** returns trades (net%) for a config; `sigShift` circular-shifts the VPIN trigger for the null. */
function run(c: Candle[], vpin: (number | null)[], net: number[], cfg: Cfg, sigShift = 0): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  const vS = sigShift ? vpin.map((_, i) => vpin[((i + sigShift) % n + n) % n]!) : vpin;
  const nS = sigShift ? net.map((_, i) => net[((i + sigShift) % n + n) % n]!) : net;
  for (let i = PCT_L; i < n - 1; i++) {
    if (i <= guard) continue;
    const pr = pctRank(vS, i, PCT_L); if (pr == null || pr < cfg.thrPct) continue;
    const flow = nS[i]!; if (flow === 0) continue;
    const base = flow > 0 ? 1 : -1; const side = cfg.dir === 'follow' ? base : -base as 1 | -1;
    const e = c[i]!.c; const x = c[Math.min(n - 1, i + cfg.hold)]!.c;
    out.push((side === 1 ? (x - e) / e : (e - x) / e) * 100 - COST);
    guard = i + cfg.hold;
  }
  return out;
}
const pf = (r: number[]) => { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl ? Math.round(gp / gl * 100) / 100 : 99; };
const kelly = (r: number[]) => { const m = mean(r) / 100, s = sd(r) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

(async () => {
  console.log(`VPIN TOXICITY (BVC) · ${TF}m · ${DAYS}d · ${CFGS.length} cfgs · ${K}-shuffle null · REAL cost ${COST}% · recalibrated lens (perm-null + effect, no threshold-AND)\n`);
  type Row = { coin: string; cfg: string; n: number; net: number; exp: number; pf: number; kelly: number; nullP: number; keep: boolean };
  const rows: Row[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    let c: Candle[]; try { c = await getKlines(sym, TF, NOW - DAYS * 86_400_000, NOW); } catch (e) { process.stderr.write(`${coin}: ${(e as Error).message}\n`); continue; }
    if (c.length < PCT_L + 200) { process.stderr.write(`${coin}: too few bars (${c.length})\n`); continue; }
    const { imb, vol } = bvc(c);
    for (const cfg of CFGS) {
      const { vpin, net } = vpinSeries(imb, vol, cfg.nb);
      const r = run(c, vpin, net, cfg);
      if (r.length < 30) continue;
      const realNet = Math.round(mean(r) * r.length * 10) / 10;
      // permutation null: shuffle the VPIN/flow trigger K times → fraction with net >= real
      let ge = 0; for (let s = 0; s < K; s++) { const off = Math.floor((c.length * (s + 1)) / (K + 1)) + 37 * (s + 1); const rn = run(c, vpin, net, cfg, off); ge += (mean(rn) * rn.length >= mean(r) * r.length) ? 1 : 0; }
      const nullP = ge / K;
      const keep = r.length >= 30 && realNet > 0 && nullP < 0.05 && kelly(r) > 0;
      rows.push({ coin, cfg: `${cfg.dir} nb${cfg.nb} p${cfg.thrPct} h${cfg.hold}`, n: r.length, net: realNet, exp: Math.round(mean(r) * 1000) / 1000, pf: pf(r), kelly: kelly(r), nullP, keep });
    }
    process.stderr.write(`  ${coin}: ${c.length} bars done\n`);
  }
  rows.sort((a, b) => b.net - a.net);
  const keeps = rows.filter((r) => r.keep);
  console.log(`===== KEEP (recalibrated: N≥30, net>0 @real cost, perm-null p<0.05, Kelly>0) — ${keeps.length} / ${rows.length} =====`);
  const line = (r: Row) => `${r.keep ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.cfg.padEnd(26)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(7)} exp ${String(r.exp).padStart(6)} PF ${String(r.pf).padStart(5)} K ${String(r.kelly).padStart(6)} nullP ${r.nullP.toFixed(2)}`;
  console.log((keeps.length ? keeps : rows.slice(0, 10)).slice(0, 25).map(line).join('\n'));
  // robustness: any config that KEEPs on >=2 coins
  const byCfg = new Map<string, string[]>();
  for (const r of keeps) { const a = byCfg.get(r.cfg) ?? []; a.push(r.coin); byCfg.set(r.cfg, a); }
  const robust = [...byCfg.entries()].filter(([, c]) => c.length >= 2).sort((a, b) => b[1].length - a[1].length);
  console.log(`\n===== KEEP on >=2 coins (one config) =====\n${robust.length ? robust.map(([k, c]) => `  ◆ ${k} -> ${c.length} {${c.sort().join(',')}}`).join('\n') : '  — none —'}`);
  console.log(`\nTop by net (incl. non-keep, for context):\n${rows.slice(0, 6).map(line).join('\n')}`);
})().catch((e) => { console.error(e); process.exit(1); });

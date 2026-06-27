/**
 * RIGOROUS NULL TEST for the OI-gated funding-flip (angle A) — does Bybit OI carry
 * GENUINE information about which flips snap back, or are the green gates just
 * sub-sampling artifacts of an already-positive base flip?
 *
 * Method: the base flip is fixed (validated W360 z2 fw6 h24). A gate keeps a
 * subset of flip trades using a Bybit-OI criterion. We pool the GATED trades
 * across all 10 coins and take the pooled mean net%. Under the NULL (Bybit OI
 * carries no info) the gate is a random subset → its pooled mean ≈ the ungated
 * base pooled mean. We build that null EMPIRICALLY by circular-shifting each
 * coin's OI series K times (random offsets) and recomputing. If the REAL pooled
 * gated mean is NOT in the upper tail of the null, OI adds nothing real.
 *
 * Two of the workflow's most-motivated gates are tested:
 *   - dOI-rise (k): OI built up into the flip (fresh leverage piling on).
 *   - flushConfirm (fw, drop): OI abnormally CONTRACTED across the flip window
 *     (proof the trapped side actually got liquidated).
 *
 * Run on the VPS (reads klines + hl_micro + bybit_micro):
 *   pnpm tsx scripts/oi-gate-nulltest.ts [days] [K]
 */
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned, loadBybitAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const DAYS = Number(process.argv[2] ?? 395);
const K = Number(process.argv[3] ?? 60); // null shuffles
const NOW = Date.now();
const HL_TAKER = 0.07;
const FLIP = { W: 360, zThr: 2, fw: 6, hold: 24 };

function rollMeanStd(a: (number | null)[], i: number, W: number): { m: number; sd: number } {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}
const relChange = (a: (number | null)[], i: number, k: number) => { const v = a[i], p = a[i - k]; return v == null || p == null || p === 0 ? null : (v - p) / Math.abs(p); };
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;

type Flip = { i: number; side: 1 | -1 };
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
const ret = (c: Candle[], f: Flip) => { const n = c.length, e = c[f.i]!.c, x = c[Math.min(n - 1, f.i + FLIP.hold)]!.c; return (f.side === 1 ? (x - e) / e : (e - x) / e) * 100 - HL_TAKER; };

type GatedFn = (oi: (number | null)[], f: Flip) => boolean;
const GATES: { name: string; fn: GatedFn }[] = [
  { name: 'dOI-rise k12', fn: (oi, f) => { const d = relChange(oi, f.i, 12); return d != null && d > 0; } },
  { name: 'dOI-rise k6', fn: (oi, f) => { const d = relChange(oi, f.i, 6); return d != null && d > 0; } },
  { name: 'flushConfirm fw6 d2%', fn: (oi, f) => { const d = relChange(oi, f.i, FLIP.fw); return d != null && d <= -0.02; } },
  { name: 'flushConfirm fw6 d4%', fn: (oi, f) => { const d = relChange(oi, f.i, FLIP.fw); return d != null && d <= -0.04; } },
];

/** circular shift preserving null gaps */
function shift<T>(a: T[], off: number): T[] { const n = a.length; return a.map((_, i) => a[((i + off) % n + n) % n]!); }

(async () => {
  console.log(`OI-GATE NULL TEST · flip W${FLIP.W}z${FLIP.zThr}fw${FLIP.fw}h${FLIP.hold} · ${DAYS}d · ${K} shuffles · taker ${HL_TAKER}%\n`);
  type Pack = { c: Candle[]; oi: (number | null)[]; flips: Flip[]; base: number[] };
  const packs: Pack[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const c = await getKlines(sym, '60', NOW - DAYS * 86_400_000, NOW);
    const hlF = loadMicroAligned(coin, '60', c).funding;
    const oi = loadBybitAligned(coin, '60', c).oi;
    const flips = flipEvents(c, hlF);
    packs.push({ c, oi, flips, base: flips.map((f) => ret(c, f)) });
  }
  const allBase = packs.flatMap((p) => p.base);
  const basePooledMean = mean(allBase);
  console.log(`base flip: ${allBase.length} trades pooled · pooled mean net% = ${basePooledMean.toFixed(4)} (expectancy/trade)\n`);

  for (const g of GATES) {
    // REAL
    const realGated = packs.flatMap((p) => p.flips.filter((f) => g.fn(p.oi, f)).map((f) => ret(p.c, f)));
    const realMean = mean(realGated);
    const realImprove = realMean - basePooledMean;
    // NULL: K shuffles of each coin's OI (varied offsets, deterministic spread)
    const nullMeans: number[] = [];
    for (let s = 0; s < K; s++) {
      const gatedAll: number[] = [];
      for (let pi = 0; pi < packs.length; pi++) {
        const p = packs[pi]!;
        const off = Math.floor((p.oi.length * (s + 1)) / (K + 1)) + 37 * (s + 1) + 101 * pi; // varied, decorrelated per coin/shuffle
        const oiS = shift(p.oi, off);
        for (const f of p.flips) if (g.fn(oiS, f)) gatedAll.push(ret(p.c, f));
      }
      nullMeans.push(mean(gatedAll));
    }
    nullMeans.sort((a, b) => a - b);
    const nMean = mean(nullMeans);
    const nSd = Math.sqrt(mean(nullMeans.map((x) => (x - nMean) * (x - nMean))));
    const pctAbove = nullMeans.filter((x) => x >= realMean).length / K; // fraction of null >= real (small => real is in upper tail)
    const z = nSd > 0 ? (realMean - nMean) / nSd : 0;
    const verdict = pctAbove <= 0.05 && realImprove > 0 ? 'REAL EDGE (real in upper 5% tail)' : 'NO INFO (real sits inside the null — sub-sampling artifact)';
    console.log(`── ${g.name} ──`);
    console.log(`   real gated: N=${realGated.length}  mean=${realMean.toFixed(4)}  improve vs base=${realImprove >= 0 ? '+' : ''}${realImprove.toFixed(4)}`);
    console.log(`   null (${K} OI shuffles): mean=${nMean.toFixed(4)}  sd=${nSd.toFixed(4)}  [${nullMeans[0]!.toFixed(3)} .. ${nullMeans[K - 1]!.toFixed(3)}]`);
    console.log(`   real percentile in null: ${((1 - pctAbove) * 100).toFixed(0)}%  (z=${z.toFixed(2)})  →  ${verdict}\n`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

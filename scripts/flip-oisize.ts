/**
 * FUNDING-FLIP OI-SIZING (Kelly-tilt) analysis — harden lever #2. The OI-build-up gate is BINARY
 * (oiRoC>0 → take). Question: does flip expectancy rise MONOTONICALLY with OI-ROC magnitude, so a
 * CONTINUOUS size ∝ OI-ROC (a Kelly-tilt) beats both flat and the binary gate? And does the
 * advantage survive a null (shuffle OI-ROC → the tilt benefit must vanish)?
 *
 * Realistic: 24h overlap guard (one position per coin at a time, like the live runner). Pooled across
 * the 5 runner coins + per-coin. Returns are net of 0.07% HL taker RT. Run on the VPS:
 *   pnpm tsx scripts/flip-oisize.ts [days] [K]
 */
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned, loadBybitAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const RUNNER = ['ETH', 'ADA', 'XRP', 'AVAX', 'BTC']; // the deployed set
const DAYS = Number(process.argv[2] ?? 395);
const K = Number(process.argv[3] ?? 60);
const NOW = Date.now();
const HL_TAKER = 0.07;
const FLIP = { W: 360, zThr: 2, fw: 6, hold: 24 };
const OI_K = 12;

function rollMeanStd(a: (number | null)[], i: number, W: number) {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}
const relChange = (a: (number | null)[], i: number, k: number) => { const v = a[i], p = a[i - k]; return v == null || p == null || p === 0 ? null : (v - p) / Math.abs(p); };
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;
const sd = (r: number[]) => { if (r.length < 2) return 0; const m = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1)); };
const sharpe = (r: number[]) => { const s = sd(r); return s > 0 ? mean(r) / s : 0; };
function maxDD(r: number[]) { let eq = 0, peak = 0, dd = 0; for (const x of r) { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); } return Math.round(dd * 10) / 10; }

type Trade = { coin: string; ret: number; oiRoc: number; rank: number };
/** flips with the 24h overlap guard (no concurrent positions), each tagged with OI-ROC(OI_K). */
function tradesFor(coin: string, c: Candle[], hlF: (number | null)[], oi: (number | null)[]): Trade[] {
  const out: Trade[] = []; const n = c.length; let guard = -1;
  for (let i = FLIP.W; i < n - 1; i++) {
    if (i <= guard) continue;
    const { m, sd: s } = rollMeanStd(hlF, i, FLIP.W); if (!(s > 0)) continue;
    const prevWin = hlF.slice(Math.max(0, i - FLIP.fw - 1), i);
    const wasPos = prevWin.some((v) => v != null && (v - m) / s >= FLIP.zThr);
    const wasNeg = prevWin.some((v) => v != null && (v - m) / s <= -FLIP.zThr);
    const now = hlF[i], prev = hlF[i - 1]; if (now == null || prev == null) continue;
    let side: 1 | -1 | 0 = 0;
    if (wasPos && prev > 0 && now <= 0) side = 1; else if (wasNeg && prev < 0 && now >= 0) side = -1;
    if (side === 0) continue;
    const roc = relChange(oi, i, OI_K); if (roc == null) continue; // need OI to size
    const e = c[i]!.c, x = c[Math.min(n - 1, i + FLIP.hold)]!.c;
    out.push({ coin, ret: (side === 1 ? (x - e) / e : (e - x) / e) * 100 - HL_TAKER, oiRoc: roc, rank: 0 });
    guard = i + FLIP.hold;
  }
  return out;
}

// sizing schemes → per-trade SIZED return (size × ret)
const SCHEMES: { name: string; size: (t: Trade, med: number) => number }[] = [
  { name: 'flat (all flips)', size: () => 1 },
  { name: 'binary gate oiRoc>0', size: (t) => (t.oiRoc > 0 ? 1 : 0) },
  { name: 'linear tilt (clip 0..2)', size: (t) => Math.max(0, Math.min(2, 1 + t.oiRoc / Math.max(1e-9, 0.04))) }, // ~+4% OI ⇒ 2x, 0 ⇒ 1x, neg ⇒ <1..0
  { name: 'step tilt {0,1,2}', size: (t, med) => (t.oiRoc <= 0 ? 0 : t.oiRoc >= med ? 2 : 1) },
  { name: 'gated-linear (cut neg)', size: (t) => (t.oiRoc <= 0 ? 0 : Math.min(2.5, Math.max(0.5, 1 + t.oiRoc / 0.04))) },
  { name: 'gated rank-tilt (scalefree)', size: (t) => (t.oiRoc <= 0 ? 0 : 0.5 + 2 * t.rank) }, // scale-free: no fitted constant
];

(async () => {
  console.log(`FUNDING-FLIP OI-SIZING · 1h · flip W${FLIP.W}z${FLIP.zThr}fw${FLIP.fw}h${FLIP.hold} · OI-ROC ${OI_K}h · ${DAYS}d · ${RUNNER.join(',')}\n`);
  const all: Trade[] = []; const byCoin = new Map<string, Trade[]>();
  for (const coin of RUNNER) {
    const c = await getKlines(`${coin}USDT`, '60', NOW - DAYS * 86_400_000, NOW);
    const hlF = loadMicroAligned(coin, '60', c).funding;
    const oi = loadBybitAligned(coin, '60', c).oi;
    const t = tradesFor(coin, c, hlF, oi);
    // within-coin OI-ROC percentile rank (scale-free; for the rank-based tilt scheme)
    const order = [...t].sort((a, b) => a.oiRoc - b.oiRoc);
    order.forEach((tr, idx) => { tr.rank = t.length > 1 ? idx / (t.length - 1) : 0.5; });
    byCoin.set(coin, t); all.push(...t);
  }
  console.log(`pooled trades (OI-tagged, 24h-guarded): ${all.length}\n`);

  // ── MONOTONICITY: expectancy by OI-ROC quartile ──
  const sorted = [...all].sort((a, b) => a.oiRoc - b.oiRoc);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!.oiRoc;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const buckets: Trade[][] = [[], [], [], []];
  for (const t of all) { const b = t.oiRoc < cuts[0]! ? 0 : t.oiRoc < cuts[1]! ? 1 : t.oiRoc < cuts[2]! ? 2 : 3; buckets[b]!.push(t); }
  console.log('OI-ROC quartile → flip expectancy (monotone increasing ⇒ sizing justified):');
  buckets.forEach((b, i) => { const r = b.map((t) => t.ret); console.log(`  Q${i + 1} oiRoc[${i === 0 ? '-inf' : cuts[i - 1]!.toFixed(3)}..${i === 3 ? '+inf' : cuts[i]!.toFixed(3)}]  n=${String(b.length).padStart(3)}  exp=${mean(r).toFixed(3)}  PF=${(() => { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl ? (gp / gl).toFixed(2) : '∞'; })()}  WR=${Math.round(r.filter((x) => x > 0).length / Math.max(1, r.length) * 100)}%`); });
  console.log('');

  // ── SIZING SCHEMES: pooled risk-adjusted comparison ──
  const med = q(0.5) > 0 ? q(0.5) : 0.01;
  const flatRet = all.map((t) => t.ret);
  console.log('sizing scheme (per-trade sized return = size×ret, pooled):');
  console.log('  scheme                    Σnet   exp/tr  Sharpe  maxDD  (avgSize, nNonzero)');
  const realSharpe: Record<string, number> = {};
  for (const s of SCHEMES) {
    const sizes = all.map((t) => s.size(t, med));
    const sized = all.map((t, i) => sizes[i]! * t.ret);
    const nz = sizes.filter((x) => x > 0).length; const avg = mean(sizes);
    realSharpe[s.name] = sharpe(sized);
    console.log(`  ${s.name.padEnd(24)} ${String(Math.round(mean(sized) * all.length * 10) / 10).padStart(6)} ${mean(sized).toFixed(3).padStart(7)} ${sharpe(sized).toFixed(3).padStart(7)} ${String(maxDD(sized)).padStart(6)}  (${avg.toFixed(2)}, ${nz})`);
  }
  void flatRet;
  console.log('');

  // ── NULL: shuffle OI-ROC within each coin → tilt's Sharpe edge over flat must vanish ──
  console.log(`NULL (${K} OI-ROC shuffles within coin) — Sharpe advantage of each tilt over flat:`);
  const flatShValue = sharpe(all.map((t) => t.ret));
  for (const s of SCHEMES) {
    if (s.name.startsWith('flat')) continue;
    const realAdv = realSharpe[s.name]! - flatShValue;
    const nullAdv: number[] = [];
    for (let sh = 0; sh < K; sh++) {
      // shuffle oiRoc labels within each coin (varied offset), recompute
      const shuffled: Trade[] = [];
      for (const [coin, ts] of byCoin) { const off = (sh * 7 + 13) % Math.max(1, ts.length); ts.forEach((t, i) => { const src = ts[(i + off) % ts.length]!; shuffled.push({ coin, ret: t.ret, oiRoc: src.oiRoc, rank: src.rank }); }); } // rotate the (oiRoc,rank) conditioning pair away from ret
      const sized = shuffled.map((t) => s.size(t, med) * t.ret);
      nullAdv.push(sharpe(sized) - flatShValue);
    }
    nullAdv.sort((a, b) => a - b);
    const pAbove = nullAdv.filter((x) => x >= realAdv).length / K;
    console.log(`  ${s.name.padEnd(24)} realAdv=${realAdv >= 0 ? '+' : ''}${realAdv.toFixed(3)}  null[${nullAdv[0]!.toFixed(3)}..${nullAdv[K - 1]!.toFixed(3)}]  pct=${((1 - pAbove) * 100).toFixed(0)}%  ${pAbove <= 0.05 && realAdv > 0 ? '→ REAL sizing edge' : '→ no sizing edge beyond the binary gate'}`);
  }
  console.log('');

  // ── per-coin expectancy (confidence tiers from cross-window: ETH/ADA core, XRP recent, AVAX/BTC gate-only) ──
  console.log('per-coin (gated oiRoc>0): n, exp, Sharpe — informs risk-tier sizing:');
  for (const coin of RUNNER) { const g = (byCoin.get(coin) ?? []).filter((t) => t.oiRoc > 0).map((t) => t.ret); console.log(`  ${coin.padEnd(5)} n=${String(g.length).padStart(3)}  exp=${mean(g).toFixed(3)}  Sharpe=${sharpe(g).toFixed(3)}  Σ=${Math.round(mean(g) * g.length * 10) / 10}`); }
})().catch((e) => { console.error(e); process.exit(1); });

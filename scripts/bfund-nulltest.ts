/**
 * RIGOROUS NULL TEST for angle B (HL↔Bybit funding divergence) — same 60-shuffle
 * empirical-null method as oi-gate-nulltest.ts, so A and B are judged consistently
 * (a single circular shift misled the OI read; multi-shuffle is the honest test).
 *
 * Two B signals:
 *   - flipDiverge (subset): the validated flip taken only where Bybit funding is
 *     NOT extreme (|zBy|<zt). Null = shuffle Bybit funding → if byF carries info,
 *     the real subset beats the null tail; else it's a sub-sampling artifact.
 *   - divSpread (standalone): fade sign(zHL - zBy) when the cross-venue funding-z
 *     spread blows out (|zHL-zBy|>=thr). Null = shuffle Bybit funding → if cross-
 *     venue divergence is real, the real pooled mean sits in the UPPER tail; if
 *     real sits at/below the null median, byF adds nothing (the edge, if any, is
 *     zHL/price structure, not divergence).
 *
 * Run on the VPS:  pnpm tsx scripts/bfund-nulltest.ts [days] [K]
 */
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned, loadBybitAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const DAYS = Number(process.argv[2] ?? 395);
const K = Number(process.argv[3] ?? 60);
const NOW = Date.now();
const HL_TAKER = 0.07;
const FLIP = { W: 360, zThr: 2, fw: 6, hold: 24 };

function rollMeanStd(a: (number | null)[], i: number, W: number): { m: number; sd: number } {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;
const sd = (r: number[]) => { const m = mean(r); return Math.sqrt(mean(r.map((x) => (x - m) * (x - m)))); };
function shift<T>(a: T[], off: number): T[] { const n = a.length; return a.map((_, i) => a[((i + off) % n + n) % n]!); }

type Flip = { i: number; side: 1 | -1 };
function flipEvents(c: Candle[], hlF: (number | null)[]): Flip[] {
  const out: Flip[] = []; const n = c.length;
  for (let i = FLIP.W; i < n - 1; i++) {
    const { m, sd: s } = rollMeanStd(hlF, i, FLIP.W); if (!(s > 0)) continue;
    const prevWin = hlF.slice(Math.max(0, i - FLIP.fw - 1), i);
    const wasPos = prevWin.some((v) => v != null && (v - m) / s >= FLIP.zThr);
    const wasNeg = prevWin.some((v) => v != null && (v - m) / s <= -FLIP.zThr);
    const now = hlF[i], prev = hlF[i - 1]; if (now == null || prev == null) continue;
    if (wasPos && prev > 0 && now <= 0) out.push({ i, side: 1 });
    else if (wasNeg && prev < 0 && now >= 0) out.push({ i, side: -1 });
  }
  return out;
}
const ret = (c: Candle[], f: Flip) => { const n = c.length, e = c[f.i]!.c, x = c[Math.min(n - 1, f.i + FLIP.hold)]!.c; return (f.side === 1 ? (x - e) / e : (e - x) / e) * 100 - HL_TAKER; };

const DIV_W = 360, DIV_THR = 2, FD_ZT = 1.5;
/** divSpread trades for a given byF series (causal: zHL,zBy from <=i; enter close[i]). */
function divSpreadRets(c: Candle[], hlF: (number | null)[], byF: (number | null)[]): number[] {
  const r: number[] = []; const n = c.length; let guard = -1;
  for (let i = Math.max(DIV_W, FLIP.W); i < n - 1; i++) {
    if (i <= guard) continue;
    const hl = rollMeanStd(hlF, i, DIV_W), by = rollMeanStd(byF, i, DIV_W);
    if (!(hl.sd > 0) || !(by.sd > 0) || hlF[i] == null || byF[i] == null) continue;
    const spread = (hlF[i]! - hl.m) / hl.sd - (byF[i]! - by.m) / by.sd;
    if (Math.abs(spread) < DIV_THR) continue;
    const side: 1 | -1 = spread > 0 ? -1 : 1;
    const e = c[i]!.c, x = c[Math.min(n - 1, i + FLIP.hold)]!.c;
    r.push((side === 1 ? (x - e) / e : (e - x) / e) * 100 - HL_TAKER);
    guard = i + FLIP.hold;
  }
  return r;
}
/** flipDiverge subset: flips where Bybit funding NOT extreme (|zBy|<zt). */
function flipDivergeRets(c: Candle[], byF: (number | null)[], flips: Flip[]): number[] {
  const out: number[] = [];
  for (const f of flips) { const by = rollMeanStd(byF, f.i, DIV_W); if (!(by.sd > 0) || byF[f.i] == null) { out.push(ret(c, f)); continue; } const z = (byF[f.i]! - by.m) / by.sd; if (Math.abs(z) < FD_ZT) out.push(ret(c, f)); }
  return out;
}

(async () => {
  console.log(`B FUNDING-DIVERGENCE NULL TEST · ${DAYS}d · ${K} shuffles · taker ${HL_TAKER}%\n`);
  type Pack = { c: Candle[]; hlF: (number | null)[]; byF: (number | null)[]; flips: Flip[]; base: number[] };
  const packs: Pack[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const c = await getKlines(sym, '60', NOW - DAYS * 86_400_000, NOW);
    const hlF = loadMicroAligned(coin, '60', c).funding;
    const byF = loadBybitAligned(coin, '60', c).funding;
    const flips = flipEvents(c, hlF);
    packs.push({ c, hlF, byF, flips, base: flips.map((f) => ret(c, f)) });
  }
  const basePooled = mean(packs.flatMap((p) => p.base));
  console.log(`base flip pooled mean net% = ${basePooled.toFixed(4)}\n`);

  // ── flipDiverge (subset; compare to base; null shuffles byF) ──
  {
    const real = packs.flatMap((p) => flipDivergeRets(p.c, p.byF, p.flips));
    const realMean = mean(real);
    const nulls: number[] = [];
    for (let s = 0; s < K; s++) { const all: number[] = []; for (let pi = 0; pi < packs.length; pi++) { const p = packs[pi]!; const off = Math.floor((p.byF.length * (s + 1)) / (K + 1)) + 53 * (s + 1) + 89 * pi; all.push(...flipDivergeRets(p.c, shift(p.byF, off), p.flips)); } nulls.push(mean(all)); }
    nulls.sort((a, b) => a - b); const nm = mean(nulls), ns = sd(nulls); const pAbove = nulls.filter((x) => x >= realMean).length / K;
    console.log('── flipDiverge (flip where Bybit funding NOT extreme) ──');
    console.log(`   real: N=${real.length} mean=${realMean.toFixed(4)} improve vs base=${(realMean - basePooled >= 0 ? '+' : '') + (realMean - basePooled).toFixed(4)}`);
    console.log(`   null (${K} byF shuffles): mean=${nm.toFixed(4)} sd=${ns.toFixed(4)} [${nulls[0]!.toFixed(3)}..${nulls[K - 1]!.toFixed(3)}]`);
    console.log(`   real percentile in null: ${((1 - pAbove) * 100).toFixed(0)}% (z=${ns > 0 ? ((realMean - nm) / ns).toFixed(2) : '0'}) → ${pAbove <= 0.05 && realMean > basePooled ? 'REAL EDGE' : 'NO INFO (artifact)'}\n`);
  }
  // ── divSpread (standalone; null shuffles byF) ──
  {
    const real = packs.flatMap((p) => divSpreadRets(p.c, p.hlF, p.byF));
    const realMean = mean(real);
    const nulls: number[] = [];
    for (let s = 0; s < K; s++) { const all: number[] = []; for (let pi = 0; pi < packs.length; pi++) { const p = packs[pi]!; const off = Math.floor((p.byF.length * (s + 1)) / (K + 1)) + 53 * (s + 1) + 89 * pi; all.push(...divSpreadRets(p.c, p.hlF, shift(p.byF, off))); } nulls.push(mean(all)); }
    nulls.sort((a, b) => a - b); const nm = mean(nulls), ns = sd(nulls); const pAbove = nulls.filter((x) => x >= realMean).length / K;
    console.log(`── divSpread W${DIV_W} thr${DIV_THR} (fade cross-venue funding-z spread) ──`);
    console.log(`   real: N=${real.length} mean=${realMean.toFixed(4)}`);
    console.log(`   null (${K} byF shuffles): mean=${nm.toFixed(4)} sd=${ns.toFixed(4)} [${nulls[0]!.toFixed(3)}..${nulls[K - 1]!.toFixed(3)}]`);
    console.log(`   real percentile in null: ${((1 - pAbove) * 100).toFixed(0)}% (z=${ns > 0 ? ((realMean - nm) / ns).toFixed(2) : '0'}) → ${pAbove <= 0.05 ? 'REAL EDGE (upper tail)' : 'NO INFO (byF not load-bearing — edge, if any, is not cross-venue)'}\n`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

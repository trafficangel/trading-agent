/**
 * COMBINED-EQUITY PORTFOLIO SIM (edge-hunt rank-1) — the honest answer to
 * "how hard can I safely lever the edges I've ALREADY proven, and what does
 * that realistically make per month on a $1-3k account?"
 *
 * Builds the CORRELATED combined equity curve of the whole lab book (which
 * genuinely did not exist — lab.ts only does a static weighted average), sized
 * by allocatePortfolio (risk-parity 1/DD + 35% cluster cap), and sweeps applied
 * book leverage L. Deliverable: the SAFE LEVERAGE (largest L with combined DD
 * <= target on the full sample AND every walk-forward fold) + the realistic
 * monthly $ on $2-3k.
 *
 * HONEST CHOICES (pre-registered from the workflow vet):
 *  - Every strategy (incl. the maker book) is run through the STANDARD engine =
 *    close/TAKER fills, netted at HL TAKER 0.07% RT. This is the kill-test that
 *    neutralizes the optimistic maker-fill model that bled the 5m book live —
 *    the number here is CONSERVATIVE and trustworthy, not the maker headline.
 *  - 50%-live-decay-haircut variant (halve every trade) = the floor estimate.
 *  - Cluster-correlation merge check: if the 4h-MR and 1h-MR clusters correlate
 *    > 0.6 daily, they are ONE bet — reported so weights aren't fooled.
 *  - Walk-forward 4-fold: safe leverage must hold in the WORST fold.
 *
 * Trade PnL is realized on its exit day (standard trade-based equity, no intra-
 * trade marking). Daily compounding. Run on the VPS (klines geo-blocked locally).
 *   pnpm tsx scripts/portfolio-sim.ts [days]
 */
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { ALL_LAB_STRATEGIES, BT_MAXDD_PCT } from '../src/strategies/lab-registry.js';
import { allocatePortfolio } from '../src/lib/portfolio.js';

const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 540);
const FEE_RT = 0.07;          // HL taker RT % — conservative (maker-as-taker)
const TARGET_DD = 20;         // % combined max-DD ceiling for "safe leverage"
const DAY_MS = 86_400_000;

const clusterOf = (code: string): string =>
  /^M/i.test(code) ? 'mr-1h-maker' : (['L06', 'L07', 'L08', 'L09'].includes(code) ? 'trend' : 'mr-4h');

function maxDD(equity: number[]): number {
  let peak = equity[0] ?? 1, dd = 0;
  for (const e of equity) { if (e > peak) peak = e; const d = (peak - e) / peak; if (d > dd) dd = d; }
  return Math.round(dd * 1000) / 10; // %
}
function sharpe(daily: number[]): number {
  if (daily.length < 2) return 0;
  const m = daily.reduce((a, b) => a + b, 0) / daily.length;
  const v = daily.reduce((a, b) => a + (b - m) ** 2, 0) / (daily.length - 1);
  const sd = Math.sqrt(v);
  return sd === 0 ? 0 : Math.round((m / sd) * Math.sqrt(365) * 100) / 100;
}
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); if (n < 3) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; } ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i]! - ma, y = b[i]! - mb; num += x * y; da += x * x; db += y * y; }
  return da === 0 || db === 0 ? 0 : Math.round((num / Math.sqrt(da * db)) * 100) / 100;
}

(async () => {
  console.log(`Portfolio combined-equity sim (MARK-TO-MARKET) · ${ALL_LAB_STRATEGIES.length} lab strategies · ${DAYS}d · TAKER ${FEE_RT}% RT (conservative) · target DD ${TARGET_DD}%\n`);
  // Per strategy: daily MARK-TO-MARKET return series (includes UNREALIZED drawdown
  // of open positions — the realized-only model massively understated DD).
  type St = { code: string; cluster: string; n: number; dailyRet: Map<number, number> };
  const strats: St[] = [];
  let minDay = Infinity, maxDay = -Infinity;
  const klCache = new Map<string, Awaited<ReturnType<typeof getKlines>>>();
  for (const s of ALL_LAB_STRATEGIES) {
    const key = `${s.symbol}:${s.timeframe}`;
    let candles = klCache.get(key);
    if (!candles) { try { candles = await getKlines(s.symbol, s.timeframe, NOW - DAYS * DAY_MS, NOW); klCache.set(key, candles); } catch (e) { process.stderr.write(`${s.code} ${s.symbol}: ${(e as Error).message}\n`); continue; } }
    if (candles.length < 100) continue;
    const res = runBacktest(s, candles, { kind: 'static', pct: s.slPct });
    if (!res.tradesLog.length) continue;
    // daily close (last candle of each day), forward-filled across the strategy's span
    const dayClose = new Map<number, number>();
    for (const c of candles) dayClose.set(Math.floor(c.t / DAY_MS), c.c);
    const sMin = Math.floor(candles[0]!.t / DAY_MS), sMax = Math.floor(candles[candles.length - 1]!.t / DAY_MS);
    let last = candles[0]!.c; const closeOf: number[] = [];
    for (let d = sMin; d <= sMax; d++) { last = dayClose.get(d) ?? last; closeOf[d - sMin] = last; }
    // mark-to-market cumulative equity (%) per day: realized locked at exit + unrealized of the open trade
    const trades = res.tradesLog.map((t) => ({ eD: Math.floor(t.entryAt / DAY_MS), xD: Math.floor(t.exitAt / DAY_MS), ep: t.entryPrice, sgn: t.side === 'long' ? 1 : -1, net: t.realizedPct - FEE_RT }));
    const markEq: number[] = new Array(sMax - sMin + 1).fill(0);
    let cumReal = 0, ti = 0;
    for (let d = sMin; d <= sMax; d++) {
      while (ti < trades.length && trades[ti]!.xD === d) { cumReal += trades[ti]!.net; ti++; } // lock realized at exit
      const open = trades.find((t) => t.eD <= d && d < t.xD); // single-position strategies → at most one
      const unreal = open ? ((closeOf[d - sMin]! - open.ep) / open.ep) * open.sgn * 100 : 0;
      markEq[d - sMin] = cumReal + unreal;
    }
    const dailyRet = new Map<number, number>();
    for (let d = sMin + 1; d <= sMax; d++) dailyRet.set(d, (markEq[d - sMin]! - markEq[d - sMin - 1]!) / 100); // fraction
    if (sMin < minDay) minDay = sMin; if (sMax > maxDay) maxDay = sMax;
    strats.push({ code: s.code, cluster: clusterOf(s.code), n: res.tradesLog.length, dailyRet });
  }
  if (!strats.length || !isFinite(minDay)) { console.log('no trades — abort'); return; }

  // Risk-parity + cluster-cap weights (the lab's own allocator).
  const alloc = allocatePortfolio(strats.map((s) => ({ id: s.code, cluster: s.cluster, riskPct: BT_MAXDD_PCT[s.code] ?? 20 })), { clusterCap: 0.35 });
  const w = new Map(alloc.map((a) => [a.id, a.weight]));
  const days = maxDay - minDay + 1;

  // Per-day weighted book return (fraction, mark-to-market).
  const bookDaily: number[] = new Array(days).fill(0);
  for (const s of strats) { const wi = w.get(s.code) ?? 0; for (const [d, r] of s.dailyRet) bookDaily[d - minDay]! += wi * r; }
  // Per-cluster daily (equal-weight members) for the correlation check.
  const clusterDaily = new Map<string, number[]>();
  for (const cl of new Set(strats.map((s) => s.cluster))) {
    const members = strats.filter((s) => s.cluster === cl); const arr = new Array(days).fill(0);
    for (const s of members) for (const [d, r] of s.dailyRet) arr[d - minDay]! += r / members.length;
    clusterDaily.set(cl, arr);
  }

  const equityAt = (L: number, haircut = 1): number[] => {
    const eq = [1]; let e = 1;
    for (const r of bookDaily) { e *= 1 + L * r * haircut; eq.push(e); }
    return eq;
  };
  const monthly = (eq: number[]): number => Math.round(((eq[eq.length - 1]! ** (30 / days)) - 1) * 1000) / 10; // %/mo
  const foldWorst = (L: number): { ddMax: number; retMin: number } => {
    const k = Math.floor(bookDaily.length / 4); let ddMax = 0, retMin = Infinity;
    for (let f = 0; f < 4; f++) {
      const slc = bookDaily.slice(f * k, f === 3 ? bookDaily.length : (f + 1) * k);
      const eq = [1]; let e = 1; for (const r of slc) { e *= 1 + L * r; eq.push(e); }
      ddMax = Math.max(ddMax, maxDD(eq)); retMin = Math.min(retMin, Math.round((e - 1) * 1000) / 10);
    }
    return { ddMax, retMin };
  };

  // ── Cluster weights + correlation ──
  console.log('CLUSTERS (risk-parity 1/DD, 35% cap):');
  for (const cl of new Set(strats.map((s) => s.cluster))) {
    const members = strats.filter((s) => s.cluster === cl);
    const cw = members.reduce((a, s) => a + (w.get(s.code) ?? 0), 0);
    console.log(`  ${cl.padEnd(12)} ${(cw * 100).toFixed(0)}%  [${members.map((m) => `${m.code}:n${m.n}`).join(' ')}]`);
  }
  const c4 = clusterDaily.get('mr-4h'), cm = clusterDaily.get('mr-1h-maker');
  const clCorr = c4 && cm ? corr(c4, cm) : 0;
  console.log(`\nCLUSTER-CORR mr-4h vs mr-1h-maker: ${clCorr}  → ${clCorr > 0.6 ? '⚠ >0.6 = effectively ONE bet (diversification overstated)' : 'OK, genuinely diversifying'}`);

  // ── Leverage sweep ──
  console.log('\nLEVERAGE SWEEP (conservative taker-priced book):');
  console.log('  L     monthly%   maxDD%   Sharpe   worstFold(ret%/DD%)');
  let safeL = 0;
  for (const L of [1.0, 1.2, 1.5, 2.0, 2.5, 3.0]) {
    const eq = equityAt(L); const dd = maxDD(eq); const fold = foldWorst(L);
    const ok = dd <= TARGET_DD && fold.retMin > 0;
    if (ok) safeL = L;
    console.log(`  ${L.toFixed(1)}x  ${String(monthly(eq)).padStart(7)}   ${String(dd).padStart(6)}   ${String(sharpe(bookDaily.map((r) => L * r))).padStart(6)}   ${fold.retMin}/${fold.ddMax}${ok ? '  ✅safe' : ''}`);
  }

  // ── Safe leverage + $ on a small account ──
  const eqSafe = equityAt(safeL || 1.0); const moSafe = monthly(eqSafe);
  const eqHair = equityAt(safeL || 1.0, 0.5); const moHair = monthly(eqHair);
  console.log(`\n══ VERDICT ══`);
  console.log(`  SAFE LEVERAGE (combined DD ≤${TARGET_DD}% full + every fold): ${safeL ? safeL.toFixed(1) + 'x' : '<1.0x (book too volatile even unleveraged)'}`);
  console.log(`  At safe leverage — monthly: ${moSafe}%  → on $2000: $${Math.round(2000 * moSafe / 100)}/mo · on $3000: $${Math.round(3000 * moSafe / 100)}/mo`);
  console.log(`  With 50% live-decay HAIRCUT (the floor): ${moHair}%  → $2000: $${Math.round(2000 * moHair / 100)}/mo · $3000: $${Math.round(3000 * moHair / 100)}/mo`);
  console.log(`\n  (Conservative: ALL strategies priced as TAKER close-fills — the maker book's real edge could be better, but this number doesn't depend on the optimistic fill model that killed the 5m book. Backtest, not live-proven. Daily-TF legs (L07/L08) are thin at ${DAYS}d.)`);
})().catch((e) => { console.error(e); process.exit(1); });

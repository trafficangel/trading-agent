/**
 * WICK-FADE PORTFOLIO SIM — the whole 21-coin book simulated JOINTLY on a shared 5m timeline (all previous
 * sweeps were per-coin). Answers the VAULT questions: worst day, max drawdown, monthly PnL distribution,
 * concurrent-position pileup in correlated flushes — and validates the CORR-CAP (max concurrent positions;
 * when at cap, quotes are pulled → no new fills until below). Honest rules throughout (live config: per-coin
 * depths+ladder+disabled sides, hold 30m, stop 4% + 0.25% slip, same-bar stop-through, 30m post-cat cooldown,
 * one position per coin). Sizing = live: $13.3 notional per rung, PnL in $ on a $249 account (no compounding).
 * CAP sweep ∈ {∞, 8, 5, 3}. Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/wick-fade-portfolio.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

type Row = { coin: string; sym: string; x: number; sides: (1 | -1)[]; deep?: number };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', sym: 'DOGE', x: 0.025, sides: BOTH, deep: 0.035 }, { coin: 'ICP', sym: 'ICP', x: 0.035, sides: BOTH },
  { coin: 'NEAR', sym: 'NEAR', x: 0.025, sides: BOTH }, { coin: 'ATOM', sym: 'ATOM', x: 0.03, sides: LONG, deep: 0.035 },
  { coin: 'TON', sym: 'TON', x: 0.02, sides: BOTH }, { coin: 'CRV', sym: 'CRV', x: 0.03, sides: BOTH },
  { coin: 'ENA', sym: 'ENA', x: 0.025, sides: BOTH }, { coin: 'TIA', sym: 'TIA', x: 0.025, sides: BOTH },
  { coin: 'kPEPE', sym: '1000PEPE', x: 0.03, sides: BOTH }, { coin: 'RENDER', sym: 'RENDER', x: 0.03, sides: BOTH },
  { coin: 'POPCAT', sym: 'POPCAT', x: 0.025, sides: BOTH }, { coin: 'JUP', sym: 'JUP', x: 0.025, sides: BOTH },
  { coin: 'AR', sym: 'AR', x: 0.03, sides: BOTH }, { coin: 'BLUR', sym: 'BLUR', x: 0.025, sides: BOTH },
  { coin: 'LTC', sym: 'LTC', x: 0.03, sides: LONG }, { coin: 'EIGEN', sym: 'EIGEN', x: 0.03, sides: BOTH },
  { coin: 'MANTA', sym: 'MANTA', x: 0.03, sides: BOTH }, { coin: 'XRP', sym: 'XRP', x: 0.02, sides: BOTH },
  { coin: 'JTO', sym: 'JTO', x: 0.03, sides: BOTH }, { coin: 'ALT', sym: 'ALT', x: 0.03, sides: SHORT },
  { coin: 'PNUT', sym: 'PNUT', x: 0.03, sides: BOTH },
];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360];
const Hfill = 6, EXITH = 6, STOP = 0.04, SLIP = 0.0025, CD_BARS = 6;
const NOTIONAL = 13.3, EQUITY0 = 249, FEE_RT = 0.05; // % round-trip on notional
const CAPS = [Infinity, 8, 5, 3];
const ANCHOR = String(process.argv[3] ?? 'requote'); // 'bar' = prev-close anchor | 'requote' = trailing anchor, re-anchors on >1% drift (live-faithful; 5m granularity still OVERcounts vs the 1-min live requote)
const DRIFT = 0.01;
const STEP = Number(TF) * 60_000;

type Pos = { side: 1 | -1; entry: number; anchorMid: number; entryBar: number };
type CoinState = { pos: Pos | null; cdUntil: number; anchor: number };

function simPortfolio(candles: Map<string, Candle[]>, rows: Row[], cap: number): { daily: Map<number, number>; trades: number; maxConc: number; concSum: number; concN: number } {
  // align: per coin, map ts→index; iterate the union timeline
  const idx = new Map<string, Map<number, number>>();
  let t0 = Infinity, t1 = -Infinity;
  for (const [coin, c] of candles) {
    const m = new Map<number, number>();
    c.forEach((k, i) => m.set(k.t, i));
    idx.set(coin, m);
    if (c.length) { t0 = Math.min(t0, c[0]!.t); t1 = Math.max(t1, c[c.length - 1]!.t); }
  }
  const st = new Map<string, CoinState>();
  for (const r of rows) st.set(r.coin, { pos: null, cdUntil: -1, anchor: 0 });
  const daily = new Map<number, number>();
  const addPnl = (ts: number, usd: number) => { const d = Math.floor(ts / 86_400_000); daily.set(d, (daily.get(d) ?? 0) + usd); };
  let trades = 0, maxConc = 0, concSum = 0, concN = 0;

  for (let ts = t0; ts <= t1; ts += STEP) {
    let conc = 0;
    for (const r of rows) if (st.get(r.coin)!.pos) conc++;
    maxConc = Math.max(maxConc, conc); concSum += conc; concN++;
    for (const r of rows) {
      const s = st.get(r.coin)!;
      const c = candles.get(r.coin)!;
      const i = idx.get(r.coin)!.get(ts);
      if (i == null) continue;
      const bar = c[i]!;
      if (s.pos) {
        // manage exit (honest): stop (with slip) checked before target within the bar; time at EXITH bars
        const p = s.pos;
        const target = p.anchorMid; // full reversion (validated)
        const stopPx = p.side === 1 ? p.entry * (1 - STOP) : p.entry * (1 + STOP);
        const stopFill = p.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
        let exit: number | null = null; let cat = false;
        if (p.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) { exit = stopFill; cat = true; }
        else if (p.side === 1 ? bar.h >= target : bar.l <= target) { exit = target; }
        else if (i - p.entryBar >= EXITH) { exit = bar.c; }
        if (exit != null) {
          const gross = (p.side === 1 ? (exit - p.entry) / p.entry : (p.entry - exit) / p.entry) * 100;
          addPnl(ts, NOTIONAL * (gross - FEE_RT) / 100);
          trades++;
          s.pos = null;
          if (cat) s.cdUntil = ts + CD_BARS * STEP;
        }
        continue;
      }
      // flat: fills only if under the corr-cap and not cooling down
      if (conc >= cap) continue;
      if (ts < s.cdUntil) continue;
      if (i < 1) continue;
      let anchor: number;
      if (ANCHOR === 'bar') anchor = c[i - 1]!.c; // static prev-close anchor
      else { // 'requote': trailing anchor — follows price like the live runner (re-anchor on >1% drift or fresh after a close)
        if (s.anchor <= 0) s.anchor = c[i - 1]!.c;
        anchor = s.anchor;
      }
      let filled: { side: 1 | -1; entry: number } | null = null;
      for (const side of r.sides) {
        const depths = r.deep != null ? [r.x, r.deep] : [r.x];
        for (const d of depths) {
          const limit = side === 1 ? anchor * (1 - d) : anchor * (1 + d);
          if (side === 1 ? bar.l <= limit : bar.h >= limit) {
            if (!filled || (side === 1 ? limit > filled.entry : limit < filled.entry)) filled = { side, entry: limit }; // shallowest touched rung fills first
          }
        }
      }
      if (ANCHOR === 'requote' && (Math.abs(bar.c - anchor) / anchor > DRIFT)) s.anchor = bar.c; // re-quote follows the drift
      if (filled) {
        if (ANCHOR === 'requote') s.anchor = 0; // after this trade resolves, quotes re-place at a fresh anchor
        // same-bar stop-through (honest)
        const stopPx = filled.side === 1 ? filled.entry * (1 - STOP) : filled.entry * (1 + STOP);
        if (filled.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) {
          const stopFill = filled.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
          const gross = (filled.side === 1 ? (stopFill - filled.entry) / filled.entry : (filled.entry - stopFill) / filled.entry) * 100;
          addPnl(ts, NOTIONAL * (gross - FEE_RT) / 100);
          trades++;
          s.cdUntil = ts + CD_BARS * STEP;
        } else {
          s.pos = { side: filled.side, entry: filled.entry, anchorMid: anchor, entryBar: i };
          conc++;
        }
      }
    }
  }
  return { daily, trades, maxConc, concSum, concN };
}

function stats(daily: Map<number, number>): { net: number; maxDD: number; worstDay: number; bestDay: number; posDays: number; days: number; monthsNeg: number; months: number; worstMonth: number } {
  const days = [...daily.keys()].sort((a, b) => a - b);
  let eq = 0, peak = 0, maxDD = 0, worstDay = 0, bestDay = 0, posDays = 0;
  const monthly = new Map<number, number>();
  for (const d of days) {
    const v = daily.get(d)!;
    eq += v; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
    worstDay = Math.min(worstDay, v); bestDay = Math.max(bestDay, v);
    if (v > 0) posDays++;
    const m = Math.floor(d / 30);
    monthly.set(m, (monthly.get(m) ?? 0) + v);
  }
  const months = [...monthly.values()];
  return { net: eq, maxDD, worstDay, bestDay, posDays, days: days.length, monthsNeg: months.filter((x) => x < 0).length, months: months.length, worstMonth: months.length ? Math.min(...months) : 0 };
}

(async () => {
  console.log(`WICK-FADE PORTFOLIO SIM [anchor=${ANCHOR}] · ${TF}m · JOINT 21-coin book · live config (30m hold, 4% stop, cd30m, ladder) · $${NOTIONAL}/rung on $${EQUITY0}\n`);
  // load per window
  const perWin: Map<string, Candle[]>[] = [];
  for (const off of WINDOWS) {
    const end = Date.now() - off * 86_400_000;
    const m = new Map<string, Candle[]>();
    for (const r of LIVE) {
      try { const c = await getKlines(`${r.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); if (c.length >= 3000) m.set(r.coin, c); } catch { /* skip */ }
    }
    perWin.push(m);
    process.stderr.write(`  window -${off}d loaded (${m.size} coins)\n`);
  }
  console.log('cap    trades  NET$    /mo$   maxDD$ (%eq)   worstDay$  bestDay$  posDays%  negMonths  worstMo$  avgConc maxConc');
  for (const cap of CAPS) {
    let trades = 0, maxConc = 0, concSum = 0, concN = 0;
    const dailyAll = new Map<number, number>();
    for (const m of perWin) {
      const r = simPortfolio(m, LIVE.filter((x) => m.has(x.coin)), cap);
      trades += r.trades; maxConc = Math.max(maxConc, r.maxConc); concSum += r.concSum; concN += r.concN;
      for (const [d, v] of r.daily) dailyAll.set(d, (dailyAll.get(d) ?? 0) + v);
    }
    const s = stats(dailyAll);
    const mo = s.net / 18; // 3×180d = ~18 months
    console.log(`${(cap === Infinity ? '∞' : String(cap)).padStart(3)}  ${String(trades).padStart(7)}  ${s.net.toFixed(0).padStart(5)}  ${mo.toFixed(1).padStart(6)}  ${s.maxDD.toFixed(1).padStart(6)} (${(s.maxDD / EQUITY0 * 100).toFixed(1)}%)   ${s.worstDay.toFixed(2).padStart(8)}  ${s.bestDay.toFixed(2).padStart(8)}  ${(s.posDays / s.days * 100).toFixed(0).padStart(7)}%  ${String(s.monthsNeg).padStart(4)}/${s.months}   ${s.worstMonth.toFixed(1).padStart(8)}  ${(concSum / concN).toFixed(2).padStart(6)} ${String(maxConc).padStart(5)}`);
  }
  console.log('\nVault read: worstDay/maxDD are the depositor-facing numbers; the cap trades a little NET for smoothness — pick the knee.');
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * SL-MODE AUDIT — measure, don't guess, the stop. For each strategy, replay
 * the SAME signals under different stop modes (none / static-% / ATR-dynamic /
 * time-stop / combo) through the engine and compare net/PF/DD/WR with a 70/30
 * IS/OOS split. Picks the mode with the best robust (min of IS/OOS) net.
 *
 * Focus: the maker mean-reversion edges (Keltner/z-score @5m) where a tight
 * static 5% appears to be clipping reversions the no-SL backtest captured.
 * Maker fee (0.04% RT) for net. Run on the VPS. Usage: pnpm tsx scripts/sl-mode-audit.ts
 */

import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type SlMode } from '../src/backtest/engine.js';
import type { Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { bollMr } from '../src/backtest/strategies/families.js';

const COMM = 0.07; // HL taker round-trip (the 4h MR market book)
const WINDOW_DAYS = 540;

// The deployed 4h Bollinger-MR cluster (L01-L05, L10) — testing whether a TIME-stop
// helps it (lower DD / comfort) vs the rarely-firing wide static SL.
const STRATS: { label: string; build: () => CustomStrategy }[] = [
  { label: 'BollMR ETH 4h (L01)', build: () => bollMr('ETHUSDT', '240', 20, 2, 200, 0.07) },
  { label: 'BollMR LINK 4h (L02)', build: () => bollMr('LINKUSDT', '240', 20, 2, 200, 0.08) },
  { label: 'BollMR XRP 4h (L03)', build: () => bollMr('XRPUSDT', '240', 20, 2, 200, 0.05) },
  { label: 'BollMR BNB 4h (L04)', build: () => bollMr('BNBUSDT', '240', 20, 2, 200, 0.05) },
  { label: 'BollMR DOGE 4h (L05)', build: () => bollMr('DOGEUSDT', '240', 20, 2, 200, 0.08) },
  { label: 'BollMR BTC 4h (L10)', build: () => bollMr('BTCUSDT', '240', 20, 2, 200, 0.06) },
];

const MODES: { label: string; mode: SlMode }[] = [
  { label: 'none', mode: { kind: 'none' } },
  { label: 'static-3%', mode: { kind: 'static', pct: 0.03 } },
  { label: 'static-5%', mode: { kind: 'static', pct: 0.05 } },
  { label: 'static-8%', mode: { kind: 'static', pct: 0.08 } },
  { label: 'ATR×2', mode: { kind: 'atr', mult: 2, period: 14 } },
  { label: 'ATR×3', mode: { kind: 'atr', mult: 3, period: 14 } },
  { label: 'time-24', mode: { kind: 'time', bars: 24 } },
  { label: 'time-48', mode: { kind: 'time', bars: 48 } },
  { label: 'ATR×3+t48', mode: { kind: 'atr+time', mult: 3, period: 14, bars: 48 } },
];

function m(realized: number[]) {
  const n = realized.length;
  if (n === 0) return { net: 0, pf: 0, wr: 0, dd: 0, n: 0 };
  let gp = 0, gl = 0, wins = 0, cum = 0, peak = 0, dd = 0;
  for (const r of realized) { const x = r - COMM; if (x >= 0) { gp += x; wins++; } else gl += -x; cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return { net: Math.round((gp - gl) * 10) / 10, pf: gl === 0 ? Infinity : Math.round((gp / gl) * 100) / 100, wr: Math.round((wins / n) * 100), dd: Math.round(dd * 10) / 10, n };
}

(async () => {
  const now = Date.now();
  console.log(`SL-mode audit · maker MR @5m · ${WINDOW_DAYS}d · net of ${COMM}%/trade\n`);
  for (const st of STRATS) {
    const strat = st.build();
    let candles: Candle[] = [];
    try { candles = await getKlines(strat.symbol, strat.timeframe, now - WINDOW_DAYS * 86_400_000, now); }
    catch (e) { console.log(`${st.label}: klines err ${(e as Error).message}`); continue; }
    if (candles.length < strat.warmup + 50) { console.log(`${st.label}: insufficient`); continue; }

    type Row = { label: string; all: ReturnType<typeof m>; is: ReturnType<typeof m>; oos: ReturnType<typeof m> };
    const rows: Row[] = [];
    for (const mo of MODES) {
      const realized = runBacktest(strat, candles, mo.mode).tradesLog.map((t) => t.realizedPct);
      const cut = Math.floor(realized.length * 0.7);
      rows.push({ label: mo.label, all: m(realized), is: m(realized.slice(0, cut)), oos: m(realized.slice(cut)) });
    }
    // best = max robust (min of IS/OOS net), among net>0 overall
    const score = (r: Row) => Math.min(r.is.net, r.oos.net);
    const best = [...rows].filter((r) => r.all.net > 0).sort((a, b) => score(b) - score(a))[0];

    console.log(`■ ${st.label}`);
    console.log('   mode        N    net     PF    WR   DD     | IS / OOS net');
    for (const r of rows) {
      const star = best && r.label === best.label ? ' ⭐' : '';
      console.log(`   ${r.label.padEnd(11)} ${String(r.all.n).padStart(4)} ${String(r.all.net).padStart(6)}% ${String(r.all.pf).padStart(5)} ${String(r.all.wr).padStart(2)}% -${String(r.all.dd).padStart(5)} | ${String(r.is.net).padStart(5)} / ${String(r.oos.net).padStart(5)}${star}`);
    }
    console.log(`   → best by robust net: ${best ? best.label : '— (none net-positive)'}\n`);
  }
  console.log('⭐ = best robust (max of min(IS,OOS) net) among net-positive modes. none = native exit (no stop).');
})().catch((e) => { console.error(e); process.exit(1); });

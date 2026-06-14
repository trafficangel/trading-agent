/**
 * STRATEGY SWEEP — broad, honest search for a profitable edge.
 *
 * Tests many families × params × symbols × timeframes through the SAME
 * backtest engine (look-ahead-safe: decide() sees only candles[0..i]), net
 * of round-trip commission, with a chronological 70/30 in-sample/out-of-
 * sample split. Flags only candidates that pass a STRICT green gate:
 *   net>0 in BOTH halves, PF>1.3 overall, PF>1.1 in BOTH halves, N>=20.
 * That is the EDGE-FINDER bar — an edge that persists out-of-sample, not a
 * curve-fit. Survivors are then adversarially verified separately.
 *
 * Run on the VPS (Bybit klines). Usage: pnpm tsx scripts/strategy-sweep.ts
 * Writes data/sweep-results.json (full grid) for the verification step.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { smaTrend, emaCross, donchianFlip, momentumRoc, rsiMr, bollMr } from '../src/backtest/strategies/families.js';
import { TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const COMM = TRACK_C_COMMISSION_RT_PCT;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
// Fetch window per timeframe (days). Higher TFs reach further back.
const WINDOW_DAYS: Record<string, number> = { '15': 270, '60': 400, '240': 720, D: 1600 };

type Spec = { fam: string; tf: string; build: (sym: string) => CustomStrategy };
function specsForSymbol(): Spec[] {
  const out: Spec[] = [];
  const trendTFs = ['60', '240', 'D'];
  const mrTFs = ['15', '60', '240'];
  for (const tf of trendTFs) {
    for (const p of [50, 100, 150, 200]) out.push({ fam: 'sma-trend', tf, build: (s) => smaTrend(s, tf, p) });
    for (const [f, sl] of [[10, 30], [20, 50], [50, 200]] as const) out.push({ fam: 'ema-cross', tf, build: (s) => emaCross(s, tf, f, sl) });
    for (const p of [20, 40, 55]) out.push({ fam: 'donchian', tf, build: (s) => donchianFlip(s, tf, p) });
    for (const l of [20, 50, 100]) out.push({ fam: 'momentum', tf, build: (s) => momentumRoc(s, tf, l) });
  }
  for (const tf of mrTFs) {
    for (const [os, ob, te] of [[30, 70, 0], [30, 70, 200], [25, 75, 200]] as const) out.push({ fam: 'rsi-mr', tf, build: (s) => rsiMr(s, tf, os, ob, te) });
    for (const [p, k, te] of [[20, 2, 0], [20, 2.5, 0], [20, 2, 200]] as const) out.push({ fam: 'boll-mr', tf, build: (s) => bollMr(s, tf, p, k, te) });
  }
  return out;
}

function metrics(realized: number[]): { net: number; pf: number; wr: number; maxdd: number; n: number } {
  const n = realized.length;
  if (n === 0) return { net: 0, pf: 0, wr: 0, maxdd: 0, n: 0 };
  let gp = 0, gl = 0, wins = 0, cum = 0, peak = 0, dd = 0;
  for (const r of realized) {
    const x = r - COMM;
    if (x >= 0) { gp += x; wins++; } else gl += -x;
    cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
  }
  return { net: Math.round((gp - gl) * 10) / 10, pf: gl === 0 ? Infinity : Math.round((gp / gl) * 100) / 100, wr: Math.round((wins / n) * 100), maxdd: Math.round(dd * 10) / 10, n };
}

type Row = { id: string; fam: string; symbol: string; tf: string; all: ReturnType<typeof metrics>; is: ReturnType<typeof metrics>; oos: ReturnType<typeof metrics>; green: boolean };

(async () => {
  const now = Date.now();
  const rows: Row[] = [];
  const specs = specsForSymbol();
  // Group fetch by (symbol, tf) so each candle series is loaded once.
  const tfsUsed = [...new Set(specs.map((s) => s.tf))];
  console.log(`Sweep · ${SYMBOLS.length} symbols × ${tfsUsed.join('/')} · ${specs.length / tfsUsed.length | 0}~ specs/tf · net of ${COMM}%/trade\n`);

  for (const symbol of SYMBOLS) {
    const candleCache = new Map<string, Candle[]>();
    for (const tf of tfsUsed) {
      const from = now - (WINDOW_DAYS[tf] ?? 365) * 86_400_000;
      try { candleCache.set(tf, await getKlines(symbol, tf, from, now)); }
      catch (e) { process.stderr.write(`  ${symbol} ${tf}: ${(e as Error).message}\n`); candleCache.set(tf, []); }
    }
    for (const spec of specs) {
      const candles = candleCache.get(spec.tf) ?? [];
      const strat = spec.build(symbol);
      if (candles.length < strat.warmup + 40) continue;
      const trades = runBacktest(strat, candles).tradesLog;
      if (trades.length < 5) continue;
      const realized = trades.map((t) => t.realizedPct);
      const cut = Math.floor(trades.length * 0.7);
      const all = metrics(realized); const is = metrics(realized.slice(0, cut)); const oos = metrics(realized.slice(cut));
      const green = all.n >= 20 && all.net > 0 && all.pf > 1.3 && is.net > 0 && oos.net > 0 && is.pf > 1.1 && oos.pf > 1.1;
      rows.push({ id: strat.id, fam: spec.fam, symbol, tf: spec.tf, all, is, oos, green });
    }
    process.stderr.write(`  done ${symbol}\n`);
  }

  writeFileSync(resolve('data', 'sweep-results.json'), JSON.stringify(rows, null, 2));

  // Robustness score = the worse of the two halves' net (reward consistency).
  const score = (r: Row) => Math.min(r.is.net, r.oos.net);
  const ranked = [...rows].sort((a, b) => score(b) - score(a));
  const green = ranked.filter((r) => r.green);

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.fam.padEnd(10)} ${r.symbol.padEnd(9)} ${r.tf.padEnd(3)} ${r.id.padEnd(26)} N${String(r.all.n).padStart(3)} net ${String(r.all.net).padStart(6)}% PF ${String(r.all.pf).padStart(4)} WR ${String(r.all.wr).padStart(2)}% DD-${String(r.all.maxdd).padStart(5)} | IS ${String(r.is.net).padStart(5)}%/PF${r.is.pf} OOS ${String(r.oos.net).padStart(5)}%/PF${r.oos.pf}`;

  console.log(`\n===== GREEN GATE PASSERS (${green.length}) =====`);
  console.log(green.length ? green.map(line).join('\n') : '  — none —');
  console.log(`\n===== TOP 30 by robustness (min of IS/OOS net) =====`);
  console.log(ranked.slice(0, 30).map(line).join('\n'));
  console.log(`\nTotal tested: ${rows.length}. Green: ${green.length}. Full grid → data/sweep-results.json`);
  console.log('Green gate = N>=20, net>0 both halves, PF>1.3 overall, PF>1.1 both halves.');
})().catch((e) => { console.error(e); process.exit(1); });

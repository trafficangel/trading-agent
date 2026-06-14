/**
 * LOW-TF STRATEGY SWEEP — honest search on 5m & 15m, where commission is the
 * dominant enemy (a 0.11% round-trip is a big fraction of a 5m move). Same
 * engine + families as the main sweep, but the GREEN GATE adds the killer
 * test for low TF: must stay net-positive at DOUBLE commission. A low-TF
 * "edge" that dies at ×2 cost is a mirage (real slippage there is worse).
 *
 * Green = N>=30, net>0 in BOTH IS/OOS halves, PF>1.3 overall, AND net>0 at
 * ×2 commission. Run on the VPS. Usage: pnpm tsx scripts/strategy-sweep-lowtf.ts
 * Writes data/sweep-lowtf-results.json.
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
const WINDOW_DAYS: Record<string, number> = { '5': 180, '15': 400 };

type Spec = { fam: string; tf: string; build: (s: string) => CustomStrategy };
function specs(): Spec[] {
  const out: Spec[] = [];
  for (const tf of ['5', '15']) {
    for (const [os, ob, te] of [[30, 70, 0], [30, 70, 200], [25, 75, 200]] as const) out.push({ fam: 'rsi-mr', tf, build: (s) => rsiMr(s, tf, os, ob, te) });
    for (const [p, k, te] of [[20, 2, 0], [20, 2, 200], [20, 2.5, 200]] as const) out.push({ fam: 'boll-mr', tf, build: (s) => bollMr(s, tf, p, k, te) });
    for (const p of [50, 100, 200]) out.push({ fam: 'sma-trend', tf, build: (s) => smaTrend(s, tf, p) });
    for (const [f, sl] of [[10, 30], [20, 50]] as const) out.push({ fam: 'ema-cross', tf, build: (s) => emaCross(s, tf, f, sl) });
    for (const p of [20, 40]) out.push({ fam: 'donchian', tf, build: (s) => donchianFlip(s, tf, p) });
    for (const l of [20, 50]) out.push({ fam: 'momentum', tf, build: (s) => momentumRoc(s, tf, l) });
  }
  return out;
}

function metrics(realized: number[], mult: number) {
  const n = realized.length;
  if (n === 0) return { net: 0, pf: 0, wr: 0, maxdd: 0, n: 0 };
  let gp = 0, gl = 0, wins = 0, cum = 0, peak = 0, dd = 0;
  for (const r of realized) {
    const x = r - COMM * mult;
    if (x >= 0) { gp += x; wins++; } else gl += -x;
    cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
  }
  return { net: Math.round((gp - gl) * 10) / 10, pf: gl === 0 ? Infinity : Math.round((gp / gl) * 100) / 100, wr: Math.round((wins / n) * 100), maxdd: Math.round(dd * 10) / 10, n };
}

type Row = { id: string; fam: string; symbol: string; tf: string; n: number; net1: number; net2: number; pf: number; wr: number; maxdd: number; isNet: number; oosNet: number; green: boolean };

(async () => {
  const now = Date.now();
  const rows: Row[] = [];
  const list = specs();
  console.log(`Low-TF sweep · 5m & 15m · ${SYMBOLS.length} symbols · ${list.length / 2} specs/tf · net of ${COMM}%/trade\n`);

  for (const symbol of SYMBOLS) {
    const cache = new Map<string, Candle[]>();
    for (const tf of ['5', '15']) {
      const from = now - (WINDOW_DAYS[tf] ?? 180) * 86_400_000;
      try { cache.set(tf, await getKlines(symbol, tf, from, now)); } catch (e) { process.stderr.write(`  ${symbol} ${tf}: ${(e as Error).message}\n`); cache.set(tf, []); }
    }
    for (const sp of list) {
      const candles = cache.get(sp.tf) ?? [];
      const strat = sp.build(symbol);
      if (candles.length < strat.warmup + 50) continue;
      const realized = runBacktest(strat, candles).tradesLog.map((t) => t.realizedPct);
      if (realized.length < 10) continue;
      const cut = Math.floor(realized.length * 0.7);
      const all = metrics(realized, 1); const all2 = metrics(realized, 2);
      const is = metrics(realized.slice(0, cut), 1); const oos = metrics(realized.slice(cut), 1);
      const green = all.n >= 30 && all.net > 0 && all.pf > 1.3 && is.net > 0 && oos.net > 0 && all2.net > 0;
      rows.push({ id: strat.id, fam: sp.fam, symbol, tf: sp.tf, n: all.n, net1: all.net, net2: all2.net, pf: all.pf, wr: all.wr, maxdd: all.maxdd, isNet: is.net, oosNet: oos.net, green });
    }
    process.stderr.write(`  done ${symbol}\n`);
  }

  writeFileSync(resolve('data', 'sweep-lowtf-results.json'), JSON.stringify(rows, null, 2));
  const green = rows.filter((r) => r.green).sort((a, b) => b.net2 - a.net2);
  // Also show the "best at ×2 cost" regardless of green, to see how close anything gets.
  const byNet2 = [...rows].filter((r) => r.n >= 30).sort((a, b) => b.net2 - a.net2);
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.fam.padEnd(10)} ${r.symbol.padEnd(9)} ${r.tf.padEnd(2)} ${r.id.padEnd(24)} N${String(r.n).padStart(4)} net×1 ${String(r.net1).padStart(6)}% net×2 ${String(r.net2).padStart(6)}% PF ${String(r.pf).padStart(4)} WR ${String(r.wr).padStart(2)}% DD-${String(r.maxdd).padStart(5)} | IS ${String(r.isNet).padStart(5)} OOS ${String(r.oosNet).padStart(5)}`;

  console.log(`\n===== GREEN (survives ×2 cost + OOS) (${green.length}) =====`);
  console.log(green.length ? green.map(line).join('\n') : '  — none —');
  console.log(`\n===== TOP 25 by net AT ×2 COST (the honest low-TF bar) =====`);
  console.log(byNet2.slice(0, 25).map(line).join('\n'));
  console.log(`\nTested ${rows.length}. Green ${green.length}. Full → data/sweep-lowtf-results.json`);
  console.log('Low-TF reality: commission ×2 must stay positive, else slippage eats it live.');
})().catch((e) => { console.error(e); process.exit(1); });

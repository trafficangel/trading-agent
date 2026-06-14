/**
 * NEW-FAMILY low-TF sweep — extra intraday mean-reversion families (IBS,
 * Connors RSI-2, z-score, consecutive-candles, Keltner) on 5m & 15m, beyond
 * the 6 already tested. These are maker-executable, so the realistic test is
 * at Hyperliquid MAKER fees (0.02% RT); Bybit taker (0.11%) shown for contrast.
 *
 * Green = N>=30, net>0 both IS/OOS halves at maker, PF>1.3 at maker, AND
 * net>0 at ×2 maker fee. Run on the VPS. Usage: pnpm tsx scripts/strategy-sweep-newfam.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { ibsMr, rsi2, zscoreMr, consecMr, keltnerMr } from '../src/backtest/strategies/families-lowtf.js';

const MAKER = 0.02; // HL maker round-trip
const TAKER = 0.11; // Bybit taker round-trip (contrast)
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const WINDOW_DAYS: Record<string, number> = { '5': 180, '15': 400 };

type Spec = { fam: string; tf: string; build: (s: string) => CustomStrategy };
function specs(): Spec[] {
  const out: Spec[] = [];
  for (const tf of ['5', '15']) {
    for (const [lo, hi, te] of [[0.1, 0.9, 0], [0.1, 0.9, 200], [0.2, 0.8, 200]] as const) out.push({ fam: 'ibs', tf, build: (s) => ibsMr(s, tf, lo, hi, te) });
    for (const [os, ob, te] of [[10, 90, 200], [5, 95, 200], [10, 90, 0]] as const) out.push({ fam: 'rsi2', tf, build: (s) => rsi2(s, tf, os, ob, te) });
    for (const [p, z, te] of [[50, 2, 0], [50, 2, 200], [100, 2, 200]] as const) out.push({ fam: 'zscore', tf, build: (s) => zscoreMr(s, tf, p, z, te) });
    for (const [k, te] of [[3, 0], [3, 200], [4, 200]] as const) out.push({ fam: 'consec', tf, build: (s) => consecMr(s, tf, k, te) });
    for (const [e, a, m, te] of [[20, 10, 2, 0], [20, 10, 2, 200], [20, 10, 2.5, 200]] as const) out.push({ fam: 'keltner', tf, build: (s) => keltnerMr(s, tf, e, a, m, te) });
  }
  return out;
}

function metrics(realized: number[], fee: number) {
  const n = realized.length; if (n === 0) return { net: 0, pf: 0, wr: 0, maxdd: 0, n: 0 };
  let gp = 0, gl = 0, wins = 0, cum = 0, peak = 0, dd = 0;
  for (const r of realized) { const x = r - fee; if (x >= 0) { gp += x; wins++; } else gl += -x; cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return { net: Math.round((gp - gl) * 10) / 10, pf: gl === 0 ? Infinity : Math.round((gp / gl) * 100) / 100, wr: Math.round((wins / n) * 100), maxdd: Math.round(dd * 10) / 10, n };
}

type Row = { id: string; fam: string; symbol: string; tf: string; n: number; netMk: number; netMk2: number; netTk: number; pf: number; wr: number; maxdd: number; isNet: number; oosNet: number; green: boolean };

(async () => {
  const now = Date.now();
  const rows: Row[] = [];
  const list = specs();
  console.log(`New-family low-TF sweep · 5m & 15m · ${SYMBOLS.length} symbols · ${list.length / 2} specs/tf · maker ${MAKER}% vs taker ${TAKER}%\n`);

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
      const mk = metrics(realized, MAKER); const mk2 = metrics(realized, MAKER * 2);
      const is = metrics(realized.slice(0, cut), MAKER); const oos = metrics(realized.slice(cut), MAKER);
      const green = mk.n >= 30 && mk.net > 0 && mk.pf > 1.3 && is.net > 0 && oos.net > 0 && mk2.net > 0;
      rows.push({ id: strat.id, fam: sp.fam, symbol, tf: sp.tf, n: mk.n, netMk: mk.net, netMk2: mk2.net, netTk: metrics(realized, TAKER).net, pf: mk.pf, wr: mk.wr, maxdd: mk.maxdd, isNet: is.net, oosNet: oos.net, green });
    }
    process.stderr.write(`  done ${symbol}\n`);
  }

  writeFileSync(resolve('data', 'sweep-newfam-results.json'), JSON.stringify(rows, null, 2));
  const green = rows.filter((r) => r.green).sort((a, b) => b.netMk2 - a.netMk2);
  const byMk = [...rows].filter((r) => r.n >= 30).sort((a, b) => b.netMk - a.netMk);
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.fam.padEnd(8)} ${r.symbol.padEnd(9)} ${r.tf.padEnd(2)} ${r.id.padEnd(26)} N${String(r.n).padStart(4)} mk ${String(r.netMk).padStart(6)}% mk×2 ${String(r.netMk2).padStart(6)}% (tk ${String(r.netTk).padStart(6)}%) PF ${String(r.pf).padStart(4)} WR ${String(r.wr).padStart(2)}% DD-${String(r.maxdd).padStart(5)} | IS ${String(r.isNet).padStart(5)} OOS ${String(r.oosNet).padStart(5)}`;

  console.log(`\n===== GREEN (maker, OOS+, survives ×2 maker) (${green.length}) =====`);
  console.log(green.length ? green.map(line).join('\n') : '  — none —');
  console.log(`\n===== TOP 25 by net at maker fee =====`);
  console.log(byMk.slice(0, 25).map(line).join('\n'));
  console.log(`\nTested ${rows.length}. Green ${green.length}. Full → data/sweep-newfam-results.json`);
})().catch((e) => { console.error(e); process.exit(1); });

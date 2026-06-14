/**
 * MAKER / HYPERLIQUID-FEE SWEEP on 30m & 1h.
 *
 * Lower fees change the mid-TF math. We model each family with the fee its
 * execution style would REALISTICALLY pay on Hyperliquid:
 *   - mean-reversion (rsi-mr, boll-mr): MAKER — you rest a limit at the band
 *     and price comes to you. HL maker ≈ 0.01%/side → 0.02% round-trip.
 *   - trend / breakout / momentum (sma, ema-cross, donchian, momentum): they
 *     CHASE the move → realistically TAKER. HL taker ≈ 0.035%/side → 0.07% RT.
 * (For contrast we also print net at the Bybit taker 0.11% RT.)
 *
 * Honest caveats kept: maker fills are not guaranteed (a limit at the band
 * may not fill if price reverses just before) — so we still demand survival
 * at ×2 the modelled fee. Price data is Bybit klines (a fine proxy; HL prices
 * track within a hair).
 *
 * Green = N>=30, net>0 both IS/OOS halves, PF>1.3 at the realistic fee, AND
 * net>0 at ×2 that fee. Run on the VPS. Usage: pnpm tsx scripts/strategy-sweep-maker.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { smaTrend, emaCross, donchianFlip, momentumRoc, rsiMr, bollMr } from '../src/backtest/strategies/families.js';

const HL_MAKER_RT = 0.02; // Hyperliquid maker round-trip (0.01%/side)
const HL_TAKER_RT = 0.07; // Hyperliquid taker round-trip (0.035%/side)
const BYBIT_RT = 0.11;    // for contrast
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const WINDOW_DAYS: Record<string, number> = { '30': 300, '60': 450 };
const MAKER_FAMS = new Set(['rsi-mr', 'boll-mr']);

type Spec = { fam: string; tf: string; build: (s: string) => CustomStrategy };
function specs(): Spec[] {
  const out: Spec[] = [];
  for (const tf of ['30', '60']) {
    for (const [os, ob, te] of [[30, 70, 0], [30, 70, 200], [25, 75, 200]] as const) out.push({ fam: 'rsi-mr', tf, build: (s) => rsiMr(s, tf, os, ob, te) });
    for (const [p, k, te] of [[20, 2, 0], [20, 2, 200], [20, 2.5, 200]] as const) out.push({ fam: 'boll-mr', tf, build: (s) => bollMr(s, tf, p, k, te) });
    for (const p of [50, 100, 200]) out.push({ fam: 'sma-trend', tf, build: (s) => smaTrend(s, tf, p) });
    for (const [f, sl] of [[10, 30], [20, 50]] as const) out.push({ fam: 'ema-cross', tf, build: (s) => emaCross(s, tf, f, sl) });
    for (const p of [20, 40]) out.push({ fam: 'donchian', tf, build: (s) => donchianFlip(s, tf, p) });
    for (const l of [20, 50]) out.push({ fam: 'momentum', tf, build: (s) => momentumRoc(s, tf, l) });
  }
  return out;
}

function metrics(realized: number[], commRT: number) {
  const n = realized.length;
  if (n === 0) return { net: 0, pf: 0, wr: 0, maxdd: 0, n: 0 };
  let gp = 0, gl = 0, wins = 0, cum = 0, peak = 0, dd = 0;
  for (const r of realized) {
    const x = r - commRT;
    if (x >= 0) { gp += x; wins++; } else gl += -x;
    cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
  }
  return { net: Math.round((gp - gl) * 10) / 10, pf: gl === 0 ? Infinity : Math.round((gp / gl) * 100) / 100, wr: Math.round((wins / n) * 100), maxdd: Math.round(dd * 10) / 10, n };
}

type Row = { id: string; fam: string; symbol: string; tf: string; exec: string; fee: number; n: number; netReal: number; netStress: number; netBybit: number; pf: number; wr: number; maxdd: number; isNet: number; oosNet: number; green: boolean };

(async () => {
  const now = Date.now();
  const rows: Row[] = [];
  const list = specs();
  console.log(`Maker/HL-fee sweep · 30m & 1h · ${SYMBOLS.length} symbols · MR=maker ${HL_MAKER_RT}%RT, trend=taker ${HL_TAKER_RT}%RT\n`);

  for (const symbol of SYMBOLS) {
    const cache = new Map<string, Candle[]>();
    for (const tf of ['30', '60']) {
      const from = now - (WINDOW_DAYS[tf] ?? 300) * 86_400_000;
      try { cache.set(tf, await getKlines(symbol, tf, from, now)); } catch (e) { process.stderr.write(`  ${symbol} ${tf}: ${(e as Error).message}\n`); cache.set(tf, []); }
    }
    for (const sp of list) {
      const candles = cache.get(sp.tf) ?? [];
      const strat = sp.build(symbol);
      if (candles.length < strat.warmup + 50) continue;
      const realized = runBacktest(strat, candles).tradesLog.map((t) => t.realizedPct);
      if (realized.length < 10) continue;
      const isMaker = MAKER_FAMS.has(sp.fam);
      const fee = isMaker ? HL_MAKER_RT : HL_TAKER_RT;
      const cut = Math.floor(realized.length * 0.7);
      const all = metrics(realized, fee); const stress = metrics(realized, fee * 2);
      const is = metrics(realized.slice(0, cut), fee); const oos = metrics(realized.slice(cut), fee);
      const green = all.n >= 30 && all.net > 0 && all.pf > 1.3 && is.net > 0 && oos.net > 0 && stress.net > 0;
      rows.push({ id: strat.id, fam: sp.fam, symbol, tf: sp.tf, exec: isMaker ? 'M' : 'T', fee, n: all.n, netReal: all.net, netStress: stress.net, netBybit: metrics(realized, BYBIT_RT).net, pf: all.pf, wr: all.wr, maxdd: all.maxdd, isNet: is.net, oosNet: oos.net, green });
    }
    process.stderr.write(`  done ${symbol}\n`);
  }

  writeFileSync(resolve('data', 'sweep-maker-results.json'), JSON.stringify(rows, null, 2));
  const green = rows.filter((r) => r.green).sort((a, b) => b.netStress - a.netStress);
  const byReal = [...rows].filter((r) => r.n >= 30).sort((a, b) => b.netReal - a.netReal);
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.fam.padEnd(10)} ${r.symbol.padEnd(9)} ${r.tf.padEnd(2)} ${r.exec} ${r.id.padEnd(22)} N${String(r.n).padStart(4)} net@HL ${String(r.netReal).padStart(6)}% net@2x ${String(r.netStress).padStart(6)}% (bybit ${String(r.netBybit).padStart(6)}%) PF ${String(r.pf).padStart(4)} WR ${String(r.wr).padStart(2)}% DD-${String(r.maxdd).padStart(5)} | IS ${String(r.isNet).padStart(5)} OOS ${String(r.oosNet).padStart(5)}`;

  console.log(`\n===== GREEN (HL fee, OOS+, survives ×2 fee) (${green.length}) =====`);
  console.log(green.length ? green.map(line).join('\n') : '  — none —');
  console.log(`\n===== TOP 25 by net at realistic HL fee =====`);
  console.log(byReal.slice(0, 25).map(line).join('\n'));
  console.log(`\nTested ${rows.length}. Green ${green.length}. exec M=maker(${HL_MAKER_RT}%) T=taker(${HL_TAKER_RT}%). Full → data/sweep-maker-results.json`);
  console.log('NB: maker fills not guaranteed — the ×2-fee column is the honest cushion. Bybit-0.11 shown for contrast.');
})().catch((e) => { console.error(e); process.exit(1); });

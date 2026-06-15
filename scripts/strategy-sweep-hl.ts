/**
 * HYPERLIQUID-FEE SWEEP — broad re-search at HL's low fees (taker 0.07% RT,
 * maker 0.04% RT), across all families × TFs {15m,30m,1h,4h}. HL taker is
 * ~1.6× cheaper than Bybit (0.07 vs 0.11), so mid-TF trend/breakout configs
 * that JUST missed at Bybit may pass here. Per-family realistic execution:
 *   - trend/breakout/momentum CHASE → taker 0.07
 *   - mean-reversion RESTS a limit at the band → maker 0.04
 * Green = N>=30, net>0 both IS/OOS halves at the fee, PF>1.3, AND net>0 at
 * ×2 the fee. Run on the VPS. Usage: pnpm tsx scripts/strategy-sweep-hl.ts
 * Writes data/sweep-hl-results.json.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { smaTrend, emaCross, donchianFlip, momentumRoc, rsiMr, bollMr } from '../src/backtest/strategies/families.js';
import { ibsMr, rsi2, zscoreMr, consecMr, keltnerMr } from '../src/backtest/strategies/families-lowtf.js';

const HL_MAKER = 0.04;
const HL_TAKER = 0.07;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const TFS = ['15', '30', '60', '240'];
const WINDOW_DAYS: Record<string, number> = { '15': 300, '30': 400, '60': 500, '240': 720 };
const MAKER_FAMS = new Set(['rsi-mr', 'boll-mr', 'ibs', 'rsi2', 'zscore', 'consec', 'keltner']);

type Spec = { fam: string; build: (s: string, tf: string) => CustomStrategy };
function specs(): Spec[] {
  const out: Spec[] = [];
  // trend / breakout / momentum (taker)
  for (const p of [50, 100, 200]) out.push({ fam: 'sma-trend', build: (s, tf) => smaTrend(s, tf, p) });
  for (const [f, sl] of [[20, 50], [50, 200]] as const) out.push({ fam: 'ema-cross', build: (s, tf) => emaCross(s, tf, f, sl) });
  for (const p of [20, 40]) out.push({ fam: 'donchian', build: (s, tf) => donchianFlip(s, tf, p) });
  for (const l of [30, 90]) out.push({ fam: 'momentum', build: (s, tf) => momentumRoc(s, tf, l) });
  // mean-reversion (maker)
  for (const [os, ob, te] of [[30, 70, 200], [25, 75, 200]] as const) out.push({ fam: 'rsi-mr', build: (s, tf) => rsiMr(s, tf, os, ob, te) });
  for (const [p, k, te] of [[20, 2, 200], [20, 2.5, 200]] as const) out.push({ fam: 'boll-mr', build: (s, tf) => bollMr(s, tf, p, k, te) });
  out.push({ fam: 'ibs', build: (s, tf) => ibsMr(s, tf, 0.1, 0.9, 200) });
  out.push({ fam: 'rsi2', build: (s, tf) => rsi2(s, tf, 10, 90, 200) });
  out.push({ fam: 'zscore', build: (s, tf) => zscoreMr(s, tf, 50, 2, 200) });
  out.push({ fam: 'consec', build: (s, tf) => consecMr(s, tf, 3, 200) });
  out.push({ fam: 'keltner', build: (s, tf) => keltnerMr(s, tf, 20, 10, 2, 200) });
  return out;
}

function metrics(realized: number[], fee: number) {
  const n = realized.length; if (n === 0) return { net: 0, pf: 0, wr: 0, dd: 0, n: 0 };
  let gp = 0, gl = 0, wins = 0, cum = 0, peak = 0, dd = 0;
  for (const r of realized) { const x = r - fee; if (x >= 0) { gp += x; wins++; } else gl += -x; cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return { net: Math.round((gp - gl) * 10) / 10, pf: gl === 0 ? Infinity : Math.round((gp / gl) * 100) / 100, wr: Math.round((wins / n) * 100), dd: Math.round(dd * 10) / 10, n };
}

type Row = { id: string; fam: string; symbol: string; tf: string; exec: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isNet: number; oosNet: number; green: boolean };

(async () => {
  const now = Date.now();
  const rows: Row[] = [];
  const list = specs();
  console.log(`HL-fee sweep · ${TFS.join('/')} · ${SYMBOLS.length} symbols · ${list.length} specs/tf · maker ${HL_MAKER}% / taker ${HL_TAKER}%\n`);

  for (const symbol of SYMBOLS) {
    for (const tf of TFS) {
      let candles: Candle[] = [];
      try { candles = await getKlines(symbol, tf, now - (WINDOW_DAYS[tf] ?? 400) * 86_400_000, now); } catch (e) { process.stderr.write(`  ${symbol} ${tf}: ${(e as Error).message}\n`); continue; }
      for (const sp of list) {
        const strat = sp.build(symbol, tf);
        if (candles.length < strat.warmup + 50) continue;
        const realized = runBacktest(strat, candles).tradesLog.map((t) => t.realizedPct);
        if (realized.length < 10) continue;
        const fee = MAKER_FAMS.has(sp.fam) ? HL_MAKER : HL_TAKER;
        const cut = Math.floor(realized.length * 0.7);
        const all = metrics(realized, fee); const all2 = metrics(realized, fee * 2);
        const is = metrics(realized.slice(0, cut), fee); const oos = metrics(realized.slice(cut), fee);
        const green = all.n >= 30 && all.net > 0 && all.pf > 1.3 && is.net > 0 && oos.net > 0 && all2.net > 0;
        rows.push({ id: strat.id, fam: sp.fam, symbol, tf, exec: MAKER_FAMS.has(sp.fam) ? 'M' : 'T', n: all.n, net: all.net, net2: all2.net, pf: all.pf, wr: all.wr, dd: all.dd, isNet: is.net, oosNet: oos.net, green });
      }
    }
    process.stderr.write(`  done ${symbol}\n`);
  }

  writeFileSync(resolve('data', 'sweep-hl-results.json'), JSON.stringify(rows, null, 2));
  const green = rows.filter((r) => r.green).sort((a, b) => b.net2 - a.net2);
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.fam.padEnd(10)} ${r.symbol.padEnd(9)} ${r.tf.padEnd(3)} ${r.exec} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)}% ×2 ${String(r.net2).padStart(6)}% PF ${String(r.pf).padStart(4)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(5)} | IS ${String(r.isNet).padStart(5)} OOS ${String(r.oosNet).padStart(5)}`;
  console.log(`\n===== GREEN @ HL fees (net+ both halves, PF>1.3, survives ×2) (${green.length}) =====`);
  console.log(green.length ? green.map(line).join('\n') : '  — none —');
  console.log(`\nTested ${rows.length}. Green ${green.length}. Full → data/sweep-hl-results.json`);
  console.log('Green here = candidate; still needs cross-symbol verification before the lab.');
})().catch((e) => { console.error(e); process.exit(1); });

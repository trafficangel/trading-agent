/**
 * HL-CANDIDATE VERIFIER — adversarial kill-battery for the new HL-fee finds.
 * For each (family, tf) we test ALL 10 coins (cross-symbol generalization is
 * the real anti-overfit test) with 4-fold WALK-FORWARD + cost-stress ×2/×3 at
 * the realistic HL fee. A config "survives" a coin if ≥3/4 sequential folds
 * net-positive AND the whole window stays net+ at ×2 fee. An edge is REAL if
 * it survives a MAJORITY of coins — a single-coin survivor is data-mining.
 * Run on the VPS. Usage: pnpm tsx scripts/verify-hl.ts
 */

import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { type Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { bollMr } from '../src/backtest/strategies/families.js';
import { rsi2, zscoreMr, keltnerMr } from '../src/backtest/strategies/families-lowtf.js';

const HL_MAKER = 0.04;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];

type Cand = { name: string; tf: string; days: number; build: (s: string, tf: string) => CustomStrategy };
const CANDS: Cand[] = [
  { name: 'keltner-1h', tf: '60', days: 500, build: (s, tf) => keltnerMr(s, tf, 20, 10, 2, 200) },
  { name: 'zscore-1h', tf: '60', days: 500, build: (s, tf) => zscoreMr(s, tf, 50, 2, 200) },
  { name: 'boll-mr-4h', tf: '240', days: 720, build: (s, tf) => bollMr(s, tf, 20, 2, 200) },
  { name: 'rsi2-4h', tf: '240', days: 720, build: (s, tf) => rsi2(s, tf, 10, 90, 200) },
];

function net(realized: number[], fee: number): number { let s = 0; for (const r of realized) s += r - fee; return Math.round(s * 10) / 10; }
function folds4(realized: number[], fee: number): { pos: number; mins: number } {
  const k = Math.floor(realized.length / 4); if (k < 3) return { pos: 0, mins: 0 };
  let pos = 0, mins = Infinity;
  for (let f = 0; f < 4; f++) { const slice = realized.slice(f * k, f === 3 ? realized.length : (f + 1) * k); const n = net(slice, fee); if (n > 0) pos++; if (n < mins) mins = n; }
  return { pos, mins: Math.round(mins * 10) / 10 };
}
function maxDD(realized: number[], fee: number): number { let cum = 0, peak = 0, dd = 0; for (const r of realized) { cum += r - fee; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; } return Math.round(dd * 10) / 10; }

(async () => {
  const now = Date.now();
  for (const cand of CANDS) {
    console.log(`\n===== ${cand.name} (maker ${HL_MAKER}%, ${cand.tf}m, ${cand.days}d) — cross-symbol walk-forward =====`);
    let survivors = 0; const lines: string[] = [];
    for (const symbol of SYMBOLS) {
      let candles: Candle[] = [];
      try { candles = await getKlines(symbol, cand.tf, now - cand.days * 86_400_000, now); } catch (e) { lines.push(`  ${symbol.padEnd(9)} fetch err ${(e as Error).message}`); continue; }
      const strat = cand.build(symbol, cand.tf);
      if (candles.length < strat.warmup + 50) { lines.push(`  ${symbol.padEnd(9)} too few bars`); continue; }
      const realized = runBacktest(strat, candles).tradesLog.map((t) => t.realizedPct);
      if (realized.length < 12) { lines.push(`  ${symbol.padEnd(9)} N${realized.length} (too few trades)`); continue; }
      const f = folds4(realized, HL_MAKER);
      const n1 = net(realized, HL_MAKER), n2 = net(realized, HL_MAKER * 2), n3 = net(realized, HL_MAKER * 3);
      const dd = maxDD(realized, HL_MAKER);
      const live = f.pos >= 3 && n2 > 0;
      if (live) survivors++;
      lines.push(`  ${live ? '✅' : '  '} ${symbol.padEnd(9)} N${String(realized.length).padStart(4)}  folds+ ${f.pos}/4 (worst ${String(f.mins).padStart(6)})  net ${String(n1).padStart(6)} ×2 ${String(n2).padStart(6)} ×3 ${String(n3).padStart(6)}  DD-${String(dd).padStart(5)}`);
    }
    console.log(lines.join('\n'));
    console.log(`  → survives ${survivors}/${SYMBOLS.length} coins ${survivors >= 5 ? '✅ ROBUST edge' : survivors >= 3 ? '⚠ partial (add only survivors)' : '❌ likely data-mining'}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

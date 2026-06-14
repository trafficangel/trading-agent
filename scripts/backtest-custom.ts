/**
 * Phase U — run custom (non-LuxAlgo) strategies through the engine.
 *
 *   1. Fetch ~365d of klines (cached to data/klines/).
 *   2. Run each registered strategy → trades log in our standard format.
 *   3. Write src/strategies/data/<id>.json  (so audit-sl-distribution /
 *      kelly / regime / vol-gate all work on it unchanged — MAE is native).
 *   4. Print a summary + a chronological 70/30 walk-forward stability split.
 *
 * After this, get the SL verdict the usual way:
 *   pnpm tsx scripts/audit-sl-distribution.ts <id>
 *
 * Run on the VPS (Bybit reachable). Usage: pnpm tsx scripts/backtest-custom.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type BtTrade } from '../src/backtest/engine.js';
import { donchianTrend } from '../src/backtest/strategies/donchian-trend.js';
import { rsiMeanRev } from '../src/backtest/strategies/rsi-meanrev.js';
import { TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const DAYS = 365;
const COMM = TRACK_C_COMMISSION_RT_PCT; // percent points per trade

// Registry — custom strategies on FREE coins (no live collision later).
const STRATS = [
  // Iteration 2 — RSI mean-reversion + EMA200 trend filter (the June lesson:
  // only fade WITH the higher-TF trend). Compare directly to the naive ones.
  rsiMeanRev({ id: 'ada-rsi-trend', code: 'C05', symbol: 'ADAUSDT', timeframe: '15', period: 14, trendEma: 200 }),
  rsiMeanRev({ id: 'ltc-rsi-trend', code: 'C06', symbol: 'LTCUSDT', timeframe: '15', period: 14, trendEma: 200 }),
  rsiMeanRev({ id: 'sol-rsi-trend', code: 'C07', symbol: 'SOLUSDT', timeframe: '15', period: 14, trendEma: 200 }),
  rsiMeanRev({ id: 'link-rsi-trend', code: 'C08', symbol: 'LINKUSDT', timeframe: '15', period: 14, trendEma: 200 }),
  // tighter thresholds (25/75) — only deeper extremes, fewer/cleaner trades
  rsiMeanRev({ id: 'ada-rsi-trend-2575', code: 'C09', symbol: 'ADAUSDT', timeframe: '15', period: 14, oversold: 25, overbought: 75, trendEma: 200 }),
  rsiMeanRev({ id: 'ltc-rsi-trend-2575', code: 'C10', symbol: 'LTCUSDT', timeframe: '15', period: 14, oversold: 25, overbought: 75, trendEma: 200 }),
];
void donchianTrend; // kept available; naive trend rejected in iteration 1

function netPct(trades: BtTrade[]): number {
  return trades.reduce((a, t) => a + t.realizedPct, 0) - COMM * trades.length;
}
function pf(trades: BtTrade[]): number {
  let gp = 0, gl = 0;
  for (const t of trades) {
    const n = t.realizedPct - COMM;
    if (n >= 0) gp += n; else gl += -n;
  }
  return gl === 0 ? Infinity : gp / gl;
}
function wr(trades: BtTrade[]): number {
  return trades.length ? trades.filter((t) => t.realizedPct - COMM > 0).length / trades.length : 0;
}

(async () => {
  const now = Date.now();
  const from = now - DAYS * 86_400_000;

  console.log(`Custom-strategy backtest · ${DAYS}d · native exits + MAE · net of ${COMM}% commission\n`);
  console.log('code  ' + 'id'.padEnd(20) + ' sym       tf   N    netNative%  PF    WR%   | walk-forward (in→out)  ');
  console.log('-'.repeat(104));

  for (const strat of STRATS) {
    const candles = await getKlines(strat.symbol, strat.timeframe, from, now);
    if (candles.length < strat.warmup + 50) {
      console.log(`${strat.code}  ${strat.id.padEnd(20)} — insufficient klines (${candles.length})`);
      continue;
    }
    const res = runBacktest(strat, candles);
    const trades = res.tradesLog;

    // persist in the standard data-file shape (audit reads .tradesLog)
    writeFileSync(
      resolve('src/strategies/data', `${strat.id}.json`),
      JSON.stringify({ source: 'backtest-engine', symbol: strat.symbol, timeframe: strat.timeframe, generatedAtDays: DAYS, tradesLog: trades }, null, 2),
    );

    // chronological 70/30 walk-forward stability split (no params were fit,
    // so this is a does-the-edge-persist check, not an overfit guard).
    const cut = Math.floor(trades.length * 0.7);
    const inS = trades.slice(0, cut);
    const outS = trades.slice(cut);

    console.log(
      `${strat.code}  ${strat.id.padEnd(20)} ${strat.symbol.padEnd(9)} ${strat.timeframe.padEnd(4)} ` +
        `${String(trades.length).padStart(3)}  ${netPct(trades).toFixed(1).padStart(9)}  ` +
        `${(Number.isFinite(pf(trades)) ? pf(trades).toFixed(2) : '∞').padStart(5)} ${(wr(trades) * 100).toFixed(0).padStart(4)}  | ` +
        `in ${netPct(inS).toFixed(0).padStart(5)}% (PF ${pf(inS).toFixed(2)})  out ${netPct(outS).toFixed(0).padStart(5)}% (PF ${pf(outS).toFixed(2)})`,
    );
  }

  console.log('\nnetNative% = sum of NATIVE realized returns (no safety SL) net of commission.');
  console.log('Next: pnpm tsx scripts/audit-sl-distribution.ts <id>  → MAE distribution + optimal SL verdict.');
  console.log('GREEN if: positive net, PF>1.3, AND out-of-sample ≈ in-sample (edge persists).');
})().catch((e) => { console.error(e); process.exit(1); });

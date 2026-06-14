/**
 * Long-window backtest for DAILY trend strategies, so the SL/MAE audit runs
 * on a real sample (the 540d default in backtest-custom starves daily TFs to
 * ~8 trades). Writes trade logs to src/strategies/data/<id>.json, then run:
 *   pnpm tsx scripts/audit-sl-distribution.ts <id>
 * Run on the VPS (Bybit klines). Usage: pnpm tsx scripts/backtest-daily.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type BtTrade } from '../src/backtest/engine.js';
import { smaTrend } from '../src/backtest/strategies/families.js';
import { TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';

const DAYS = 1600;
const COMM = TRACK_C_COMMISSION_RT_PCT;

// id (data-file name) → strategy. lab-l07 overwrites the lab strategy's log
// with the long-window version so `audit lab-l07` uses the good data.
const SET: { id: string; strat: CustomStrategy }[] = [
  { id: 'lab-l07', strat: smaTrend('ETHUSDT', 'D', 50) },
  { id: 'daily-btc-sma100', strat: smaTrend('BTCUSDT', 'D', 100) }, // the dropped L08 — re-check honestly
  { id: 'daily-btc-sma50', strat: smaTrend('BTCUSDT', 'D', 50) },
  { id: 'daily-eth-sma100', strat: smaTrend('ETHUSDT', 'D', 100) },
];

function netPct(t: BtTrade[]): number { return t.reduce((a, x) => a + x.realizedPct, 0) - COMM * t.length; }
function pf(t: BtTrade[]): number { let gp = 0, gl = 0; for (const x of t) { const n = x.realizedPct - COMM; if (n >= 0) gp += n; else gl += -n; } return gl === 0 ? Infinity : gp / gl; }

(async () => {
  const now = Date.now();
  const from = now - DAYS * 86_400_000;
  console.log(`Daily trend backtest · ${DAYS}d · native exits + MAE · net of ${COMM}%/trade\n`);
  console.log('id                  sym       N    net%     PF    | walk-forward in→out');
  console.log('-'.repeat(78));
  for (const { id, strat } of SET) {
    const candles = await getKlines(strat.symbol, strat.timeframe, from, now);
    if (candles.length < strat.warmup + 20) { console.log(`${id.padEnd(19)} ${strat.symbol.padEnd(9)} — insufficient klines (${candles.length})`); continue; }
    const trades = runBacktest(strat, candles).tradesLog;
    writeFileSync(resolve('src/strategies/data', `${id}.json`),
      JSON.stringify({ source: 'backtest-engine', symbol: strat.symbol, timeframe: strat.timeframe, generatedAtDays: DAYS, tradesLog: trades }, null, 2));
    const cut = Math.floor(trades.length * 0.7);
    console.log(`${id.padEnd(19)} ${strat.symbol.padEnd(9)} ${String(trades.length).padStart(3)}  ${netPct(trades).toFixed(0).padStart(6)}  ${(Number.isFinite(pf(trades)) ? pf(trades).toFixed(2) : '∞').padStart(5)}  | in ${netPct(trades.slice(0, cut)).toFixed(0)}% out ${netPct(trades.slice(cut)).toFixed(0)}%`);
  }
  console.log('\nNext: pnpm tsx scripts/audit-sl-distribution.ts <id>  → MAE distribution + optimal SL on the REAL sample.');
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * LAB live status — one glance at what each lab strategy is doing RIGHT NOW.
 * For each strategy: fetch klines, run decide() on the latest CLOSED bar
 * with pos=flat, and report the desired action. If a strategy wants long/
 * short but the lab has no open position, the runner should be opening it
 * (or there's a bug); if it wants flat, it's correctly waiting for a setup.
 *
 * Run on the VPS (Bybit klines). Usage: pnpm tsx scripts/lab-status.ts
 */

import { getKlines, intervalStepMs } from '../src/backtest/klines.js';
import { LAB_STRATEGIES } from '../src/strategies/lab-registry.js';

(async () => {
  const now = Date.now();
  console.log('LAB live status · desired action on the latest CLOSED bar (pos=flat)\n');
  console.log('code  id                  sym       tf   closed  lastClose    wants');
  console.log('-'.repeat(72));
  for (const s of LAB_STRATEGIES) {
    const stepMs = intervalStepMs(s.timeframe);
    const lookback = (s.warmup + 60) * stepMs;
    let candles;
    try {
      candles = await getKlines(s.symbol, s.timeframe, now - lookback, now);
    } catch (e) {
      console.log(`${s.code}  ${s.id.padEnd(19)} ${s.symbol.padEnd(9)} ${s.timeframe.padEnd(3)} klines err: ${(e as Error).message}`);
      continue;
    }
    const closed = candles.filter((c) => c.t + stepMs <= now);
    if (closed.length <= s.warmup) {
      console.log(`${s.code}  ${s.id.padEnd(19)} ${s.symbol.padEnd(9)} ${s.timeframe.padEnd(3)} ${String(closed.length).padStart(5)}  ⚠ insufficient (need >${s.warmup})`);
      continue;
    }
    const i = closed.length - 1;
    const wants = s.decide(closed, i, null) ?? 'flat';
    const lastBar = new Date(closed[i]!.t).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`${s.code}  ${s.id.padEnd(19)} ${s.symbol.padEnd(9)} ${s.timeframe.padEnd(3)} ${String(closed.length).padStart(5)}  ${String(closed[i]!.c).padStart(9)}   ${String(wants).toUpperCase()}  (bar ${lastBar})`);
  }
  console.log('\nLONG/SHORT here = runner should hold that position; FLAT = correctly waiting for a setup.');
})().catch((e) => { console.error(e); process.exit(1); });

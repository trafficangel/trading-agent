/**
 * ORDER-FLOW SWEEP + COVERAGE. Loads hl_micro, aligns to klines, and either
 * sweeps the flow templates (cvdDivergence, oiQuadrant) if enough data has
 * accumulated, or reports coverage so we know how long until backtestable.
 * Run on the VPS (needs hl_micro + Bybit klines). pnpm tsx scripts/sweep-flow.ts
 */

import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { cvdDivergence, oiQuadrant } from '../src/backtest/strategies/families-flow.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const MIN_BARS = 120; // backtest only once a coin has this many bars WITH micro data
const FEE = 0.07;

function net(r: number[], fee: number) { let s = 0; for (const x of r) s += x - fee; return Math.round(s * 10) / 10; }

(async () => {
  console.log('=== order-flow coverage (hl_micro aligned to 15m klines) ===');
  let totalWith = 0;
  const ready: { coin: string; bars: number; candles: Candle[]; micro: ReturnType<typeof loadMicroAligned> }[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    let candles: Candle[] = [];
    try { candles = await getKlines(sym, '15', NOW - 7 * 86_400_000, NOW); } catch (e) { console.log(`  ${coin}: klines err ${(e as Error).message}`); continue; }
    const micro = loadMicroAligned(coin, '15', candles);
    totalWith += micro.withData;
    const hrs = (micro.withData * 15 / 60).toFixed(1);
    console.log(`  ${coin.padEnd(5)} bars-with-micro ${String(micro.withData).padStart(4)} (~${hrs}h)  coverage ${(micro.coverage * 100).toFixed(0)}%  ${micro.withData >= MIN_BARS ? '✅ backtestable' : '⏳ accumulating'}`);
    if (micro.withData >= MIN_BARS) ready.push({ coin, bars: micro.withData, candles, micro });
  }

  console.log(`\nTotal bars-with-micro across coins: ${totalWith}. Need ≥${MIN_BARS}/coin to backtest a flow strategy.`);
  if (ready.length === 0) {
    const perDay = SYMBOLS.length * 96; // 96 15m-bars/day/coin
    console.log(`Pipeline OK (loader+templates wired, look-ahead-safe). Not enough data yet — the collector adds ~96 bars/coin/day; ~${Math.ceil((MIN_BARS) / 96)}+ days to first backtest, more for a real verdict. Re-run later.`);
    process.exit(0);
  }

  console.log(`\n=== flow templates on ${ready.length} ready coin(s) — PRELIMINARY (tiny sample) ===`);
  for (const r of ready) {
    for (const mk of [
      { name: 'cvddiv', strat: cvdDivergence(`${r.coin}USDT`, '15', r.micro, 20) },
      { name: 'oiquad', strat: oiQuadrant(`${r.coin}USDT`, '15', r.micro, 1) },
    ]) {
      const slMode = mk.name === 'oiquad' ? { kind: 'time' as const, bars: 8 } : { kind: 'none' as const };
      const pnl = runBacktest(mk.strat, r.candles, slMode).tradesLog.map((t) => t.realizedPct);
      console.log(`  ${r.coin.padEnd(5)} ${mk.name}  N${pnl.length}  net@${FEE} ${net(pnl, FEE)}  (preliminary — far below the kill-battery bar)`);
    }
  }
  console.log('\nNOTE: any numbers here are statistically empty until weeks of data — this run just proves the pipeline reads hl_micro and the templates execute look-ahead-safe.');
})().catch((e) => { console.error(e); process.exit(1); });

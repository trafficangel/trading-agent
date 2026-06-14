/**
 * SMA trend-following — a direct port of the CRYPTO-TREND Phase 0 edge
 * (the one rule that survived adversarial testing: real, robust, beats
 * buy-hold by Sharpe on every window; OOS ETH held, BTC weakened; main
 * durable value = drawdown cut). Research details: Predict repo,
 * research/crypto-trend-phase0/.
 *
 * Rule (long/cash, NO shorts — shorting a crypto trend is how you die):
 *   - LONG when close > SMA(N)
 *   - FLAT (to cash) otherwise
 *
 * This is a TREND follower — structurally uncorrelated with our contrarian
 * book (which fades moves and got crushed in the June downtrend). Forward-
 * tested in the lab on the research assets (BTC/ETH) before any promotion.
 * The exit IS the SMA cross; the safety SL is only catastrophe insurance,
 * so it's intentionally loose (a tight stop would whipsaw the trend out).
 */

import { sma, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

export function smaTrend(opts: {
  id: string;
  code: string;
  symbol: string;
  timeframe?: string;
  period?: number;
  slPct?: number;
}): CustomStrategy {
  const period = opts.period ?? 100;
  let cacheKey: Candle[] | null = null;
  let s: number[] = [];

  function ensure(candles: Candle[]): void {
    if (cacheKey === candles) return;
    s = sma(candles.map((c) => c.c), period);
    cacheKey = candles;
  }

  return {
    id: opts.id,
    code: opts.code,
    name: `${opts.symbol.replace('USDT', '')} SMA${period} Trend`,
    symbol: opts.symbol,
    timeframe: opts.timeframe ?? '240',
    slPct: opts.slPct ?? 0.12,
    warmup: period + 1,
    description: `${opts.symbol} ${opts.timeframe ?? '240'}m | Trend-following: LONG when close>SMA(${period}), else FLAT | long-only`,
    decide(candles: Candle[], i: number, pos: 'long' | 'short' | null): Signal {
      ensure(candles);
      const above = candles[i]!.c > s[i]!;
      if (pos === null) return above ? 'long' : null;
      if (pos === 'long') return above ? null : 'flat';
      return null; // never short
    },
  };
}

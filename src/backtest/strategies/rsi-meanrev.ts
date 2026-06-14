/**
 * Phase U — custom MEAN-REVERSION strategy (no LuxAlgo). Plain RSI(14)
 * with hysteresis:
 *   - enter LONG  when RSI < oversold (default 30)
 *   - enter SHORT when RSI > overbought (default 70)
 *   - exit to FLAT when RSI reverts past the midline (50)
 *
 * This reproduces our contrarian edge on OUR OWN indicators, proving the
 * engine can replace a LuxAlgo strategy 1:1. It is NOT a diversifier
 * (same family as the existing book) — its value is independence + a
 * reference baseline the engine can be trusted against.
 */

import { rsi, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

export function rsiMeanRev(opts: {
  id: string;
  code: string;
  symbol: string;
  timeframe?: string;
  period?: number;
  oversold?: number;
  overbought?: number;
  slPct?: number;
}): CustomStrategy {
  const period = opts.period ?? 14;
  const os = opts.oversold ?? 30;
  const ob = opts.overbought ?? 70;
  let cacheKey: Candle[] | null = null;
  let r: number[] = [];

  function ensure(candles: Candle[]): void {
    if (cacheKey === candles) return;
    r = rsi(candles, period);
    cacheKey = candles;
  }

  return {
    id: opts.id,
    code: opts.code,
    name: `${opts.symbol.replace('USDT', '')} RSI Mean-Rev`,
    symbol: opts.symbol,
    timeframe: opts.timeframe ?? '15',
    slPct: opts.slPct ?? 0.05,
    warmup: period * 3,
    description: `${opts.symbol} ${opts.timeframe ?? '15'}m | RSI(${period}) mean-reversion | LONG: RSI<${os} | SHORT: RSI>${ob} | EXIT: RSI crosses 50`,
    decide(candles: Candle[], i: number, pos: 'long' | 'short' | null): Signal {
      ensure(candles);
      const v = r[i]!;
      if (pos === null) {
        if (v < os) return 'long';
        if (v > ob) return 'short';
        return null;
      }
      if (pos === 'long') return v >= 50 ? 'flat' : null;
      // pos === 'short'
      return v <= 50 ? 'flat' : null;
    },
  };
}

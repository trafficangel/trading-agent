/**
 * Phase U — custom TREND strategy (no LuxAlgo). Classic Donchian / Turtle
 * breakout, always-in flip version:
 *   - go LONG  when close breaks above the prior-N-bar high
 *   - go SHORT when close breaks below the prior-N-bar low
 *   - otherwise hold.
 *
 * This is the diversifier the portfolio lacks: every existing strategy is
 * contrarian (fades moves), so a downtrend month (June) crushed the longs.
 * A breakout follower is structurally UNcorrelated — it rides the trend
 * that kills the contrarians. On a higher TF (1h) to avoid 5m noise.
 *
 * Indicators are memoised on the candle array so decide() is O(1)/bar.
 */

import { donchian, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

export function donchianTrend(opts: {
  id: string;
  code: string;
  symbol: string;
  timeframe?: string;
  period?: number;
  slPct?: number;
}): CustomStrategy {
  const period = opts.period ?? 20;
  let cacheKey: Candle[] | null = null;
  let up: number[] = [];
  let lo: number[] = [];

  function ensure(candles: Candle[]): void {
    if (cacheKey === candles) return;
    const d = donchian(candles, period);
    up = d.upper;
    lo = d.lower;
    cacheKey = candles;
  }

  return {
    id: opts.id,
    code: opts.code,
    name: `${opts.symbol.replace('USDT', '')} Donchian Trend`,
    symbol: opts.symbol,
    timeframe: opts.timeframe ?? '60',
    slPct: opts.slPct ?? 0.05,
    warmup: period + 1,
    description: `${opts.symbol} ${opts.timeframe ?? '60'}m | Donchian(${period}) breakout flip | LONG: close>prior-${period}-high | SHORT: close<prior-${period}-low`,
    decide(candles: Candle[], i: number): Signal {
      ensure(candles);
      const c = candles[i]!.c;
      if (c > up[i]!) return 'long';
      if (c < lo[i]!) return 'short';
      return null;
    },
  };
}

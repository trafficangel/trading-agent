import { logger } from '../lib/logger.js';
import { getBinanceKlines } from '../exchange/binance-public.js';
import type { ExchangeKline } from '../exchange/types.js';

const TTL_MS = 5 * 60 * 1000; // recompute every 5 min — regime doesn't shift faster
const cache = new Map<string, { data: RegimeSnapshot; ts: number }>();

export type RegimeSnapshot = {
  symbol: string;
  /** ATR(14) on the most recent 15m bars, in price units */
  currentAtr: number;
  /** Current ATR's percentile rank within last 7 days of rolling-ATR(14) values */
  atrPercentile: number;
  /** True when we should block new OPEN entries — chop or low-vol regime */
  inChop: boolean;
  /** Percentile threshold below which we mark inChop=true */
  threshold: number;
  fetchedAt: number;
};

const CHOP_PERCENTILE_THRESHOLD = 30;

function computeAtr(klines: ExchangeKline[], window: number): number | null {
  if (klines.length < window + 1) return null;
  const last = klines.slice(-(window + 1));
  let sum = 0;
  for (let i = 1; i < last.length; i++) {
    const cur = last[i]!;
    const prev = last[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sum += tr;
  }
  return sum / window;
}

/** Rolling ATR(14) for every overlapping 15-bar window in `klines`. */
function rollingAtrSeries(klines: ExchangeKline[], window: number): number[] {
  const out: number[] = [];
  if (klines.length < window + 1) return out;
  for (let i = window; i < klines.length; i++) {
    const slice = klines.slice(i - window, i + 1);
    let sum = 0;
    for (let j = 1; j < slice.length; j++) {
      const cur = slice[j]!;
      const prev = slice[j - 1]!;
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      sum += tr;
    }
    out.push(sum / window);
  }
  return out;
}

function percentileRank(value: number, distribution: number[]): number {
  if (distribution.length === 0) return 50;
  let below = 0;
  for (const v of distribution) if (v < value) below++;
  return Math.round((below / distribution.length) * 100);
}

/**
 * Detect whether the current 15m volatility regime is "chop" — measured as
 * ATR(14) sitting below the 30th percentile of the last 7 days of rolling
 * ATR(14) values.
 *
 * Why chop matters: most retail-style intraday losses happen in low-vol
 * ranging conditions where SLs get wicked out by routine noise and TPs
 * don't reach because price doesn't go anywhere. By blocking new entries
 * during chop we cut the worst-EV slice of the distribution.
 *
 * Existing positions are NOT affected — monitor cron continues; this gate
 * only applies to new OPEN attempts.
 */
export async function detectRegime(symbol: string): Promise<RegimeSnapshot | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  // 7 days × 96 bars/day = 672 bars on 15m.
  const klines = await getBinanceKlines(symbol, '15m', 700).catch(() => null);
  if (!klines || klines.length < 100) {
    logger.warn({ symbol, len: klines?.length ?? 0 }, 'regime: insufficient klines');
    return null;
  }

  const currentAtr = computeAtr(klines, 14);
  if (currentAtr === null) return null;

  const series = rollingAtrSeries(klines, 14);
  if (series.length === 0) return null;

  const atrPercentile = percentileRank(currentAtr, series);
  const inChop = atrPercentile < CHOP_PERCENTILE_THRESHOLD;

  const data: RegimeSnapshot = {
    symbol,
    currentAtr: Math.round(currentAtr * 1e6) / 1e6,
    atrPercentile,
    inChop,
    threshold: CHOP_PERCENTILE_THRESHOLD,
    fetchedAt: Date.now(),
  };
  cache.set(symbol, { data, ts: Date.now() });
  return data;
}

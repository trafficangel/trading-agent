import { recentSignals } from '../db/repos/signals.js';
import { scoreEvent, SCORE_THRESHOLD } from './weights.js';
import type { SignalRow } from '../db/repos/signals.js';

/**
 * Sliding confluence window. We weigh signals received within this many ms
 * of the latest webhook on the same symbol.
 *
 * Why 20 min: primary TF is 15m. Bars close on a 15-min cadence, so signals
 * arrive in bursts at bar close. A 10-min window cuts confluence between
 * two adjacent 15m bars (e.g. 15m bullish_plus at 14:00 + 5m confirmation
 * at 14:11 still in window, but a fresh 15m signal at 14:15 would land
 * AFTER the 14:00 signal expired). 20 min covers the current 15m bar plus
 * the previous one in full, without dragging in genuinely stale context.
 */
const WINDOW_MS = 20 * 60 * 1000;

export type AggregatedScore = {
  symbol: string;
  bullish: number;
  bearish: number;
  /** dominant side: 'long' if bullish≥bearish+1, 'short' if reverse, else null */
  side: 'long' | 'short' | null;
  signals: SignalRow[];
  windowStart: number;
  windowEnd: number;
};

export function aggregateSymbol(symbol: string, now: number = Date.now()): AggregatedScore {
  const since = now - WINDOW_MS;
  const allRecent = recentSignals(since);
  const signals = allRecent.filter((s) => s.symbol === symbol);

  let bullish = 0;
  let bearish = 0;
  for (const s of signals) {
    const sc = scoreEvent(s.event, s.timeframe, s.direction);
    bullish += sc.bullish;
    bearish += sc.bearish;
  }

  const diff = bullish - bearish;
  const side: 'long' | 'short' | null = diff >= 1 ? 'long' : diff <= -1 ? 'short' : null;

  return {
    symbol,
    bullish: Math.round(bullish * 100) / 100,
    bearish: Math.round(bearish * 100) / 100,
    side,
    signals,
    windowStart: since,
    windowEnd: now,
  };
}

/**
 * Decide whether the LLM should be invoked given an aggregated score.
 * Threshold is on the *winning* side only (bullish if long, bearish if short).
 */
export function shouldInvokeLlm(agg: AggregatedScore): boolean {
  if (agg.side === null) return false;
  const winning = agg.side === 'long' ? agg.bullish : agg.bearish;
  return winning >= SCORE_THRESHOLD;
}

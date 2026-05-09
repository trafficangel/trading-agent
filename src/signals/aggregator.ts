import { recentSignals } from '../db/repos/signals.js';
import { scoreEvent, SCORE_THRESHOLD } from './weights.js';
import type { SignalRow } from '../db/repos/signals.js';

const WINDOW_MS = 10 * 60 * 1000;

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

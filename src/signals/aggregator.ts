import { recentSignals } from '../db/repos/signals.js';
import type { SignalRow } from '../db/repos/signals.js';

/**
 * Window we report to the LLM. Covers the current 15m bar plus the previous
 * one, so the model sees signals from the last 2 closed bars at any cron
 * tick. Bigger than this and we drag in genuinely stale context.
 */
const WINDOW_MS = 30 * 60 * 1000;

/**
 * Snapshot of what's happening on a symbol in the recent window. Pure data —
 * no judgement, no scoring. The LLM decides if the setup is worth taking.
 *
 * We keep the `bullish`/`bearish`/`side` fields populated (counts of signals
 * by direction) ONLY as a summary for human-readable logs and the Telegram
 * cron summary; they no longer gate the LLM call. Their interpretation is
 * "X bullish events fired in the window" — not "score X".
 */
export type AggregatedScore = {
  symbol: string;
  /** count of bullish-direction signals in window */
  bullish: number;
  /** count of bearish-direction signals in window */
  bearish: number;
  /** which side has more signals; null if equal or both zero */
  side: 'long' | 'short' | null;
  signals: SignalRow[];
  windowStart: number;
  windowEnd: number;
};

const BULLISH_DIRECTIONS: Set<string | null | undefined> = new Set(['up', undefined, null]);
const BEARISH_DIRECTIONS: Set<string | null | undefined> = new Set(['down']);

export function aggregateSymbol(symbol: string, now: number = Date.now()): AggregatedScore {
  const since = now - WINDOW_MS;
  const allRecent = recentSignals(since);
  const signals = allRecent.filter((s) => s.symbol === symbol);

  let bullish = 0;
  let bearish = 0;
  for (const s of signals) {
    if (BULLISH_DIRECTIONS.has(s.direction)) bullish++;
    else if (BEARISH_DIRECTIONS.has(s.direction)) bearish++;
  }

  const diff = bullish - bearish;
  const side: 'long' | 'short' | null = diff > 0 ? 'long' : diff < 0 ? 'short' : null;

  return {
    symbol,
    bullish,
    bearish,
    side,
    signals,
    windowStart: since,
    windowEnd: now,
  };
}

/**
 * Cheap gate: do we have ANY recent signals worth showing the LLM?
 *
 * This replaces the old weighted threshold. Now the LLM is the judge —
 * we just check that something happened recently so we're not burning
 * tokens on empty 15-minute windows.
 */
export function hasRecentActivity(agg: AggregatedScore): boolean {
  return agg.signals.length > 0;
}

/**
 * Legacy name kept so existing callers don't break. Same semantics as
 * hasRecentActivity now: gate is just "is there anything to analyze?".
 */
export function shouldInvokeLlm(agg: AggregatedScore): boolean {
  return hasRecentActivity(agg);
}

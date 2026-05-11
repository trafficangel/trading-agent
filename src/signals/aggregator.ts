import { recentSignals } from '../db/repos/signals.js';
import type { SignalRow } from '../db/repos/signals.js';

/**
 * Maximum lookback to fetch from DB. Anything older than this is gone from
 * the LLM's view regardless of TF. 24h covers the longest per-TF window
 * below (the 24h slot for daily signals).
 */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Per-timeframe retention window for the LLM context.
 *
 * Rationale: a global flat window forces a tradeoff — too short and we
 * lose 1H/4H structural signals (they close every 60/240 min), too long
 * and 5m noise drowns the model. Tiered per-TF gives each TF its own
 * "freshness" budget:
 *   - 5m  → last 30 min  (6 bars; timing-only refinement)
 *   - 15m → last 90 min  (6 bars; primary entry TF, sees recent setup formation)
 *   - 1H  → last 4 hours (4 bars; session-scale trend context)
 *   - 4H  → last 12 hours (3 bars; swing structure)
 *   - 1D  → last 24 hours (1 bar; macro)
 *   - default → 90 min for anything unrecognized
 *
 * The model still sees absolute timestamps so it weighs recency itself —
 * we just limit DB-to-LLM hydration.
 */
const TF_WINDOW_MS: Record<string, number> = {
  '1': 15 * 60 * 1000,
  '3': 20 * 60 * 1000,
  '5': 30 * 60 * 1000,
  '15': 90 * 60 * 1000,
  '30': 3 * 60 * 60 * 1000,
  '60': 4 * 60 * 60 * 1000,
  '240': 12 * 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000,
};
const DEFAULT_TF_WINDOW_MS = 90 * 60 * 1000;

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
  const since = now - MAX_LOOKBACK_MS;
  const allRecent = recentSignals(since);

  // Apply per-TF retention. A 5m signal from 2h ago is stale; a 4H signal
  // from 2h ago is fresh structure.
  const signals = allRecent.filter((s) => {
    if (s.symbol !== symbol) return false;
    const tfWindow = TF_WINDOW_MS[s.timeframe] ?? DEFAULT_TF_WINDOW_MS;
    return now - s.received_at <= tfWindow;
  });

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
    windowStart: now - MAX_LOOKBACK_MS,
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

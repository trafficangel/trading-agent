/**
 * Phase T — pure risk-rule math, no DB / no I/O. Extracted from
 * src/strategies/risk-control.ts so unit tests can exercise the decision
 * logic without opening SQLite (same pattern as lib/pnl.ts).
 *
 * Rules and rationale live in risk-control.ts's header; in one line each:
 *   1. decideBreaker   — 2 SL hits, different symbols, within 24h ⇒ block
 *                        ALL entries until latest hit + 48h.
 *   2. decideCooldown  — after an SL hit a strategy sits out 24h (≤5m TF)
 *                        or 48h (slower TFs).
 *   3. decideProbation — last 10 closed trades net < −5% (incl. 0.11%
 *                        commission each) ⇒ pause; one probe entry
 *                        allowed after 72h of inactivity.
 */

import { TRACK_C_COMMISSION_RT_PCT } from '../strategies/track-c-config.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Breaker: how close two cross-symbol SL hits must be to count as
 *  "correlated" (ms). */
export const BREAKER_PAIR_WINDOW_MS = 24 * 3600_000;
/** Breaker: how long all entries stay blocked after the trip (ms). */
export const BREAKER_BLOCK_MS = 48 * 3600_000;
/** Cool-down after a safety-SL hit, by timeframe (ms). */
export const COOLDOWN_5M_MS = 24 * 3600_000;
export const COOLDOWN_SLOW_MS = 48 * 3600_000;
/** Probation: rolling window size (closed trades). */
export const PROBATION_WINDOW = 10;
/** Probation: net PnL threshold over the window, percent points. */
export const PROBATION_NET_PCT = -5;
/** Probation: idle time after which ONE probe entry is allowed (ms). */
export const PROBATION_PROBE_MS = 72 * 3600_000;

// ---------------------------------------------------------------------------
// Decision functions
// ---------------------------------------------------------------------------

export type SlHitEvent = { symbol: string; closedAt: number };

/** Rule 1 — portfolio circuit breaker.
 *  Trips when two SL hits on DIFFERENT symbols land within
 *  BREAKER_PAIR_WINDOW_MS of each other; stays active until the LATEST
 *  qualifying hit + BREAKER_BLOCK_MS. */
export function decideBreaker(
  hits: SlHitEvent[],
  now: number,
): { blocked: boolean; until: number | null } {
  let until: number | null = null;
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i]!;
      const b = hits[j]!;
      if (a.symbol === b.symbol) continue;
      if (Math.abs(a.closedAt - b.closedAt) > BREAKER_PAIR_WINDOW_MS) continue;
      const tripAt = Math.max(a.closedAt, b.closedAt);
      const blockUntil = tripAt + BREAKER_BLOCK_MS;
      if (until === null || blockUntil > until) until = blockUntil;
    }
  }
  if (until !== null && now < until) return { blocked: true, until };
  return { blocked: false, until: null };
}

/** Rule 2 — per-strategy cool-down after a safety-SL hit. */
export function decideCooldown(
  lastSlHitAt: number | null,
  timeframe: string,
  now: number,
): { blocked: boolean; until: number | null } {
  if (lastSlHitAt === null) return { blocked: false, until: null };
  const tfMin = Number(timeframe);
  const cooldownMs =
    Number.isFinite(tfMin) && tfMin <= 5 ? COOLDOWN_5M_MS : COOLDOWN_SLOW_MS;
  const until = lastSlHitAt + cooldownMs;
  return now < until ? { blocked: true, until } : { blocked: false, until: null };
}

export type ClosedTradeEvent = { pnlPct: number; closedAt: number };

/** Rule 3 — probation. `lastTrades` = most recent closed shadow trades,
 *  newest first, at most PROBATION_WINDOW entries. */
export function decideProbation(
  lastTrades: ClosedTradeEvent[],
  now: number,
): { blocked: boolean; netPct: number | null; probeAt: number | null } {
  if (lastTrades.length < PROBATION_WINDOW) {
    return { blocked: false, netPct: null, probeAt: null };
  }
  const window = lastTrades.slice(0, PROBATION_WINDOW);
  const gross = window.reduce((acc, t) => acc + t.pnlPct, 0);
  const net = gross - PROBATION_WINDOW * TRACK_C_COMMISSION_RT_PCT;
  if (net >= PROBATION_NET_PCT) return { blocked: false, netPct: net, probeAt: null };
  // Window is bad. Allow a single probe entry after PROBATION_PROBE_MS
  // of inactivity; until then — blocked.
  const lastClosedAt = window[0]!.closedAt;
  const probeAt = lastClosedAt + PROBATION_PROBE_MS;
  if (now >= probeAt) return { blocked: false, netPct: net, probeAt };
  return { blocked: true, netPct: net, probeAt };
}

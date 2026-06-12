/**
 * Phase T (Jun 12, 2026) — portfolio risk-control layer for Track C.
 *
 * Born from the June 1–5 post-mortem: 9 of 12 safety-SL hits clustered in
 * four days (June 2 alone stopped out FOUR different coins), erasing the
 * whole month. Each strategy's SL was correctly calibrated for the calm
 * Mar–May regime — the system simply had zero awareness that the regime
 * had changed and kept entering at full exposure.
 *
 * Three mechanical rules, all computed FROM THE decisions TABLE (no new
 * state, crash-safe, replayable):
 *
 *   1. PORTFOLIO CIRCUIT BREAKER — two safety-SL hits on DIFFERENT
 *      symbols within 24h ⇒ correlated market shock ⇒ block ALL new
 *      entries (shadow + fan-out) until latest_hit + 48h. Exits are
 *      never blocked.
 *
 *   2. PER-STRATEGY SL COOL-DOWN — after a safety-SL hit the strategy
 *      sits out 24h (5m TF) / 48h (15m+). Re-entering the same chop
 *      immediately is how hit #1 becomes hit #2; also re-syncs us with
 *      LuxAlgo (which doesn't know about our SL and is still "in
 *      position" on its side).
 *
 *   3. PROBATION (rolling drawdown pause) — last 10 closed shadow trades
 *      net < −5% (incl. commission) ⇒ pause entries. Self-healing probe:
 *      once 72h pass since the last closed trade, ONE entry is allowed;
 *      if it loses the window stays bad and the pause re-arms. No
 *      operator action needed, no deadlock.
 *
 * Shadow entries are blocked too (not only fan-out): the shadow track IS
 * the public track record — protecting it from a regime shock matters as
 * much as protecting user accounts.
 *
 * Pure decision math lives in src/lib/risk-rules.ts (unit-tested without
 * SQLite); this module adds the SQL wrappers, the evaluateEntryRisk()
 * entry point used by strategy-trader, and throttled operator alerts.
 */

import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { enqueueOperatorLog } from '../telegram/log-queue.js';
import {
  decideBreaker,
  decideCooldown,
  decideProbation,
  BREAKER_PAIR_WINDOW_MS,
  BREAKER_BLOCK_MS,
  PROBATION_WINDOW,
  PROBATION_NET_PCT,
  type SlHitEvent,
  type ClosedTradeEvent,
} from '../lib/risk-rules.js';

export {
  decideBreaker,
  decideCooldown,
  decideProbation,
  PROBATION_WINDOW,
} from '../lib/risk-rules.js';

// ---------------------------------------------------------------------------
// SQL wrappers (shadow rows only — user_id IS NULL, track='strategy')
// ---------------------------------------------------------------------------

const slHitsSinceStmt = db.prepare<[number], { symbol: string; closed_at: number }>(`
  SELECT symbol, closed_at
    FROM decisions
   WHERE user_id IS NULL AND track = 'strategy' AND status = 'closed'
     AND strategy_id IS NOT NULL
     AND (close_reason = 'sl_hit' OR force_close_reason = 'sl_hit')
     AND closed_at >= ?
   ORDER BY closed_at
`);

const lastSlHitForStrategyStmt = db.prepare<[string], { closed_at: number }>(`
  SELECT MAX(closed_at) AS closed_at
    FROM decisions
   WHERE user_id IS NULL AND track = 'strategy' AND status = 'closed'
     AND strategy_id = ?
     AND (close_reason = 'sl_hit' OR force_close_reason = 'sl_hit')
`);

const lastClosedForStrategyStmt = db.prepare<[string, number], { pnl_pct: number; closed_at: number }>(`
  SELECT pnl_pct, closed_at
    FROM decisions
   WHERE user_id IS NULL AND track = 'strategy' AND status = 'closed'
     AND strategy_id = ? AND pnl_pct IS NOT NULL AND closed_at IS NOT NULL
   ORDER BY closed_at DESC
   LIMIT ?
`);

export function getRecentShadowSlHits(now: number): SlHitEvent[] {
  // Look back far enough to cover any pair whose block could still be
  // active: pair window + block duration.
  const since = now - (BREAKER_PAIR_WINDOW_MS + BREAKER_BLOCK_MS);
  return slHitsSinceStmt
    .all(since)
    .map((r) => ({ symbol: r.symbol, closedAt: r.closed_at }));
}

export function getLastSlHitForStrategy(strategyId: string): number | null {
  const row = lastSlHitForStrategyStmt.get(strategyId);
  return row?.closed_at ?? null;
}

export function getLastClosedTrades(strategyId: string): ClosedTradeEvent[] {
  return lastClosedForStrategyStmt
    .all(strategyId, PROBATION_WINDOW)
    .map((r) => ({ pnlPct: r.pnl_pct, closedAt: r.closed_at }));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type EntryRiskVerdict =
  | { allowed: true }
  | {
      allowed: false;
      rule: 'circuit_breaker' | 'sl_cooldown' | 'probation';
      untilMs: number | null;
      detail: string;
    };

export function evaluateEntryRisk(args: {
  strategyId: string;
  symbol: string;
  timeframe: string;
  now?: number;
}): EntryRiskVerdict {
  const now = args.now ?? Date.now();

  // Rule 1 — portfolio breaker (checked first: market-wide trumps local).
  const breaker = decideBreaker(getRecentShadowSlHits(now), now);
  if (breaker.blocked) {
    return {
      allowed: false,
      rule: 'circuit_breaker',
      untilMs: breaker.until,
      detail:
        `коррелированные SL-хиты на разных монетах за 24ч — пауза всех входов до ` +
        fmtUntil(breaker.until),
    };
  }

  // Rule 2 — per-strategy cool-down.
  const cooldown = decideCooldown(getLastSlHitForStrategy(args.strategyId), args.timeframe, now);
  if (cooldown.blocked) {
    return {
      allowed: false,
      rule: 'sl_cooldown',
      untilMs: cooldown.until,
      detail: `cool-down после SL-хита — входы заблокированы до ${fmtUntil(cooldown.until)}`,
    };
  }

  // Rule 3 — probation.
  const probation = decideProbation(getLastClosedTrades(args.strategyId), now);
  if (probation.blocked) {
    return {
      allowed: false,
      rule: 'probation',
      untilMs: probation.probeAt,
      detail:
        `последние ${PROBATION_WINDOW} сделок ${probation.netPct!.toFixed(1)}% нетто ` +
        `(порог ${PROBATION_NET_PCT}%) — probe-вход после ${fmtUntil(probation.probeAt)}`,
    };
  }

  return { allowed: true };
}

function fmtUntil(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// ---------------------------------------------------------------------------
// Operator alerting (throttled — a 48h breaker would otherwise fire a log
// for EVERY webhook of EVERY 5m strategy)
// ---------------------------------------------------------------------------

const ALERT_THROTTLE_MS = 6 * 3600_000;
const lastAlertAt = new Map<string, number>();

export function alertRiskBlock(args: {
  strategyId: string;
  symbol: string;
  verdict: Extract<EntryRiskVerdict, { allowed: false }>;
}): void {
  const key = `${args.verdict.rule}:${args.verdict.rule === 'circuit_breaker' ? 'portfolio' : args.strategyId}`;
  const now = Date.now();
  const last = lastAlertAt.get(key) ?? 0;
  logger.warn(
    {
      strategy_id: args.strategyId,
      symbol: args.symbol,
      rule: args.verdict.rule,
      until: args.verdict.untilMs,
    },
    'risk-control: entry blocked',
  );
  if (now - last < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(key, now);
  const ruleLabel =
    args.verdict.rule === 'circuit_breaker'
      ? '⛔️ CIRCUIT BREAKER (весь портфель)'
      : args.verdict.rule === 'sl_cooldown'
        ? '🧊 SL cool-down'
        : '🚧 Probation';
  enqueueOperatorLog(
    `${ruleLabel}\n` +
      `Вход отклонён: <code>${args.strategyId}</code> на ${args.symbol}\n` +
      `${args.verdict.detail}\n` +
      `<i>Выходы и safety SL работают как обычно. Повторные алерты этого правила приглушены на 6ч.</i>`,
  );
}

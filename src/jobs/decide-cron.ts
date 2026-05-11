import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { maybeDecide } from './decide.js';
import { aggregateSymbol } from '../signals/aggregator.js';
import { findActivePosition } from '../db/repos/decisions.js';
import { sendMessage } from '../telegram/bot.js';
import { markTick } from '../lib/health-tracker.js';

/**
 * Scheduled decision pipeline.
 *
 * Replaces the previous event-driven model where each TradingView webhook
 * could trigger a full LLM call. That had two problems:
 *   1. Race condition with cooldown: if 5 webhooks arrived within 200ms at
 *      bar close, only the FIRST triggered the LLM — with the weakest data
 *      slice. Subsequent stronger-confluence webhooks were blocked by the
 *      15-min cooldown. Decision was made on the worst snapshot.
 *   2. Cost variance: LLM calls were unpredictable, depending on webhook
 *      arrival timing rather than market structure.
 *
 * The cron runs 1 min after every 15-min bar close (:01, :16, :31, :46),
 * which gives all webhooks from the just-closed bar time to land. For each
 * enabled symbol we run the same `maybeDecide()` pipeline. A symbol with no
 * signals in the 20-min window triggers nothing (DB query only, no LLM,
 * no screenshots) — so it's safe to enable many symbols up front.
 *
 * Logs:
 *   - per-tick start + duration in journalctl
 *   - per-symbol "would invoke LLM" or "below threshold" events
 *   - Telegram Logs summary ONLY when something LLM-worthy happened
 *     (avoid spamming the channel with empty ticks)
 */

let running = false;

/**
 * Hard timeout per symbol's maybeDecide. If a Playwright session hangs or
 * an Anthropic API call gets stuck, we don't want the whole decide cron
 * locked for hours blocking subsequent ticks (saw a 3-hour stuck tick on
 * 2026-05-11 from a getContext() race condition).
 *
 * 5 minutes is generous: typical decide pass with 5 screenshots + 2 LLM
 * calls + sentiment + orderbook fetches is 60-120 sec. 5 min covers
 * network slowness without false-killing.
 */
const PER_SYMBOL_TIMEOUT_MS = 5 * 60 * 1000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label} > ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SymbolEval = {
  symbol: string;
  bullish: number;
  bearish: number;
  side: 'long' | 'short' | null;
  signalsInWindow: number;
  hasActivePosition: boolean;
  /** True if we attempted to invoke maybeDecide() — note this does NOT
   *  guarantee an LLM call actually happened. maybeDecide has its own
   *  chop / active-position gates that may short-circuit. The actual
   *  LLM outcome shows up as its own Telegram post (OPEN / SKIP / chop). */
  decideAttempted: boolean;
};

async function tick(): Promise<void> {
  if (running) {
    logger.warn('decide cron: previous tick still running, skipping');
    return;
  }
  running = true;
  const t0 = Date.now();
  const now = new Date();
  const tickLabel = `${now.toISOString().slice(11, 16)}Z`;

  try {
    const symbols = config.SYMBOLS;
    logger.info({ symbols, tick: tickLabel }, 'decide cron tick start');

    const evaluations: SymbolEval[] = [];

    for (const symbol of symbols) {
      try {
        // Cheap pre-check: any signals at all in window? If not, no LLM
        // call (saves tokens on empty ticks). Either-side active position
        // is also a reason to be aware in summary, but it's handled by
        // monitor-cron + webhook ad-hoc trigger, not by decide.
        const agg = aggregateSymbol(symbol);
        const hasActive = findActivePosition(symbol) !== null;
        const hasSignals = agg.signals.length > 0;

        evaluations.push({
          symbol,
          bullish: agg.bullish,
          bearish: agg.bearish,
          side: agg.side,
          signalsInWindow: agg.signals.length,
          hasActivePosition: hasActive,
          decideAttempted: hasSignals && !hasActive,
        });

        if (!hasSignals) {
          logger.debug({ symbol }, 'cron: no signals in window, skipping LLM');
          continue;
        }

        // Run full pipeline (screenshots, sentiment, LLM, critique, sizing,
        // risk gate, telegram post). maybeDecide() re-checks active position
        // internally — defensive safety net.
        // Wrapped in timeout so a hung Playwright session or stuck LLM call
        // can't block subsequent ticks indefinitely.
        await withTimeout(
          maybeDecide(symbol),
          PER_SYMBOL_TIMEOUT_MS,
          `maybeDecide(${symbol})`,
        );
      } catch (err) {
        logger.error({ err, symbol }, 'decide cron: maybeDecide failed for symbol');
      }
    }

    const duration = Date.now() - t0;
    const decideAttempts = evaluations.filter((e) => e.decideAttempted).length;
    const activeCount = evaluations.filter((e) => e.hasActivePosition).length;
    const withSignals = evaluations.filter((e) => e.signalsInWindow > 0).length;

    logger.info(
      {
        tick: tickLabel,
        duration_ms: duration,
        symbols_checked: symbols.length,
        symbols_with_signals: withSignals,
        decide_attempts: decideAttempts,
        active_positions: activeCount,
      },
      'decide cron tick complete',
    );

    // Telegram Logs: post a summary only when SOMETHING is worth reporting
    // (signals exist OR active position present). Otherwise silent — the
    // 4h heartbeat already covers "alive" pings, and we don't want 96
    // empty-tick messages per day.
    //
    // Note: we do NOT claim "LLM was invoked" here, because maybeDecide()
    // has internal gates (chop, etc.) that may short-circuit AFTER this
    // summary is composed. The actual LLM outcome shows up as its own
    // Telegram post (the OPEN/SKIP/MODIFY caption, chop SKIP note, etc.).
    // This summary is "context check" — what was the state at tick time.
    if (withSignals > 0 || activeCount > 0) {
      const lines = [`🔄 <b>cron ${tickLabel}</b> · ${duration}мс`];
      for (const e of evaluations) {
        if (e.signalsInWindow === 0 && !e.hasActivePosition) continue;
        // ⚡ = there's signal activity → maybeDecide will run its gates
        // 🛡 = active position → handled by monitor + ad-hoc trigger
        const tag = e.decideAttempted
          ? '⚡ activity'
          : e.hasActivePosition
            ? '🛡 active'
            : '·';
        const sideEmoji = e.side === 'long' ? '🟢' : e.side === 'short' ? '🔴' : '·';
        lines.push(
          `  ${tag} ${e.symbol} ${sideEmoji} bull <code>${e.bullish}</code> / bear <code>${e.bearish}</code> · ${e.signalsInWindow} сигналов`,
        );
      }
      await sendMessage({
        channel: 'logs',
        text: lines.join('\n'),
        disable_notification: true,
      }).catch((err) => logger.error({ err }, 'cron summary send failed'));
    }
  } finally {
    running = false;
    // Mark tick AFTER running flag is cleared. Even if the tick had errors
    // on some symbols, we made a pass — health watchdog cares about
    // "the cron is alive", not "every symbol succeeded".
    markTick('decide');
  }
}

export function startDecideCronJob(): void {
  // Run 1 min after each 15-min bar close. The 1-min lag is to let
  // TradingView webhooks arrive (we've measured TV alerts deliver within
  // ~5-30 sec of bar close).
  cron.schedule('1,16,31,46 * * * *', () => {
    void tick();
  });
  logger.info('decide cron started (1,16,31,46 of every hour, 15m-aligned)');
}

/** Exposed for tests + manual smoke-runs from CLI. */
export const _internal = { tick };

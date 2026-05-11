import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { maybeDecide } from './decide.js';
import { aggregateSymbol } from '../signals/aggregator.js';
import { findActiveOnSide } from '../db/repos/decisions.js';
import { sendMessage } from '../telegram/bot.js';

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

type SymbolEval = {
  symbol: string;
  bullish: number;
  bearish: number;
  side: 'long' | 'short' | null;
  signalsInWindow: number;
  hasActivePosition: boolean;
  /** true if this symbol's score crossed the LLM threshold (LLM was invoked) */
  llmCandidate: boolean;
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
        const activeLong = findActiveOnSide(symbol, 'long');
        const activeShort = findActiveOnSide(symbol, 'short');
        const hasActive = activeLong !== null || activeShort !== null;
        const hasSignals = agg.signals.length > 0;

        evaluations.push({
          symbol,
          bullish: agg.bullish,
          bearish: agg.bearish,
          side: agg.side,
          signalsInWindow: agg.signals.length,
          hasActivePosition: hasActive,
          // "candidate" now just means there's enough activity to ask the LLM.
          // The LLM decides if it's actually OPEN-worthy.
          llmCandidate: hasSignals && !hasActive,
        });

        if (!hasSignals) {
          logger.debug({ symbol }, 'cron: no signals in window, skipping LLM');
          continue;
        }

        // Run full pipeline (screenshots, sentiment, LLM, critique, sizing,
        // risk gate, telegram post). maybeDecide() re-checks active position
        // internally — defensive safety net.
        await maybeDecide(symbol);
      } catch (err) {
        logger.error({ err, symbol }, 'decide cron: maybeDecide failed for symbol');
      }
    }

    const duration = Date.now() - t0;
    const llmCalled = evaluations.filter((e) => e.llmCandidate).length;
    const activeCount = evaluations.filter((e) => e.hasActivePosition).length;

    logger.info(
      {
        tick: tickLabel,
        duration_ms: duration,
        symbols_checked: symbols.length,
        llm_invoked: llmCalled,
        active_positions: activeCount,
      },
      'decide cron tick complete',
    );

    // Telegram Logs: post a summary only when SOMETHING actionable happened
    // (LLM invocation OR active position present). Otherwise silent — the
    // 4h heartbeat already covers "alive" pings, and we don't want to spam
    // 96 empty-tick messages per day.
    if (llmCalled > 0 || activeCount > 0) {
      const lines = [`🔄 <b>cron ${tickLabel}</b> · ${duration}мс`];
      for (const e of evaluations) {
        if (e.signalsInWindow === 0 && !e.hasActivePosition) continue;
        const tag = e.llmCandidate ? '🧠 LLM' : e.hasActivePosition ? '🛡 active' : '·';
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

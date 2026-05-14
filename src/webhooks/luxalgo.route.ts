import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { parseLuxAlgoWebhook } from './luxalgo.schema.js';
import { insertSignal } from '../db/repos/signals.js';
import { sendMessage } from '../telegram/bot.js';
import { rawSignalLog } from '../telegram/templates.js';
import { logger } from '../lib/logger.js';
import { findActiveOrPendingByTrack } from '../db/repos/decisions.js';
import { monitorPosition } from '../jobs/monitor.js';
import { maybeTriggerSignalTrade } from '../signals/signal-trader.js';
import { maybeCounterExit } from '../signals/counter-exit.js';
import { handleStrategyWebhook } from '../strategies/strategy-trader.js';

/**
 * Throttle ad-hoc monitor triggers per symbol. A new signal arriving on an
 * active-position symbol should re-evaluate immediately — but if 5 signals
 * land in 30 seconds at bar close, we don't want 5 full monitor passes
 * (each costs ~$0.10 + 5 screenshots + 6 API calls).
 */
const adHocCooldown = new Map<string, number>();
const AD_HOC_COOLDOWN_MS = 5 * 60 * 1000;

// Periodic cleanup of stale cooldown entries. In practice the Map is
// bounded by the number of distinct trading symbols (<20), so leaking
// entries isn't a real problem — but explicit cleanup avoids the "this
// Map has 47 entries because process has been up for 3 weeks" surprise.
setInterval(() => {
  const cutoff = Date.now() - AD_HOC_COOLDOWN_MS;
  for (const [sym, ts] of adHocCooldown) {
    if (ts < cutoff) adHocCooldown.delete(sym);
  }
}, 60_000).unref();

export async function luxalgoRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { secret: string }; Body: unknown }>(
    '/webhook/luxalgo/:secret',
    async (req, reply) => {
      if (req.params.secret !== config.WEBHOOK_SECRET) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      const parsed = parseLuxAlgoWebhook(req.body);
      if (!parsed.success) {
        logger.warn({ issues: parsed.issues, body: req.body }, 'invalid webhook payload');
        return reply.code(400).send({ ok: false, error: 'invalid_payload', issues: parsed.issues });
      }

      // === TRACK C path — LuxAlgo Strategy Builder webhook ===
      // Dispatched BEFORE the legacy event-alert path. Track C webhooks
      // have a different shape and semantics: they don't go to the signals
      // table (dedup-key wouldn't match), don't trigger Track A's ad-hoc
      // monitor, don't trigger Track B's signal-trader or counter-exit.
      // All Track C logic lives in strategy-trader.
      if (parsed.data.kind === 'strategy') {
        const r = await handleStrategyWebhook(parsed.data);
        return reply.send({ ok: r.ok, reason: r.reason, id: r.decisionId });
      }

      // === LEGACY event-alert path (Track A + B) ===
      // parsed.data.kind === 'event' here. Strip the kind marker so
      // insertSignal + downstream signal handlers see the original shape.
      const { kind: _kind, ...eventPayload } = parsed.data;
      void _kind;

      const result = insertSignal(eventPayload, req.body);
      if (!result.inserted) {
        logger.debug({ symbol: eventPayload.symbol, event: eventPayload.event }, 'duplicate signal');
        return reply.send({ ok: true, deduplicated: true });
      }

      logger.info(
        { id: result.id, symbol: eventPayload.symbol, event: eventPayload.event },
        'signal stored',
      );

      sendMessage({ channel: 'logs', text: rawSignalLog(eventPayload, req.body), disable_notification: true })
        .catch((err) => logger.error({ err }, 'telegram log push failed'));

      // === TRACK B — pure-signal trader ===
      // Fire-and-forget. The signal-trader checks SIGNAL_TRADER_ENABLED
      // internally and silently no-ops when the flag is off, so this is
      // safe to call unconditionally. Runs INSTEAD of waiting for the
      // 15m decide cron — that's the whole "event-driven" point of Track B.
      void maybeTriggerSignalTrade(eventPayload).catch((err) =>
        logger.error({ err, symbol: eventPayload.symbol }, 'signal-trader: trigger failed'),
      );

      // === TRACK B — counter-signal early-exit ===
      // If the incoming signal REVERSES the active Track B thesis on this
      // symbol, force-close the position at market. See src/signals/counter-exit.ts
      // for the rules (structural reversal on same/higher TF, or major
      // signal on strictly higher TF). No-op when no active Track B
      // position exists. NOTE: Track C positions are IMMUNE — counter-exit
      // queries track='signal' only.
      void maybeCounterExit(eventPayload).catch((err) =>
        logger.error({ err, symbol: eventPayload.symbol }, 'counter-exit: failed'),
      );

      // Ad-hoc monitor trigger for ACTIVE LLM-track positions only.
      // Track B (signal) positions are intentionally NOT re-evaluated
      // by Claude — they run on pure rules so the A/B test stays clean.
      // New OPEN candidates wait for the 15m decide-cron. But if we
      // already have a live LLM-track position on this symbol, a fresh
      // signal — especially one against our direction — should
      // re-evaluate immediately rather than wait up to 15 min.
      //
      // Throttled per-symbol (5 min) to bound LLM cost when signals burst.
      const sym = eventPayload.symbol;
      const active = findActiveOrPendingByTrack(sym, 'llm');
      if (active && active.status === 'active') {
        const last = adHocCooldown.get(sym) ?? 0;
        if (Date.now() - last >= AD_HOC_COOLDOWN_MS) {
          adHocCooldown.set(sym, Date.now());
          logger.info(
            { symbol: sym, position_id: active.id, event: eventPayload.event },
            'ad-hoc monitor trigger — signal arrived on active position',
          );
          // Fire and forget — webhook response shouldn't wait for the LLM.
          monitorPosition(active).catch((err) =>
            logger.error({ err, position_id: active.id }, 'ad-hoc monitorPosition failed'),
          );
        } else {
          logger.debug(
            { symbol: sym, ms_since_last: Date.now() - last },
            'ad-hoc monitor: cooldown active, skipping',
          );
        }
      }

      return reply.send({ ok: true, id: result.id });
    },
  );
}

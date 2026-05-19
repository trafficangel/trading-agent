import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { parseLuxAlgoWebhook } from './luxalgo.schema.js';
import { sendMessage } from '../telegram/bot.js';
import { logger } from '../lib/logger.js';
import { handleStrategyWebhook, formatStrategyWebhookLog } from '../strategies/strategy-trader.js';

/**
 * Audit H-NEW-2 — constant-time secret comparison. `req.params.secret`
 * is attacker-controlled; `===` leaks comparison position via timing.
 * Negligible at our scale, but free to fix and means brute-force
 * attempts can't probe character-by-character.
 */
function constTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function luxalgoRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { secret: string }; Body: unknown }>(
    '/webhook/luxalgo/:secret',
    {
      // Audit H-NEW-2 — tight body limit. TradingView webhooks are
      // ~500 bytes JSON; 8KB is generous headroom. Without an
      // override, the global server limit (256KB) makes a malicious
      // unauth POST consume ~32× more memory per request.
      bodyLimit: 8 * 1024,
      // Per-IP rate-limit. The secret is 32+ hex chars — practically
      // unguessable — but if it ever leaks, throttle gives us time
      // to rotate. Also bounds log noise from misconfigured TV alerts.
      // TradingView itself fires <30/min in practice; 60/min is
      // headroom for retries. Limit is keyed on IP, not secret, so
      // a real alert from TradingView's egress range still fits.
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      if (!constTimeEqualStr(req.params.secret, config.WEBHOOK_SECRET)) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      const parsed = parseLuxAlgoWebhook(req.body);
      if (!parsed.success) {
        logger.warn({ issues: parsed.issues, body: req.body }, 'invalid webhook payload');
        return reply.code(400).send({ ok: false, error: 'invalid_payload', issues: parsed.issues });
      }

      // === TRACK C path — LuxAlgo Strategy Builder webhook ===
      if (parsed.data.kind === 'strategy') {
        const r = await handleStrategyWebhook(parsed.data);
        // Mirror every Track C webhook to the Logs channel — operator
        // sees every incoming signal regardless of outcome (accepted,
        // duplicate, unknown strategy, etc.). disable_notification so
        // the channel doesn't ping for routine traffic.
        let tradeNum: number | null = null;
        if (r.decisionId) {
          const { findDecisionById } = await import('../db/repos/decisions.js');
          tradeNum = findDecisionById(r.decisionId)?.strategy_trade_num ?? null;
        }
        const logText = formatStrategyWebhookLog(parsed.data, r, tradeNum);
        sendMessage({ channel: 'logs', text: logText, disable_notification: true })
          .catch((err) => logger.error({ err }, 'telegram log push (track c) failed'));
        return reply.send({ ok: r.ok, reason: r.reason, id: r.decisionId });
      }

      // === Legacy event-alert path (Tracks A + B, deprecated) ===
      // Tracks A (LLM) and B (signal-trader) were removed in May 2026.
      // Any TradingView alert still using the old event-shape payload
      // returns 200 to avoid TV retry storms, but no signal is stored
      // and no decision is taken. Operator should migrate the alert to
      // a `kind:"strategy"` payload — see docs/luxalgo-strategy-alerts.md.
      logger.warn(
        { symbol: parsed.data.symbol, event: parsed.data.event, source: parsed.data.source },
        'webhook: legacy event-alert received — deprecated, ignored (Tracks A/B removed)',
      );
      return reply.send({ ok: true, deprecated: true });
    },
  );
}

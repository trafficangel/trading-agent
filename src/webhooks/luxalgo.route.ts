import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { LuxAlgoPayload } from './luxalgo.schema.js';
import { insertSignal } from '../db/repos/signals.js';
import { sendMessage } from '../telegram/bot.js';
import { rawSignalLog } from '../telegram/templates.js';
import { logger } from '../lib/logger.js';

export async function luxalgoRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { secret: string }; Body: unknown }>(
    '/webhook/luxalgo/:secret',
    async (req, reply) => {
      if (req.params.secret !== config.WEBHOOK_SECRET) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      const parsed = LuxAlgoPayload.safeParse(req.body);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues, body: req.body }, 'invalid webhook payload');
        return reply.code(400).send({ ok: false, error: 'invalid_payload', issues: parsed.error.issues });
      }

      const result = insertSignal(parsed.data, req.body);
      if (!result.inserted) {
        logger.debug({ symbol: parsed.data.symbol, event: parsed.data.event }, 'duplicate signal');
        return reply.send({ ok: true, deduplicated: true });
      }

      logger.info(
        { id: result.id, symbol: parsed.data.symbol, event: parsed.data.event },
        'signal stored',
      );

      sendMessage({ channel: 'logs', text: rawSignalLog(parsed.data, req.body), disable_notification: true })
        .catch((err) => logger.error({ err }, 'telegram log push failed'));

      return reply.send({ ok: true, id: result.id });
    },
  );
}

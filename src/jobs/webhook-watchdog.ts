/**
 * Webhook silence watchdog. LuxAlgo strategy webhooks went dark for ~3 days
 * in June before anyone noticed (it killed all trading + shadow validation).
 * This catches it in an hour: if no strategy webhook has produced a decision
 * in > THRESHOLD hours, ping the operator on the Logs channel.
 *
 * "Last webhook" = MAX(created_at) of shadow strategy decisions (each entry
 * signal writes one). Normal cadence is a signal every ~3h (p90 ~9h, all-time
 * max gap ~25h over 30d), so 18h is well past normal variance without being
 * trigger-happy. Re-alerts at most every 12h while silent; auto-clears (and
 * posts a recovery note) once webhooks resume.
 */

import cron from 'node-cron';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

const SILENCE_THRESHOLD_H = 18;
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const lastWebhookStmt = db.prepare<[], { ts: number | null }>(
  "SELECT MAX(created_at) AS ts FROM decisions WHERE track = 'strategy' AND user_id IS NULL",
);

let lastAlertAt = 0;
let alerting = false;

function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

async function check(): Promise<void> {
  const last = lastWebhookStmt.get()?.ts ?? null;
  if (last === null) return; // no strategy decisions ever — nothing to watch yet
  const now = Date.now();
  const hours = (now - last) / 3_600_000;

  if (hours >= SILENCE_THRESHOLD_H) {
    if (now - lastAlertAt < REALERT_COOLDOWN_MS) return;
    lastAlertAt = now;
    alerting = true;
    const text =
      `⚠️ <b>Вебхуки LuxAlgo молчат ${hours.toFixed(0)}ч</b>\n` +
      `Последний сигнал: ${fmt(last)}.\n` +
      `Норма — сигнал каждые ~3ч. Проверь панель алертов LuxAlgo (активны/не истекли) и что доставка идёт. ` +
      `Наша сторона принимает вебхуки штатно — обрыв на стороне источника.`;
    await sendMessage({ channel: 'logs', text }).catch((err) => logger.error({ err }, 'webhook-watchdog: telegram send failed'));
    logger.warn({ hours: +hours.toFixed(1), last }, 'webhook-watchdog: SILENCE alert sent');
    return;
  }

  // Webhooks flowing again — clear state and (if we'd been alerting) say so.
  if (alerting) {
    alerting = false;
    lastAlertAt = 0;
    await sendMessage({ channel: 'logs', text: `✅ Вебхуки LuxAlgo возобновились (последний сигнал ${fmt(last)}).` })
      .catch((err) => logger.error({ err }, 'webhook-watchdog: telegram send failed'));
    logger.info('webhook-watchdog: webhooks resumed');
  } else {
    lastAlertAt = 0;
  }
}

export function startWebhookWatchdog(): void {
  cron.schedule('7 * * * *', () => { void check(); }); // hourly, offset to avoid the top-of-hour pileup
  logger.info({ thresholdH: SILENCE_THRESHOLD_H }, 'webhook-watchdog scheduled (hourly)');
}

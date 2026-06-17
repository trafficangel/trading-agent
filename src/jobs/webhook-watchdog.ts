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
import { getRuntimeConfig } from '../db/repos/runtime-config.js';

const SILENCE_THRESHOLD_H = 18;
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// "Last EXECUTED signal" = newest shadow strategy decision (an entry that passed
// the risk gate and produced a row).
const lastWebhookStmt = db.prepare<[], { ts: number | null }>(
  "SELECT MAX(created_at) AS ts FROM decisions WHERE track = 'strategy' AND user_id IS NULL",
);

let lastAlertAt = 0;
let alerting = false;

function fmt(ms: number | null): string {
  return ms === null ? 'никогда' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

async function check(): Promise<void> {
  // executed = last entry that produced a shadow decision; seen = last entry
  // webhook that ARRIVED (heartbeat from strategy-trader, written before the
  // risk gate). executed stale + seen fresh ⇒ our risk-control is blocking, NOT
  // a source outage — the distinction the old single-metric watchdog got wrong.
  const lastExecuted = lastWebhookStmt.get()?.ts ?? null;
  const seenRaw = getRuntimeConfig('last_strategy_entry_seen');
  const lastSeen = seenRaw ? Number(seenRaw) : null;
  if (lastExecuted === null && lastSeen === null) return; // nothing ever — nothing to watch yet

  const now = Date.now();
  const execH = lastExecuted === null ? Infinity : (now - lastExecuted) / 3_600_000;

  // Healthy: entries are flowing all the way into shadow decisions.
  if (execH < SILENCE_THRESHOLD_H) {
    if (alerting) {
      alerting = false;
      lastAlertAt = 0;
      await sendMessage({ channel: 'logs', text: `✅ Вебхуки LuxAlgo возобновились (последний исполненный сигнал ${fmt(lastExecuted)}).` })
        .catch((err) => logger.error({ err }, 'webhook-watchdog: telegram send failed'));
      logger.info('webhook-watchdog: webhooks resumed');
    } else {
      lastAlertAt = 0;
    }
    return;
  }

  // No executed entry in > threshold → trading is paused. Tell the operator WHY.
  if (now - lastAlertAt < REALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  alerting = true;
  const seenH = lastSeen === null ? Infinity : (now - lastSeen) / 3_600_000;
  const blockedNotSilent = seenH < SILENCE_THRESHOLD_H; // webhooks ARE still arriving
  const text = blockedNotSilent
    ? `⚠️ <b>Входы LuxAlgo не исполняются ${execH.toFixed(0)}ч — их режет НАШ риск-контроль, не источник.</b>\n` +
      `Вебхуки приходят штатно (последний ${fmt(lastSeen)}), но circuit breaker / probation / SL-cooldown блокируют входы → сделок и shadow-записей нет.\n` +
      `Последний исполненный сигнал: ${fmt(lastExecuted)}. Это снимется само по истечении блока — проверь <code>scripts/risk-status.ts</code>.`
    : `⚠️ <b>Вебхуки LuxAlgo молчат ${execH.toFixed(0)}ч</b>\n` +
      `Вебхуки не приходят вовсе (последний ${fmt(lastSeen)}). Последний сигнал: ${fmt(lastExecuted)}.\n` +
      `Норма — сигнал каждые ~3ч. Проверь панель алертов LuxAlgo (активны/не истекли) и доставку. Наша сторона принимает вебхуки штатно — обрыв на стороне источника.`;
  await sendMessage({ channel: 'logs', text }).catch((err) => logger.error({ err }, 'webhook-watchdog: telegram send failed'));
  logger.warn(
    { execH: +execH.toFixed(1), seenH: seenH === Infinity ? null : +seenH.toFixed(1), blockedNotSilent, lastExecuted, lastSeen },
    'webhook-watchdog: SILENCE alert sent',
  );
}

export function startWebhookWatchdog(): void {
  cron.schedule('7 * * * *', () => { void check(); }); // hourly, offset to avoid the top-of-hour pileup
  logger.info({ thresholdH: SILENCE_THRESHOLD_H }, 'webhook-watchdog scheduled (hourly)');
}

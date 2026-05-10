import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';

/**
 * Detect Anthropic billing/quota errors and notify Telegram Logs channel.
 *
 * Billing failures are particularly nasty because the bot keeps "running"
 * — webhooks come in, decide.ts is invoked — but every LLM call returns
 * an error which the existing retry logic treats as a transient API
 * failure. Eventually it falls through to a SKIP fallback. We'd like to
 * KNOW when this happens, ideally within seconds.
 *
 * Anthropic returns billing errors as:
 *   - HTTP 400 with type="invalid_request_error" and message containing
 *     "credit balance" or "billing"
 *   - HTTP 402 (rare; legacy)
 *   - HTTP 429 with message about quota/limit (overlaps with rate-limit;
 *     we filter for explicit "credit"/"billing"/"quota" wording)
 *
 * Throttle: at most one alert per ALERT_THROTTLE_MS (default 1h) so we
 * don't spam if every webhook trips the same error.
 */

const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1h
let lastAlertAt = 0;

const BILLING_KEYWORDS = [
  'credit balance',
  'credit_balance',
  'insufficient',
  'billing',
  'quota',
  'payment required',
  'plan does not allow',
];

function looksLikeBillingError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; message?: string; error?: { message?: string; type?: string } };

  // HTTP 402 = explicit "Payment Required"
  if (e.status === 402) return true;

  const msg = (
    (e.message ?? '') +
    ' ' +
    (e.error?.message ?? '')
  ).toLowerCase();
  if (BILLING_KEYWORDS.some((kw) => msg.includes(kw))) return true;

  return false;
}

/**
 * Call from any catch block where Anthropic SDK errors might land. Returns
 * true if a billing alert was sent (so caller can short-circuit retry loops
 * — no point retrying when the wallet's empty).
 */
export async function maybeNotifyBillingError(err: unknown, context: string): Promise<boolean> {
  if (!looksLikeBillingError(err)) return false;

  const now = Date.now();
  if (now - lastAlertAt < ALERT_THROTTLE_MS) {
    logger.warn({ context }, 'billing error detected but alert throttled');
    return true; // still treated as billing — caller should stop retrying
  }
  lastAlertAt = now;

  const e = err as { status?: number; message?: string; error?: { message?: string } };
  const status = e.status ?? 'n/a';
  const message = e.error?.message ?? e.message ?? String(err);
  const truncated = message.length > 200 ? message.slice(0, 200) + '…' : message;

  logger.error({ status, message, context }, 'ANTHROPIC BILLING ERROR — alerting Telegram');

  await sendMessage({
    channel: 'logs',
    text:
      `💸 <b>ANTHROPIC API: проблема с биллингом</b>\n` +
      `Контекст: <code>${context}</code>\n` +
      `Статус: <code>${status}</code>\n` +
      `Сообщение: <code>${truncated.replace(/[<>&]/g, '')}</code>\n\n` +
      `LLM-вызовы будут проваливаться пока не пополнишь баланс на console.anthropic.com.\n` +
      `Бот продолжает принимать webhook'и и писать сигналы в БД, но решения LLM работать не будут.\n\n` +
      `Алерт повторится не чаще раза в час.`,
  }).catch((notifyErr) => {
    logger.error({ notifyErr }, 'failed to send billing alert to Telegram');
  });

  return true;
}

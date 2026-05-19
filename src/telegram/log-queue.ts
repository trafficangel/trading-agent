/**
 * Telegram Logs-channel batch queue (audit H1).
 *
 * Problem this solves: when N concurrent users hit the same incident
 * (market crash → 50 users go insufficient_balance in the same minute,
 * or one buggy strategy fires → 50 fan-out errors), each call site
 * fires its own alertOperator → 50 sendMessage in ~1 second → Telegram
 * 429 rate-limit → critical alerts get dropped on the floor.
 *
 * Solution: enqueue non-critical operator logs here. The queue waits
 * up to FLUSH_MS to collect siblings, then sends one digest message.
 * Single message ≤ 4000 chars per Telegram limit; if exceeded we split.
 *
 * What goes here: per-user fan-out warnings, insufficient_balance
 * notifications, single-trade order failures, recovery notices.
 * What does NOT go here: critical events (decrypt failure, emergency
 * close, SL attach failed) — those keep calling sendMessage directly
 * with `disable_notification: false` so the operator gets pinged.
 *
 * Cost: at most one Telegram send per FLUSH_MS window. With 50 events
 * in one second, 50 → 1 message. Operator reads one digest instead of
 * scrolling through 50.
 */

import { sendMessage } from './bot.js';
import { logger } from '../lib/logger.js';

const FLUSH_MS = 1500;
const MAX_BUFFERED = 200;
/** Telegram message text limit is 4096 chars; leave 96 for header. */
const MAX_TEXT_LEN = 4000;

const buf: string[] = [];
let timer: NodeJS.Timeout | null = null;

export function enqueueOperatorLog(text: string): void {
  if (buf.length >= MAX_BUFFERED) {
    // Drop oldest to keep the latest events visible. Operator can read
    // pino logs for the full sequence if needed.
    buf.shift();
  }
  buf.push(text);
  if (timer !== null) return;
  timer = setTimeout(flush, FLUSH_MS);
}

async function flush(): Promise<void> {
  timer = null;
  if (buf.length === 0) return;
  const items = buf.splice(0, buf.length);

  // Single event → send it as-is (no digest noise).
  if (items.length === 1) {
    await sendMessage({
      channel: 'logs',
      text: items[0]!,
      disable_notification: true,
    }).catch((err) => {
      logger.error({ err }, 'telegram log-queue flush (single) failed');
    });
    return;
  }

  // Multiple → digest. Split on MAX_TEXT_LEN boundaries to honour
  // Telegram's 4096-char limit.
  const header = `📦 Batch · ${items.length} events`;
  const chunks: string[] = [];
  let current = header;
  for (const item of items) {
    const next = current + '\n\n' + item;
    if (next.length > MAX_TEXT_LEN) {
      chunks.push(current);
      current = '… (продолжение)\n\n' + item;
    } else {
      current = next;
    }
  }
  chunks.push(current);

  for (const chunk of chunks) {
    await sendMessage({
      channel: 'logs',
      text: chunk,
      disable_notification: true,
    }).catch((err) => {
      logger.error({ err }, 'telegram log-queue flush (digest) failed');
    });
  }
}

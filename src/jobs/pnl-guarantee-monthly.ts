/**
 * Monthly PnL-guarantee sweeper (TRACK E Phase E2).
 *
 * Runs once on the 1st of each calendar month at 00:05 UTC.
 * For every PAYING user (status='active', paid_started_at set, started
 * before the start of the previous month):
 *   1. Sum closed user-decision PnL across the EVALUATED month
 *      (the month that just ended).
 *   2. If sum < 0 → grant a free month by extending access_until +30 days
 *      via applyPnlGuarantee(). Stamp last_pnl_guarantee_month for
 *      idempotency. Send Telegram to operator + (future: to user DM).
 *
 * Per-user accounting (not operator-aggregate): user A can get the
 * guarantee independently of users B, C. Marketing pitch is fair and
 * client-oriented — «если ТВОЙ месяц убыточный, следующий бесплатно».
 *
 * Guarded against double-fire by `last_pnl_guarantee_month` check inside
 * listPnlGuaranteeCandidates. So if the cron crashes mid-tick we can
 * safely re-run it.
 *
 * VIP plan users are excluded (success-fee model has its own logic, not
 * implemented yet). VIP override fields skip this entire flow.
 */

import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { db } from '../db/client.js';
import { sendLegacyMessage } from '../telegram/bot.js';
import {
  applyPnlGuarantee,
  listPnlGuaranteeCandidates,
  type SubscriptionRow,
} from '../db/repos/user-subscriptions.js';

let running = false;

type ClosedPnlRow = { user_id: number; pnl_usd: number | null; trades: number };

/** Sum PnL in USD across closed user-decisions within [start, end) for
 *  a given user. Computes pnl_usd on the fly from bybit_qty * (close-entry).
 *  Closed positions only (status='closed'), strategy track. */
const sumUserPnlStmt = db.prepare<[number, number, number], ClosedPnlRow>(`
  SELECT user_id,
         SUM(
           bybit_qty * (bybit_close_avg_price - bybit_avg_price) *
           CASE WHEN side = 'long' THEN 1 ELSE -1 END
         ) AS pnl_usd,
         COUNT(*) AS trades
    FROM decisions
   WHERE user_id = ?
     AND status = 'closed'
     AND track = 'strategy'
     AND closed_at >= ?
     AND closed_at < ?
     AND bybit_qty IS NOT NULL
     AND bybit_avg_price IS NOT NULL
     AND bybit_close_avg_price IS NOT NULL
   GROUP BY user_id
`);

/** Compute month boundaries for "previous calendar month" relative to `now`. */
export function prevMonthBoundaries(now: Date): {
  start: number; end: number; yyyymm: string;
} {
  // First of current month, then back 1 month for start; first of current month is the end (exclusive).
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
  const end = Date.UTC(y, m, 1, 0, 0, 0, 0);
  const startDate = new Date(start);
  const yy = startDate.getUTCFullYear();
  const mm = String(startDate.getUTCMonth() + 1).padStart(2, '0');
  return { start, end, yyyymm: `${yy}-${mm}` };
}

async function evaluateMonth(now = new Date()): Promise<void> {
  if (running) {
    logger.warn('pnl-guarantee: tick already running, skipping');
    return;
  }
  running = true;
  try {
    const bounds = prevMonthBoundaries(now);
    logger.info({ bounds }, 'pnl-guarantee: sweep start');
    const candidates = listPnlGuaranteeCandidates(bounds.start, bounds.yyyymm);
    if (candidates.length === 0) {
      logger.info({ month: bounds.yyyymm }, 'pnl-guarantee: no eligible users');
      return;
    }
    const counters = { granted: 0, positive: 0, neutral: 0 };
    for (const sub of candidates) {
      try {
        const outcome = await evaluateUser(sub, bounds);
        counters[outcome] += 1;
      } catch (err) {
        logger.error({ err, userId: sub.user_id }, 'pnl-guarantee: per-user eval failed');
      }
    }
    // Operator summary in #logs.
    const lines = [
      `🛡 <b>Money-back guarantee · ${bounds.yyyymm}</b>`,
      `Кандидатов: ${candidates.length}`,
      `Бесплатных месяцев выдано: ${counters.granted}`,
      `В плюсе: ${counters.positive}`,
      `Без сделок / 0 PnL: ${counters.neutral}`,
    ];
    void sendLegacyMessage({ channel: 'logs', text: lines.join('\n') }).catch(() => {});
  } finally {
    running = false;
  }
}

async function evaluateUser(
  sub: SubscriptionRow,
  bounds: { start: number; end: number; yyyymm: string },
): Promise<'granted' | 'positive' | 'neutral'> {
  const row = sumUserPnlStmt.get(sub.user_id, bounds.start, bounds.end);
  const pnlUsd = row?.pnl_usd ?? 0;
  const trades = row?.trades ?? 0;
  logger.info(
    { userId: sub.user_id, month: bounds.yyyymm, pnlUsd, trades },
    'pnl-guarantee: per-user eval',
  );
  if (trades === 0) return 'neutral';
  if (pnlUsd >= 0) return 'positive';
  // Negative — apply guarantee, extend +30d.
  applyPnlGuarantee(sub.user_id, bounds.yyyymm, pnlUsd);
  const text =
    `🛡 <b>Money-back · бесплатный месяц выдан</b>\n` +
    `user_id=<code>${sub.user_id}</code> · месяц ${bounds.yyyymm}\n` +
    `PnL за месяц: $${pnlUsd.toFixed(2)} (${trades} сделок)\n` +
    `access_until продлён на 30 дней.`;
  void sendLegacyMessage({ channel: 'logs', text }).catch(() => {});
  return 'granted';
}

export function startPnlGuaranteeMonthlyJob(): void {
  // Run at 00:05 UTC on the 1st of every month. The 5-minute offset
  // gives the daily-wrap job (at 23:55 UTC on the last day) some
  // breathing room — both touch closed-decisions but on different windows.
  cron.schedule('5 0 1 * *', () => {
    void evaluateMonth().catch((err) => {
      logger.error({ err }, 'pnl-guarantee tick threw');
    });
  });
  logger.info('pnl-guarantee monthly cron started (1st of month, 00:05 UTC)');
}

/** Exposed for manual operator-triggered evaluation via admin endpoint
 *  (Phase E2 v2). Use case: re-run a previously skipped month. */
export async function runPnlGuaranteeNow(now = new Date()): Promise<void> {
  await evaluateMonth(now);
}

import cron from 'node-cron';
import { groupedSignalsSince } from '../db/repos/signals.js';
import { sendMessage } from '../telegram/bot.js';
import { summaryPost } from '../telegram/templates.js';
import { logger } from '../lib/logger.js';

const WINDOW_MIN = 10;

export function startSummaryJob(): void {
  cron.schedule(`*/${WINDOW_MIN} * * * *`, async () => {
    const since = Date.now() - WINDOW_MIN * 60 * 1000;
    const rows = groupedSignalsSince(since);
    if (rows.length === 0) {
      logger.debug('summary: empty window, skipping post');
      return;
    }
    const text = summaryPost(WINDOW_MIN, rows);
    await sendMessage({ channel: 'signals', text, disable_notification: true });
    logger.info({ groups: rows.length }, 'summary posted');
  });
  logger.info({ window_min: WINDOW_MIN }, 'summary cron started');
}

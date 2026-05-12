import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { captureChart } from '../browser/tradingview.js';
import { sendPhoto, sendMessage } from '../telegram/bot.js';

/**
 * Periodic screenshot quality-check job. Captures all 5 charts the LLM
 * would see, sends them to the Logs channel so the user can visually
 * verify indicators are loaded, zoom level is right, no promo modals
 * sneaking through, etc.
 *
 * Runs every 4 hours by default (cron `0 *​/4 * * *`). Can also be
 * triggered ad-hoc via `_internal.sendTestSet()` for one-off checks.
 */

type ChartSpec = { symbol: string; interval: '5' | '15' | '60' | '240' | 'D'; label: string };

const CHARTS: ChartSpec[] = [
  { symbol: 'TONUSDT', interval: '15', label: 'TON 15m' },
  { symbol: 'TONUSDT', interval: '60', label: 'TON 1H' },
  { symbol: 'TONUSDT', interval: '240', label: 'TON 4H' },
  { symbol: 'BTCUSDT', interval: '15', label: 'BTC 15m' },
  { symbol: 'BTCUSDT', interval: '60', label: 'BTC 1H' },
];

async function sendTestSet(): Promise<void> {
  const tsLabel = new Date().toISOString().slice(11, 16) + 'Z';
  logger.info({ tick: tsLabel }, 'chart-test: capturing test set');

  await sendMessage({
    channel: 'logs',
    text:
      `🖼 <b>Chart quality check — ${tsLabel}</b>\n` +
      `Ниже 5 скриншотов в порядке которые LLM видит при decide.\n` +
      `Проверь: индикаторы LuxAlgo прорисованы, нет promo-модалок, zoom адекватный.`,
    disable_notification: true,
  }).catch((err) => logger.error({ err }, 'chart-test: header send failed'));

  // Sequential — keeps Telegram order deterministic. Parallel would be
  // ~5x faster but messages would arrive in unpredictable order making
  // visual scan harder.
  for (const chart of CHARTS) {
    try {
      const path = await captureChart(chart.symbol, chart.interval);
      if (!existsSync(path)) {
        await sendMessage({
          channel: 'logs',
          text: `⚠️ <b>${chart.label}</b> — capture succeeded but file missing`,
          disable_notification: true,
        });
        continue;
      }
      const ok = await sendPhoto({
        channel: 'logs',
        photoPath: path,
        caption: `<b>${chart.label}</b> · ${chart.symbol} · ${chart.interval}`,
      });
      if (!ok) {
        await sendMessage({
          channel: 'logs',
          text: `⚠️ <b>${chart.label}</b> — sendPhoto failed (file too big or network?)`,
          disable_notification: true,
        });
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      logger.error({ err, chart: chart.label }, 'chart-test: capture failed');
      await sendMessage({
        channel: 'logs',
        text: `❌ <b>${chart.label}</b> capture FAILED — ${msg.slice(0, 200)}`,
        disable_notification: true,
      }).catch(() => {});
    }
  }

  logger.info({ tick: tsLabel }, 'chart-test: set complete');
}

export function startChartTestJob(): void {
  // Every 4 hours at :00 UTC (00:00, 04:00, 08:00, 12:00, 16:00, 20:00).
  cron.schedule('0 */4 * * *', () => {
    void sendTestSet();
  });
  logger.info('chart-test cron started (every 4h)');

  // Also send one set 30 seconds after startup — gives the user immediate
  // visual confirmation that the just-deployed version is rendering
  // correctly without waiting up to 4 hours.
  if (config.MODE !== 'telemetry') {
    setTimeout(() => {
      void sendTestSet();
    }, 30_000);
  }
}

/** Exposed for manual /test-charts trigger if we add a Telegram command later. */
export const _internal = { sendTestSet };

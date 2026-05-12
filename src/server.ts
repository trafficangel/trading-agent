import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { luxalgoRoute } from './webhooks/luxalgo.route.js';
import { startMonitorJob } from './jobs/monitor.js';
import { startTpslMonitorJob } from './jobs/tpsl-monitor.js';
import { startHeartbeatJob } from './jobs/heartbeat.js';
import { startDailyWrapJob } from './jobs/daily-wrap.js';
import { startDecideCronJob } from './jobs/decide-cron.js';
import { startHealthJob } from './jobs/health.js';
import { startChartTestJob } from './jobs/chart-test.js';
import { startLiquidationsListener } from './exchange/liquidations.js';
import { sendMessage } from './telegram/bot.js';
import { startupBanner, statusReply } from './telegram/templates.js';
import { countSignalsSince } from './db/repos/signals.js';
import { closeDb } from './db/client.js';
import { closeBrowser } from './browser/tradingview.js';

const startedAt = Date.now();

async function main(): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.get('/health', async () => ({ ok: true, mode: config.MODE }));

  app.get('/status', async () => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return {
      ok: true,
      mode: config.MODE,
      uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      signals_24h: countSignalsSince(since),
    };
  });

  await luxalgoRoute(app);
  startDecideCronJob();
  startMonitorJob();
  startTpslMonitorJob();
  startHeartbeatJob();
  startDailyWrapJob();
  startHealthJob();
  startChartTestJob();
  startLiquidationsListener();

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ port: config.PORT, mode: config.MODE }, 'server listening');

  sendMessage({ channel: 'logs', text: startupBanner(config.MODE, config.PORT), disable_notification: true })
    .catch((err) => logger.error({ err }, 'telegram startup banner failed'));

  // Graceful shutdown order matters:
  //   1. Stop accepting new HTTP (app.close)
  //   2. Close Playwright browser (releases /tmp/chromium handles)
  //   3. Close DB connection (flushes WAL)
  // Liquidations WebSocket and setInterval timers are .unref()'d so they
  // don't block exit; OS reclaims sockets on process.exit.
  // 5-second hard timeout so a stuck cleanup doesn't block systemd's
  // restart cycle.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.warn('shutdown taking >5s, forcing exit');
      process.exit(1);
    }, 5000);
    timer.unref();
    try {
      await app.close();
      await closeBrowser();
      closeDb();
    } catch (err) {
      logger.error({ err }, 'shutdown error');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});

// keep statusReply imported for future /status TG command (used by commands.ts later)
void statusReply;

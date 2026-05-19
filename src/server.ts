import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { luxalgoRoute } from './webhooks/luxalgo.route.js';
import { landingRoute } from './strategies/landing.js';
import { homeRoute } from './strategies/home.js';
import { authRoute } from './auth/routes.js';
import { adminRoute } from './admin/routes.js';
import { activePositionsRoute } from './api/active-positions.js';
import { userRoute } from './user/routes.js';
import { autotradingRoute } from './strategies/autotrading.js';
import { startTpslMonitorJob } from './jobs/tpsl-monitor.js';
import { startHeartbeatJob } from './jobs/heartbeat.js';
import { startDailyWrapJob } from './jobs/daily-wrap.js';
import { startHealthJob } from './jobs/health.js';
import { startSubscriptionSweeperJob } from './jobs/subscription-sweeper.js';
import { sendMessage } from './telegram/bot.js';
import { startupBanner, statusReply } from './telegram/templates.js';
import { countSignalsSince } from './db/repos/signals.js';
import { closeDb } from './db/client.js';
import { validateStrategyConfigs } from './strategies/track-c-config.js';
import { selfTest as cryptoSelfTest } from './auth/crypto.js';

const startedAt = Date.now();

async function main(): Promise<void> {
  // Validate STRATEGY_CONFIGS BEFORE anything else — a malformed config
  // (missing slPct, typo'd code, etc.) can lead to positions opened
  // without a working safety stop. Crash loud at boot, not silently
  // mid-trade. See validateStrategyConfigs() for the full rule list.
  try {
    validateStrategyConfigs();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'STRATEGY_CONFIGS validation failed — refusing to start');
    process.exit(1);
  }

  // Track D — verify the master key for client API-key encryption is
  // valid BEFORE accepting connections. A broken master key (truncated
  // env var, wrong hex encoding) would silently corrupt every encrypted
  // row written until the first decrypt fails — which might be days
  // later. Fail at boot.
  try {
    cryptoSelfTest();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'crypto self-test failed — refusing to start');
    process.exit(1);
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    // Trust Caddy reverse proxy — X-Forwarded-For / X-Forwarded-Proto.
    // Needed so req.ip resolves to the real client behind Caddy, and
    // so cookie `secure` flag aligns with https detection.
    trustProxy: true,
  });
  await app.register(fastifyCookie);
  // application/x-www-form-urlencoded — used by admin <form> POSTs
  // (VIP toggle, subscription extend) and the /account/strategies form.
  // Without this plugin Fastify leaves req.body undefined for form data.
  await app.register(fastifyFormbody);

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
  await authRoute(app);
  await adminRoute(app);
  await activePositionsRoute(app);
  await userRoute(app);
  await autotradingRoute(app);
  await landingRoute(app);
  await homeRoute(app);

  // Track C runtime services. tpsl-monitor manages safety SL + 24h
  // time-guard exemption for strategy positions. Heartbeat & health
  // watchdog keep the operator informed of liveness. Daily wrap runs
  // the per-strategy report at 23:55 UTC.
  startTpslMonitorJob();
  startHeartbeatJob();
  startDailyWrapJob();
  startHealthJob();
  startSubscriptionSweeperJob();

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ port: config.PORT, mode: config.MODE }, 'server listening');

  sendMessage({ channel: 'logs', text: startupBanner(config.MODE, config.PORT), disable_notification: true })
    .catch((err) => logger.error({ err }, 'telegram startup banner failed'));

  // Graceful shutdown order matters:
  //   1. Stop accepting new HTTP (app.close)
  //   2. Close DB connection (flushes WAL)
  // setInterval timers are .unref()'d so they don't block exit; OS
  // reclaims sockets on process.exit.
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

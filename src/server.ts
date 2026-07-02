import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { predictRoute } from './strategies/predict.js';
import { labRoute } from './strategies/lab.js';
import { startTpslMonitorJob } from './jobs/tpsl-monitor.js';
import { startHeartbeatJob } from './jobs/heartbeat.js';
import { startDailyWrapJob } from './jobs/daily-wrap.js';
import { startHealthJob } from './jobs/health.js';
import { startSubscriptionSweeperJob } from './jobs/subscription-sweeper.js';
import { startBalanceMonitorJob } from './jobs/balance-monitor.js';
import { startRecoveryMonitorJob } from './jobs/recovery-monitor.js';
import { startCustomRunner } from './jobs/custom-runner.js';
import { startMakerRunner } from './jobs/maker-runner.js';
import { startWebhookWatchdog } from './jobs/webhook-watchdog.js';
import { startHlCollector } from './jobs/hl-collector.js';
import { startHlCandleCollector } from './jobs/hl-candle-collector.js';
import { startFundingFlipRunner } from './jobs/funding-flip-runner.js';
import { startWickFadeRunner } from './jobs/wick-fade-runner.js';
// Phase G — money-back guarantee disabled, see start-job line below.
// import { startPnlGuaranteeMonthlyJob } from './jobs/pnl-guarantee-monthly.js';
import { sendMessage } from './telegram/bot.js';
import { startupBanner, statusReply } from './telegram/templates.js';
import { countSignalsSince } from './db/repos/signals.js';
import { closeDb } from './db/client.js';
import { validateStrategyConfigs } from './strategies/track-c-config.js';
import { selfTest as cryptoSelfTest, selfTestExistingRow as cryptoSelfTestRow } from './auth/crypto.js';
import { flushOperatorLog } from './telegram/log-queue.js';
import { pickRandomActiveKey, getDecryptedCreds } from './db/repos/user-api-keys.js';

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

  // Audit C4 — also decrypt one existing user_api_keys row. The basic
  // self-test above only verifies round-trip on fresh ciphertext; it
  // does NOT catch the case where API_KEY_MASTER_SECRET was rotated
  // without re-encrypting existing rows. Without this check, the
  // server would start happily and only fail on the first user trade.
  try {
    cryptoSelfTestRow(() => {
      const row = pickRandomActiveKey();
      if (!row) return null;
      return getDecryptedCreds(row);
    });
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      'crypto self-test (existing row) failed — refusing to start',
    );
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

  // Static assets — founder photo, future OG images, downloadable
  // setup guides, etc. Served at /static/<filename>. The directory
  // sits at the repo root (`public/`) and is committed to git so
  // deploys ship the assets alongside the code.
  //
  // We resolve the path off `import.meta.url` (the compiled file in
  // `dist/`) and step UP one level to the repo root — Node's ESM
  // doesn't expose __dirname, hence the conversion. `decorateReply:
  // false` keeps the plugin from monkey-patching every reply with
  // `.sendFile`, which we don't use anywhere.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(moduleDir, '..', 'public');
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/static/',
    decorateReply: false,
    // 7-day cache; founder photo and OG images don't change often,
    // and a hard reload still bypasses cache for the operator.
    maxAge: '7d',
    immutable: false,
  });

  // Audit H-NEW-2/3 — global rate-limit plugin in OPT-IN mode.
  // `global: false` means routes without `config.rateLimit` are not
  // limited (default behaviour preserved). Routes that ARE limited
  // declare their bucket in their `config` option:
  //   - /webhook/luxalgo/:secret → 60/min (TV alerts + brute-force guard)
  //   - /admin/* → 10/min (Basic-auth brute-force guard)
  //   - /auth/start, /auth/verify (existing in-memory limiter already)
  // Memory backend is fine for our single-process deployment.
  await app.register(fastifyRateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
    // Use Caddy-forwarded IP, not the proxy.
    keyGenerator: (req) => req.ip,
    // Return JSON instead of plain text for HTTP API ergonomics; admin
    // pages will see this body but rendered fine in any client.
    errorResponseBuilder: (_req, ctx) => ({
      ok: false,
      error: 'rate_limit_exceeded',
      retryAfterSec: Math.ceil(ctx.ttl / 1000),
    }),
  });

  // Audit H2 — security headers on every HTML response. Defends against
  // XSS-stolen-CSRF (no third-party scripts can execute), clickjacking
  // (no embedding in iframes), MIME-sniffing attacks, and protocol
  // downgrade. The webhook endpoint returns JSON and is unaffected.
  //
  // CSP allows inline scripts/styles because the cabinet uses several
  // <style> blocks and onsubmit="confirm(...)" attributes. Full strict
  // CSP (no 'unsafe-inline') would require a templating refactor —
  // tracked as a follow-up. The headers below still block the most
  // common XSS vector (third-party script-src) and remove
  // frame-ancestors as a vector for clickjacking.
  app.addHook('onSend', async (req, reply, payload) => {
    // Skip for webhooks + JSON APIs (preserve their content-type-based behaviour)
    if (req.url.startsWith('/webhook/')) return payload;
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        "upgrade-insecure-requests",
      ].join('; '),
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY'); // legacy, redundant with frame-ancestors
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    return payload;
  });

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
  await predictRoute(app);
  await labRoute(app);
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
  startBalanceMonitorJob();
  startRecoveryMonitorJob();
  // THE LAB — paper-trade in-house engine strategies (track='lab',
  // isolated from the live book). Drives /lab. VPS-only (needs Bybit
  // klines); no-ops locally where Bybit is unreachable.
  startCustomRunner();
  // THE LAB — maker book (track='lab-maker'): rests limits at the band,
  // fills on touch, maker fees. Forward-tests the low-TF MR edges.
  startMakerRunner();
  // Watchdog: alert if LuxAlgo webhooks go silent (>18h) — catches an
  // upstream outage in an hour instead of days.
  startWebhookWatchdog();
  // Hyperliquid microstructure collector: WS trades→CVD + per-min OI/funding/
  // book → hl_micro. Forward-collects the data the order-flow strategies need
  // (no REST history on HL). Isolated; no orders, no Telegram.
  startHlCollector();
  startHlCandleCollector();
  // FUNDING-FLIP test runner — the kill-battery + placebo-verified HL edge,
  // launched in HL TESTNET (fake money) on the ETH+ADA core to accumulate live
  // out-of-sample evidence. mode='testnet' const; idles if HL key missing.
  startFundingFlipRunner();
  // WICK-FADE test runner — the SECOND validated edge (deep-dislocation anomaly
  // fade, broad on retail alts). HL TESTNET, post-only deep limits → fade the
  // snap-back. mode='testnet' const; idles if HL key missing / endpoint mismatch.
  startWickFadeRunner();
  // Phase G — money-back guarantee disabled per operator decision.
  // Cron registration commented out, DB columns + repo helpers preserved
  // so it can be re-enabled later without re-migrating. UI mentions
  // also removed from /autotrading and dashboard.
  // startPnlGuaranteeMonthlyJob();

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
      // Audit H-NEW-4 — flush buffered operator alerts before exit.
      // The log-queue holds non-critical events for ~1.5s; without
      // this drain, the last batch is lost on every restart.
      await flushOperatorLog().catch((err) =>
        logger.error({ err }, 'log-queue flush on shutdown failed'),
      );
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

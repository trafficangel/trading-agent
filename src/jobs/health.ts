import cron from 'node-cron';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getLastTick } from '../lib/health-tracker.js';
import { sendMessage } from '../telegram/bot.js';

/**
 * Health watchdog.
 *
 * Runs every 10 minutes. Checks two things and alerts to the Logs Telegram
 * channel if any condition fails:
 *
 *   1. Each tracked cron job ticked within its expected window. If a job
 *      hasn't run when it should have (e.g., a hang took out the cron),
 *      we get an alert within 10-20 minutes instead of waiting for the
 *      user to notice "no decisions for hours".
 *   2. Process RSS memory is below thresholds. Catches leaks early so we
 *      don't get OOM-killed silently at 2.8GB like the 2026-05-11 incident.
 *
 * Per-issue alert cooldown: 30 min. Stuck conditions don't spam 6 alerts
 * per hour; one alert, then quiet, then re-alert in 30 min if still bad.
 */

type HealthCheck = {
  /** marker name used in markTick() */
  key: string;
  /** human label for the alert */
  label: string;
  /** Max acceptable time-since-last-tick (ms). Beyond this → alert. */
  maxAgeMs: number;
};

const CHECKS: HealthCheck[] = [
  { key: 'tpsl', label: 'tpsl-monitor', maxAgeMs: 10 * 60 * 1000 }, // every 1m → 10m grace
  { key: 'hl-momentum-scan', label: 'hl-momentum minute scan', maxAgeMs: 4 * 60 * 1000 },
  { key: 'hl-momentum-fast', label: 'hl-momentum fast radar', maxAgeMs: 2 * 60 * 1000 },
  { key: 'hl-momentum-reconcile', label: 'hl-momentum exchange reconcile', maxAgeMs: 5 * 60 * 1000 },
];

const MEM_WARN_MB = 1024;
const MEM_CRITICAL_MB = 2048;
const BACKUP_MAX_AGE_MS = 9 * 60 * 60_000;
const BACKUP_MANIFEST = resolve(process.env.DB_BACKUP_DIR ?? join(dirname(resolve(config.DB_PATH)), 'backups'), 'latest.json');

const lastAlertAt = new Map<string, number>();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function shouldAlert(key: string): boolean {
  const last = lastAlertAt.get(key) ?? 0;
  if (Date.now() - last >= ALERT_COOLDOWN_MS) {
    lastAlertAt.set(key, Date.now());
    return true;
  }
  return false;
}

async function check(): Promise<void> {
  const now = Date.now();
  const issues: { key: string; text: string }[] = [];

  // Cron staleness checks
  for (const c of CHECKS) {
    const last = getLastTick(c.key);
    if (last === null) {
      // Allow a 15-minute grace for fresh process boots — the first tick
      // hasn't happened yet but that's expected, not a bug.
      const uptime = process.uptime() * 1000;
      if (uptime > 15 * 60 * 1000) {
        issues.push({
          key: `${c.key}-never-ticked`,
          text: `${c.label}: ни одного tick'а с момента старта (${Math.round(uptime / 60000)} мин uptime)`,
        });
      }
      continue;
    }
    const ageMs = now - last;
    if (ageMs > c.maxAgeMs) {
      issues.push({
        key: `${c.key}-stale`,
        text: `${c.label}: последний tick ${Math.round(ageMs / 60000)} мин назад (порог ${Math.round(c.maxAgeMs / 60000)} мин)`,
      });
    }
  }

  // Memory probe
  const rssMB = process.memoryUsage().rss / (1024 * 1024);
  logger.info({ rss_mb: Math.round(rssMB) }, 'health: memory probe');
  if (rssMB > MEM_CRITICAL_MB) {
    issues.push({
      key: 'mem-critical',
      text: `RAM ${rssMB.toFixed(0)}MB (критично, >${MEM_CRITICAL_MB}MB — близко к OOM)`,
    });
  } else if (rssMB > MEM_WARN_MB) {
    issues.push({
      key: 'mem-warn',
      text: `RAM ${rssMB.toFixed(0)}MB (повышено, >${MEM_WARN_MB}MB — возможна утечка)`,
    });
  }

  try {
    const backupAgeMs = now - statSync(BACKUP_MANIFEST).mtimeMs;
    if (backupAgeMs > BACKUP_MAX_AGE_MS) {
      issues.push({
        key: 'sqlite-backup-stale',
        text: `SQLite backup: последний успешный снимок ${Math.round(backupAgeMs / 3_600_000)}ч назад (порог 9ч)`,
      });
    }
  } catch {
    if (process.uptime() > 30 * 60) {
      issues.push({ key: 'sqlite-backup-missing', text: 'SQLite backup: latest.json отсутствует' });
    }
  }

  if (issues.length === 0) {
    logger.debug('health: all checks passed');
    return;
  }

  // Filter to issues whose alert cooldown has expired
  const fresh = issues.filter((i) => shouldAlert(i.key));
  if (fresh.length === 0) {
    logger.debug(
      { count: issues.length },
      'health: issues detected but all under alert cooldown',
    );
    return;
  }

  const lines = [
    '❗️ <b>Health check failed</b>',
    '',
    ...fresh.map((i) => `  • ${i.text}`),
    '',
    '<i>Алерт по каждому пункту повторится не чаще раза в 30 мин.</i>',
  ];

  await sendMessage({ channel: 'logs', text: lines.join('\n') }).catch((err) =>
    logger.error({ err }, 'health: failed to send alert'),
  );

  logger.warn({ issues: fresh.map((i) => i.key) }, 'health alert sent');
}

export function startHealthJob(): void {
  cron.schedule('*/10 * * * *', () => {
    void check();
  });
  logger.info('health cron started (every 10 min)');
}

/** Exposed for one-off invocations / tests. */
export const _internal = { check };

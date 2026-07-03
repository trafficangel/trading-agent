import cron from 'node-cron';
import { sendLegacyMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const startedAt = Date.now();

function formatUptime(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}д ${h}ч`;
  return `${h}ч ${m}м`;
}

// Track C-only stats. The signals table is no longer written to (Track A/B
// removed) but historical rows still exist — we just don't surface them.
// Operator heartbeat counts SHADOW rows only (user_id IS NULL); per-user
// fan-out rows live in the same table but represent the same signal and
// would double-count here.
const activeCount = db.prepare<[], { c: number }>(
  "SELECT COUNT(*) AS c FROM decisions WHERE status = 'active' AND track = 'strategy' AND user_id IS NULL",
);
const closedSinceStmt = db.prepare<[number], { c: number }>(
  "SELECT COUNT(*) AS c FROM decisions WHERE status = 'closed' AND track = 'strategy' AND user_id IS NULL AND closed_at >= ?",
);
const openedSinceStmt = db.prepare<[number], { c: number }>(
  "SELECT COUNT(*) AS c FROM decisions WHERE track = 'strategy' AND user_id IS NULL AND created_at >= ?",
);

async function tick(): Promise<void> {
  const now = Date.now();
  const since24h = now - 24 * 3600 * 1000;

  const active = activeCount.get()?.c ?? 0;
  const opened = openedSinceStmt.get(since24h)?.c ?? 0;
  const closed = closedSinceStmt.get(since24h)?.c ?? 0;

  const text =
    `🟢 <b>alive</b>  ·  uptime ${formatUptime(now - startedAt)}  ·  ` +
    `активных сделок: <b>${active}</b>\n` +
    `Track C/24ч: открыто <b>${opened}</b>, закрыто <b>${closed}</b>  ·  ` +
    `mode: <code>${config.MODE}</code>`;

  await sendLegacyMessage({ channel: 'logs', text, disable_notification: true });
  logger.info({ active, opened, closed }, 'heartbeat sent');
}

export function startHeartbeatJob(): void {
  // Once a day at 12:00 UTC — confirms the system is alive even on
  // days with no trade activity. Daily-wrap at 23:55 covers trade
  // stats; heartbeat covers OS-level liveness (uptime, mode) and
  // intentionally fires at a different hour so the Logs channel
  // doesn't go silent for more than ~12h.
  //
  // Reduced from every-4h on 2026-05-19 — at 6 pings/day the channel
  // was mostly noise. One daily pulse + health watchdog (which fires
  // ONLY on actual problems) is enough.
  cron.schedule('0 12 * * *', () => {
    void tick();
  });
  logger.info('heartbeat cron started (daily at 12:00 UTC)');
}

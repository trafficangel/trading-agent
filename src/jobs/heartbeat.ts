import cron from 'node-cron';
import { sendMessage } from '../telegram/bot.js';
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

const sigCount = db.prepare<[number], { c: number }>(
  'SELECT COUNT(*) AS c FROM signals WHERE received_at >= ?',
);
const decGroup = db.prepare<[number], { decision: string; c: number }>(
  'SELECT decision, COUNT(*) AS c FROM decisions WHERE created_at >= ? GROUP BY decision',
);
const activeCount = db.prepare<[], { c: number }>(
  "SELECT COUNT(*) AS c FROM decisions WHERE status = 'active'",
);

async function tick(): Promise<void> {
  const now = Date.now();
  const since6h = now - 6 * 3600 * 1000;
  const since24h = now - 24 * 3600 * 1000;

  const sigs6h = sigCount.get(since6h)?.c ?? 0;
  const decisions24h = decGroup.all(since24h);
  const totalDec = decisions24h.reduce((s, r) => s + r.c, 0);
  const openCount = decisions24h.find((r) => r.decision === 'OPEN')?.c ?? 0;
  const closeCount = decisions24h.find((r) => r.decision === 'CLOSE')?.c ?? 0;
  const skipCount = decisions24h.find((r) => r.decision === 'SKIP')?.c ?? 0;
  const active = activeCount.get()?.c ?? 0;

  const text =
    `🟢 <b>alive</b>  ·  uptime ${formatUptime(now - startedAt)}  ·  ` +
    `сигналов/6ч: <b>${sigs6h}</b>  ·  активных сделок: <b>${active}</b>\n` +
    `Решений/24ч: <b>${totalDec}</b> (OPEN ${openCount}, CLOSE ${closeCount}, SKIP ${skipCount})  ·  ` +
    `mode: <code>${config.MODE}</code>`;

  await sendMessage({ channel: 'logs', text, disable_notification: true });
  logger.info({ sigs6h, active, totalDec }, 'heartbeat sent');
}

export function startHeartbeatJob(): void {
  // Top of every 4 hours UTC: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00.
  cron.schedule('0 */4 * * *', () => {
    void tick();
  });
  logger.info('heartbeat cron started (every 4h)');
}

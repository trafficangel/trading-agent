import cron from 'node-cron';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  STRATEGY_CONFIGS,
  TRACK_C_NOTIONAL_USD,
  LANDING_BASE_URL,
  type StrategyConfig,
} from '../strategies/track-c-config.js';
import {
  getStrategyLiveStats,
  getStrategyDailyStats,
  getStrategyActiveTrades,
} from '../strategies/live-stats.js';

/**
 * Daily wrap-up to the Signals channel.
 *
 * Re-architected (May 2026) around per-strategy blocks for Track C —
 * the only track currently running. Each enabled strategy gets its
 * own block with:
 *   - Today's slice  (closed trades, W/L, P&L, exit-reason mix)
 *   - Cumulative since launch (totals, win rate, live P&L)
 *   - Currently-open positions (T#NNN ids)
 *   - Link to the strategy detail page
 *
 * Plus a portfolio aggregate footer summing across all strategies.
 *
 * Why this layout: subscribers care about "what did MY strategies do
 * today and how are they doing overall" — not raw decision counts.
 * One report = one scroll on mobile.
 */

const sigsToday = db.prepare<[number], { symbol: string; timeframe: string; c: number }>(
  'SELECT symbol, timeframe, COUNT(*) AS c FROM signals WHERE received_at >= ? GROUP BY symbol, timeframe ORDER BY symbol, timeframe',
);

function startOfTodayUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function fmtUsd(n: number, withSign = false): string {
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtAge(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

/** Render per-strategy block. Returns array of lines to push into the
 *  report. Caller adds blank separator lines around it. */
function renderStrategyBlock(cfg: StrategyConfig, dayStart: number): string[] {
  const live = getStrategyLiveStats(cfg.id);
  const daily = getStrategyDailyStats(cfg.id, dayStart);
  const active = getStrategyActiveTrades(cfg.id);
  const launchDays = Math.max(0, Math.floor((Date.now() - cfg.launchedAt) / 86_400_000));
  const launchLabel = launchDays === 0 ? 'сегодня' : `${launchDays}д назад`;
  const landingUrl = `${LANDING_BASE_URL}/strategies/${cfg.code}`;
  const name = cfg.name ?? `${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m`;

  const lines: string[] = [];
  lines.push(`🤖 <b>STRAT-${cfg.code}</b> · ${name} · ${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m`);

  // --- TODAY slice ---
  lines.push(`<b>📅 Сегодня:</b>`);
  if (daily.closed === 0 && active.length === 0) {
    lines.push(`  <i>Сделок не было</i>`);
  } else {
    if (daily.closed > 0) {
      const wr = daily.closed > 0 ? ((daily.wins / daily.closed) * 100).toFixed(0) : '—';
      const sign = daily.netPnlUsd >= 0 ? '+' : '';
      lines.push(
        `  Закрыто: <b>${daily.closed}</b> · ${daily.wins}W / ${daily.losses}L · WR ${wr}%`,
      );
      lines.push(
        `  P&amp;L: <b>${sign}${daily.netPnlPct.toFixed(2)}%</b> · <b>${fmtUsd(daily.netPnlUsd, true)}</b>`,
      );
      const exitMix: string[] = [];
      if (daily.exitsStrategy > 0) exitMix.push(`${daily.exitsStrategy} по сигналу`);
      if (daily.exitsSafetySL > 0) exitMix.push(`${daily.exitsSafetySL} по SL`);
      if (exitMix.length > 0) lines.push(`  Выходы: ${exitMix.join(', ')}`);
    }
    if (active.length > 0) {
      const openLine = active
        .map((t) => {
          const num = t.strategyTradeNum ?? t.id;
          const side = t.side === 'long' ? '🟢' : '🔴';
          const age = fmtAge(Date.now() - t.entryAt);
          return `${side} T#${num.toString().padStart(3, '0')} (${age})`;
        })
        .join(' · ');
      lines.push(`  В работе: <b>${active.length}</b> — ${openLine}`);
    }
  }

  // --- Since launch ---
  lines.push(`<b>📊 С запуска (${launchLabel}):</b>`);
  if (live.closed === 0) {
    lines.push(`  <i>Ждём первый закрытый трейд</i>`);
  } else {
    const wrPct = live.winRate !== null ? (live.winRate * 100).toFixed(1) : '—';
    const sign = live.netPnlUsd >= 0 ? '+' : '';
    lines.push(
      `  Всего: <b>${live.closed}</b> · ${live.wins}W / ${live.losses}L · WR <b>${wrPct}%</b>`,
    );
    lines.push(
      `  P&amp;L: <b>${sign}${live.netPnlPct.toFixed(2)}%</b> · <b>${fmtUsd(live.netPnlUsd, true)}</b>`,
    );
  }

  lines.push(`<a href="${landingUrl}">📊 Детали → ${landingUrl}</a>`);

  return lines;
}

async function tick(now: Date = new Date()): Promise<void> {
  const dayStart = startOfTodayUtc(now);
  const dateStr = now.toISOString().slice(0, 10);

  const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);

  // --- Portfolio aggregate ---
  let portClosedToday = 0;
  let portWinsToday = 0;
  let portLossesToday = 0;
  let portPnlTodayUsd = 0;
  let portActiveNow = 0;
  let portClosedAll = 0;
  let portPnlAllUsd = 0;
  for (const cfg of enabled) {
    const live = getStrategyLiveStats(cfg.id);
    const daily = getStrategyDailyStats(cfg.id, dayStart);
    portClosedToday += daily.closed;
    portWinsToday += daily.wins;
    portLossesToday += daily.losses;
    portPnlTodayUsd += daily.netPnlUsd;
    portActiveNow += live.open;
    portClosedAll += live.closed;
    portPnlAllUsd += live.netPnlUsd;
  }

  // --- Signals webhook counter ---
  const sigRows = sigsToday.all(dayStart);
  const sigTotal = sigRows.reduce((s, r) => s + r.c, 0);

  // --- Compose ---
  const lines: string[] = [
    `📊 <b>Сводка за ${dateStr}</b>`,
    `<i>Track C · LuxAlgo Strategy Builder · ${TRACK_C_NOTIONAL_USD} USDT/сделка</i>`,
    ``,
  ];

  // Portfolio mini-dashboard
  lines.push(`<b>🏛 Портфель:</b>`);
  lines.push(
    `  Стратегий: <b>${enabled.length}</b> · Открытых позиций: <b>${portActiveNow}</b>`,
  );
  if (portClosedToday > 0) {
    const wrToday = ((portWinsToday / portClosedToday) * 100).toFixed(0);
    lines.push(
      `  Сегодня: <b>${portClosedToday}</b> сделок · ${portWinsToday}W / ${portLossesToday}L · WR ${wrToday}% · <b>${fmtUsd(portPnlTodayUsd, true)}</b>`,
    );
  } else {
    lines.push(`  Сегодня: <i>закрытых сделок не было</i>`);
  }
  if (portClosedAll > 0) {
    lines.push(
      `  С запуска: <b>${portClosedAll}</b> сделок · <b>${fmtUsd(portPnlAllUsd, true)}</b>`,
    );
  }
  lines.push('');

  // Per-strategy blocks
  if (enabled.length === 0) {
    lines.push(`<i>Активных стратегий нет.</i>`);
  } else {
    for (const cfg of enabled) {
      lines.push(...renderStrategyBlock(cfg, dayStart));
      lines.push('');
    }
  }

  // Signals counter as a tiny footer
  lines.push(`<i>⚙ Webhooks за день: ${sigTotal}</i>`);
  lines.push(`<i>⚠ Прошлые результаты не гарантируют будущих.</i>`);

  const text = lines.join('\n');
  await sendMessage({
    channel: 'signals',
    text,
    disable_web_page_preview: true,
    disable_notification: true,
  }).catch((err) => logger.error({ err }, 'daily-wrap: send failed'));
  await sendMessage({
    channel: 'logs',
    text,
    disable_web_page_preview: true,
    disable_notification: true,
  }).catch(() => {});
}

export function startDailyWrapJob(): void {
  // 23:55 UTC daily — slightly before end of UTC day so all candles close.
  cron.schedule('55 23 * * *', () => {
    void tick();
  });
  logger.info('daily-wrap cron started (23:55 UTC)');
}

// Export for manual trigger from CLI / test harnesses.
export { tick as runDailyWrap };

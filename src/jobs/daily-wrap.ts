import cron from 'node-cron';
import { sendLegacyMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  STRATEGY_CONFIGS,
  TRACK_C_NOTIONAL_USD,
  LANDING_BASE_URL,
  formatStrategyTradeId,
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

/**
 * Render per-strategy block. Compact-by-default — 3-5 lines per
 * strategy instead of the previous 8-10. The math: at ~50-60 chars
 * per line and Telegram's 4096-char cap, we want to fit 15+ strategies
 * comfortably; the old layout topped out around 8.
 *
 * Layout:
 *   🤖 STRAT-001 · BNB Contrarian (BNBUSDT 15m)
 *     📅 Сегодня: 3 сделки · 2W/1L · +$15.00 (2 по сигналу, 1 SL)
 *     📊 Всего (39д): 5 · WR 60% · +$21.00 · 🟢 1 в работе: BNB#001 (2ч)
 *
 * "Сегодня" line collapses to "сделок не было" when daily.closed === 0.
 * "Всего" line shows "ждём первый трейд" when live.closed === 0.
 */
function renderStrategyBlock(cfg: StrategyConfig, dayStart: number): string[] {
  const live = getStrategyLiveStats(cfg.id);
  const daily = getStrategyDailyStats(cfg.id, dayStart);
  const active = getStrategyActiveTrades(cfg.id);
  const launchDays = Math.max(0, Math.floor((Date.now() - cfg.launchedAt) / 86_400_000));
  const launchLabel = launchDays === 0 ? 'сегодня' : `${launchDays}д`;
  const landingUrl = `${LANDING_BASE_URL}/strategies/${cfg.code}`;
  const name = cfg.name ?? `${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m`;

  const lines: string[] = [];
  lines.push(
    `🤖 <a href="${landingUrl}"><b>STRAT-${cfg.code}</b></a> · ${name} (${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m)`,
  );

  // --- Today line ---
  if (daily.closed === 0) {
    lines.push(`  📅 <i>Сегодня сделок не было</i>`);
  } else {
    const wr = ((daily.wins / daily.closed) * 100).toFixed(0);
    const exitMix: string[] = [];
    if (daily.exitsStrategy > 0) exitMix.push(`${daily.exitsStrategy} по сигналу`);
    if (daily.exitsSafetySL > 0) exitMix.push(`${daily.exitsSafetySL} SL`);
    const mixStr = exitMix.length > 0 ? ` (${exitMix.join(', ')})` : '';
    lines.push(
      `  📅 Сегодня: <b>${daily.closed}</b> · ${daily.wins}W/${daily.losses}L · WR ${wr}% · <b>${fmtUsd(daily.netPnlUsd, true)}</b>${mixStr}`,
    );
  }

  // --- Cumulative + currently-open inline ---
  const activeBits: string[] = [];
  if (active.length > 0) {
    // Inline the actual trade IDs (e.g. "🟢 BNB#001 (2ч)") so the
    // operator can correlate the wrap with live Telegram posts without
    // clicking through. Cap at 3 listed; condense the rest into "+ N".
    const shown = active.slice(0, 3).map((t) => {
      const num = t.strategyTradeNum ?? t.id;
      const side = t.side === 'long' ? '🟢' : '🔴';
      const age = fmtAge(Date.now() - t.entryAt);
      return `${side} ${formatStrategyTradeId(cfg, num)} (${age})`;
    });
    if (active.length > 3) shown.push(`+${active.length - 3}`);
    activeBits.push(`· В работе: ${shown.join(' · ')}`);
  }

  if (live.closed === 0 && active.length === 0) {
    lines.push(`  📊 Всего (${launchLabel}): <i>ждём первый трейд</i>`);
  } else if (live.closed === 0) {
    lines.push(`  📊 Всего (${launchLabel}): <i>0 закрытых</i> ${activeBits.join(' ')}`);
  } else {
    const wrPct = live.winRate !== null ? (live.winRate * 100).toFixed(0) : '—';
    lines.push(
      `  📊 Всего (${launchLabel}): <b>${live.closed}</b> · WR <b>${wrPct}%</b> · <b>${fmtUsd(live.netPnlUsd, true)}</b> ${activeBits.join(' ')}`.trimEnd(),
    );
  }

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

  // Per-strategy blocks with overflow guard. Telegram caps message
  // text at 4096 chars; we leave ~250 chars of headroom for the
  // footer + an optional "ещё N стратегий" notice. When the total
  // exceeds the budget, we slice and append a link to the full list.
  //
  // Order: by today's activity (most closed today first), then by
  // active positions, then by launch date desc — so the most
  // "interesting" strategies always make it into the message.
  const MAX_LEN = 3800;
  if (enabled.length === 0) {
    lines.push(`<i>Активных стратегий нет.</i>`);
  } else {
    const ranked = enabled
      .map((cfg) => {
        const daily = getStrategyDailyStats(cfg.id, dayStart);
        const live = getStrategyLiveStats(cfg.id);
        return {
          cfg,
          rank:
            daily.closed * 1000 +
            live.open * 100 +
            (cfg.launchedAt / 1e10),
        };
      })
      .sort((a, b) => b.rank - a.rank)
      .map((r) => r.cfg);

    let runningLen = lines.join('\n').length;
    let renderedCount = 0;
    for (const cfg of ranked) {
      const block = renderStrategyBlock(cfg, dayStart);
      const blockLen = block.join('\n').length + 1; // +1 for separator
      if (runningLen + blockLen > MAX_LEN && renderedCount > 0) break;
      lines.push(...block);
      lines.push('');
      runningLen += blockLen;
      renderedCount++;
    }
    if (renderedCount < ranked.length) {
      const remaining = ranked.length - renderedCount;
      lines.push(
        `<i>… и ещё ${remaining} стратегий — полный список на <a href="${LANDING_BASE_URL}/strategies">/strategies</a></i>`,
      );
      lines.push('');
    }
  }

  // Signals counter as a tiny footer
  lines.push(`<i>⚙ Webhooks за день: ${sigTotal}</i>`);
  lines.push(`<i>⚠ Прошлые результаты не гарантируют будущих.</i>`);

  const text = lines.join('\n');
  await sendLegacyMessage({
    channel: 'signals',
    text,
    disable_web_page_preview: true,
    disable_notification: true,
  }).catch((err) => logger.error({ err }, 'daily-wrap: send failed'));
  // Daily wrap is user-facing content (per-strategy stats, portfolio
  // summary) and belongs only in Signals. Logs is reserved for system /
  // webhook monitoring.
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

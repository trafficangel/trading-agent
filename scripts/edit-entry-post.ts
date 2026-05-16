/**
 * Operator script — re-render a Track C entry post text using the
 * current template and edit it in place in the Signals channel.
 *
 * Usage:
 *   pnpm tsx scripts/edit-entry-post.ts <decision_id> <message_id>
 *
 * Example:
 *   pnpm tsx scripts/edit-entry-post.ts 202 977
 *
 * Reads the decision row from SQLite, joins to its strategy config,
 * and rebuilds the entry post identical to what strategy-trader would
 * post today. Then sends Telegram editMessageText.
 */

import { request } from 'undici';
import { config } from '../src/config.js';
import { findDecisionById } from '../src/db/repos/decisions.js';
import {
  getStrategyConfig,
  TRACK_C_NOTIONAL_USD,
  LANDING_BASE_URL,
} from '../src/strategies/track-c-config.js';

function sideEmoji(side: 'long' | 'short'): string {
  return side === 'long' ? '🟢' : '🔴';
}
function sideRu(side: 'long' | 'short'): string {
  return side === 'long' ? 'ЛОНГ' : 'ШОРТ';
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

function buildEntryPostText(decisionId: number): string {
  const row = findDecisionById(decisionId);
  if (!row) throw new Error(`Decision ${decisionId} not found`);
  if (row.track !== 'strategy') throw new Error(`Decision ${decisionId} is not Track C`);
  if (!row.strategy_id) throw new Error(`Decision ${decisionId} has no strategy_id`);
  const cfg = getStrategyConfig(row.strategy_id);
  if (!cfg) throw new Error(`Strategy ${row.strategy_id} not in config`);

  const num = row.strategy_trade_num ?? row.id;
  const tradeIdStr = `T#${num.toString().padStart(3, '0')}`;
  const side = (row.side ?? 'long') as 'long' | 'short';
  const slPctDisplay = (cfg.slPct * 100).toFixed(2);
  const tfLabel = `${cfg.timeframe}m`;
  const name = cfg.name ?? `${cfg.symbol ?? row.symbol} ${tfLabel}`;
  const landingUrl = `${LANDING_BASE_URL}/strategies/${cfg.code}`;

  return [
    `${sideEmoji(side)} <b>${sideRu(side)} · ${escapeHtml(row.symbol)} · ${escapeHtml(tfLabel)}</b>`,
    ``,
    `🤖 <b>STRAT-${escapeHtml(cfg.code)}</b> · ${escapeHtml(name)}`,
    `🆔 <b>${tradeIdStr}</b>`,
    ``,
    `📥 Вход:  <code>${row.entry}</code>  (по рынку)`,
    `🛡 Стоп:  <code>${row.sl}</code>  (${slPctDisplay}%)`,
    `💵 Размер позиции: $${TRACK_C_NOTIONAL_USD}`,
    ``,
    `📊 <a href="${landingUrl}">Детали и live статистика</a>`,
    ``,
    `<i>Выход — по сигналу стратегии. Без фиксированных TP.</i>`,
  ].join('\n');
}

async function main(): Promise<void> {
  const decisionId = parseInt(process.argv[2] ?? '', 10);
  const messageId = parseInt(process.argv[3] ?? '', 10);
  if (!decisionId || !messageId) {
    console.error('Usage: pnpm tsx scripts/edit-entry-post.ts <decision_id> <message_id>');
    process.exit(1);
  }
  const text = buildEntryPostText(decisionId);
  console.error('--- new post text ---');
  console.error(text);
  console.error('--- editing in place ---');

  const res = await request(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHANNEL_SIGNALS,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    },
  );
  const body = (await res.body.json()) as { ok: boolean; description?: string };
  if (!body.ok) {
    console.error(`Edit failed: ${body.description}`);
    process.exit(1);
  }
  console.error(`✅ Edited message_id=${messageId} in signals channel`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

/**
 * Operator script — publishes (or previews) a Telegram announcement post
 * for a Track C strategy to the Signals channel.
 *
 * Usage:
 *   pnpm tsx scripts/announce-strategy.ts <code-or-id>            # publishes
 *   pnpm tsx scripts/announce-strategy.ts <code-or-id> --dry-run  # prints only
 *
 * Example:
 *   pnpm tsx scripts/announce-strategy.ts 001
 *
 * Optional env: LANDING_BASE_URL (defaults to the public domain). The
 * script appends /strategies/<code> to build the deep link, which
 * Telegram will render as a rich preview card.
 *
 * Requires env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_SIGNALS — loaded
 * automatically through src/config.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STRATEGY_CONFIGS, getStrategyConfig } from '../src/strategies/track-c-config.js';
import { recomputeBacktestStats } from '../src/strategies/backtest-recompute.js';
import { sendMessage } from '../src/telegram/bot.js';

const LANDING_BASE = process.env.LANDING_BASE_URL ?? 'https://robotclaude.biz';

function fmt(n: number, withSign = false): string {
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}`;
}

/** Telegram parse_mode=HTML supports only <b>/<i>/<a>/<code>/<pre>/<s>/<u>.
 *  Any literal `<` or `>` (e.g. `MF<50`) must be escaped or the API
 *  rejects the message with "Unsupported start tag". */
function escapeTgHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPost(code: string): { text: string; detailUrl: string } | null {
  const cfg =
    Object.values(STRATEGY_CONFIGS).find((s) => s.code === code) ?? getStrategyConfig(code);
  if (!cfg) return null;

  // Prefer SINGLE SOURCE OF TRUTH: recompute aggregate stats from the
  // scraped trades log on $1000 notional minus commission. This matches
  // exactly what the landing page shows (no divergence between the
  // announcement post and robotclaude.biz/strategies/<code>).
  // Falls back to the static backtest snapshot when no trades log was
  // scraped — typically only for strategies added before the scraper
  // existed.
  let b = cfg.backtest;
  const tradesPath = resolve('src', 'strategies', 'data', `${cfg.id}.json`);
  if (b && existsSync(tradesPath)) {
    try {
      const json = JSON.parse(readFileSync(tradesPath, 'utf-8'));
      const trades = json?.tradesLog ?? [];
      if (Array.isArray(trades) && trades.length > 0) {
        b = recomputeBacktestStats(trades, {
          periodLabel: cfg.backtest!.periodLabel,
          periodDays: cfg.backtest!.periodDays,
        }) as typeof cfg.backtest;
      }
    } catch {
      // fall back to static snapshot
    }
  }
  const detailUrl = `${LANDING_BASE}/strategies/${cfg.code}`;

  const lines: string[] = [
    `🆕 <b>НОВАЯ СТРАТЕГИЯ В РАБОТЕ</b>`,
    ``,
    `🤖 <b>STRAT-${cfg.code}</b> · ${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m`,
    ``,
    `📋 <b>Логика:</b>`,
    `<code>${escapeTgHtml(cfg.description)}</code>`,
  ];

  if (cfg.longDescription) {
    lines.push(``, `<i>${escapeTgHtml(cfg.longDescription)}</i>`);
  }

  if (b) {
    lines.push(``);
    lines.push(`📊 <b>Backtest за ${b.periodDays} дней (${b.periodLabel}):</b>`);
    lines.push(`  ✓ ${b.totalTrades} сделок · ${b.wins}W / ${b.losses}L`);
    lines.push(`  ✓ Win rate: <b>${(b.winRate * 100).toFixed(2)}%</b>`);
    lines.push(`  ✓ Profit factor: <b>${b.profitFactor.toFixed(2)}</b>`);
    lines.push(`  ✓ Net P&amp;L: <b>+${b.netPnlPct.toFixed(2)}%</b> (+${b.netPnlUsd.toFixed(2)} USDT)`);
    lines.push(`  ✓ CAGR (аннуализ.): <b>${b.cagrPct.toFixed(2)}%</b>`);
    lines.push(`  ✓ Max drawdown: ${b.maxDrawdownPct.toFixed(2)}% (${b.maxDrawdownUsd.toFixed(2)} USDT)`);
    lines.push(`  ✓ Avg win: +${b.avgWinUsd.toFixed(2)} USDT (+${b.avgWinPct.toFixed(2)}%)`);
    lines.push(`  ✓ Avg loss: ${b.avgLossUsd.toFixed(2)} USDT (${b.avgLossPct.toFixed(2)}%)`);
    lines.push(`  ✓ Long: ${b.longTrades} сделок · ${fmt(b.longPnlPct, true)}%`);
    lines.push(`  ✓ Short: ${b.shortTrades} сделок · ${fmt(b.shortPnlPct, true)}%`);
    lines.push(`  ✓ Комиссия: ${(b.commissionPctPerSide * 100).toFixed(3)}% × 2 (Bybit)`);
    lines.push(`  ✓ Капитал: ${b.initialCapital} USDT · ${b.notionalUsd} USDT/сделка`);
  }

  lines.push(``);
  lines.push(`🛡 <b>Управление риском:</b>`);
  lines.push(`  • Позиция: ${b?.notionalUsd ?? 1000} USDT на сделку`);
  lines.push(`  • Safety stop-loss: ${(cfg.slPct * 100).toFixed(2)}% от entry`);
  lines.push(`  • Выходы: полностью на стратегии (Builtin Exits)`);

  lines.push(``);
  lines.push(`🔗 <b>Детальная статистика + live-результаты:</b>`);
  lines.push(`<a href="${detailUrl}">${detailUrl}</a>`);

  lines.push(``);
  lines.push(`<i>ℹ️ Все цифры пересчитаны на нашу позицию $1000 с учётом комиссии Bybit. Safety SL в бэктесте не моделируется — в живой торговле работает как tail-risk cap.</i>`);
  lines.push(``);
  lines.push(`<i>⚠ Прошлые результаты не гарантируют будущих. Shadow mode — реальные ордера НЕ ставятся, цель — собрать live-статистику.</i>`);

  return { text: lines.join('\n'), detailUrl };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const code = args.find((a) => !a.startsWith('--'));
  if (!code) {
    console.error('Usage: pnpm tsx scripts/announce-strategy.ts <code-or-id> [--dry-run]');
    process.exit(1);
  }

  const post = buildPost(code);
  if (!post) {
    console.error(`Strategy not found: ${code}`);
    console.error('Available:');
    for (const s of Object.values(STRATEGY_CONFIGS)) {
      console.error(`  ${s.code}  ${s.id}`);
    }
    process.exit(1);
  }

  if (dryRun) {
    console.log('--- DRY RUN: post preview (HTML, not published) ---');
    console.log(post.text);
    console.log('---');
    console.log(`Would post to channel 'signals' with link preview ENABLED → ${post.detailUrl}`);
    return;
  }

  console.error(`Publishing STRAT-${code} announcement to signals channel…`);
  const res = await sendMessage({
    channel: 'signals',
    text: post.text,
    // Preview enabled so subscribers see the landing-page card with the
    // donut + diverging-bar charts as a thumbnail.
    disable_web_page_preview: false,
    // Announcement = important; let Telegram notify subscribers normally.
    disable_notification: false,
  });
  if (!res) {
    console.error('Publish failed — check logs above');
    process.exit(1);
  }
  console.error(`Published OK (message_id=${res.message_id}). Landing: ${post.detailUrl}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

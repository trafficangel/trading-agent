/**
 * Operator script — generates a Telegram-ready announcement post for a
 * strategy and prints it to stdout. Copy from terminal and paste into
 * the channel as a pinned message.
 *
 * Usage:
 *   pnpm tsx scripts/announce-strategy.ts <code-or-id>
 *
 * Example:
 *   pnpm tsx scripts/announce-strategy.ts 001
 *
 * Optional env: LANDING_BASE_URL (defaults to the public domain). The
 * script appends /strategies/<code> to build the deep link.
 */

import { STRATEGY_CONFIGS, getStrategyConfig } from '../src/strategies/track-c-config.js';

const LANDING_BASE = process.env.LANDING_BASE_URL ?? 'https://robotclaude.biz';

function fmt(n: number, withSign = false): string {
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}`;
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: pnpm tsx scripts/announce-strategy.ts <code-or-id>');
    process.exit(1);
  }
  const cfg =
    Object.values(STRATEGY_CONFIGS).find((s) => s.code === arg) ?? getStrategyConfig(arg);
  if (!cfg) {
    console.error(`Strategy not found: ${arg}`);
    console.error('Available:');
    for (const s of Object.values(STRATEGY_CONFIGS)) {
      console.error(`  ${s.code}  ${s.id}`);
    }
    process.exit(1);
  }

  const b = cfg.backtest;
  const detailUrl = `${LANDING_BASE}/strategies/${cfg.code}`;

  const lines: string[] = [
    `🆕 <b>НОВАЯ СТРАТЕГИЯ В РАБОТЕ</b>`,
    ``,
    `🤖 <b>STRAT-${cfg.code}</b> · ${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m`,
    ``,
    `📋 <b>Логика:</b>`,
    `<code>${cfg.description}</code>`,
  ];

  if (cfg.longDescription) {
    lines.push(``, `<i>${cfg.longDescription}</i>`);
  }

  if (b) {
    lines.push(``);
    lines.push(`📊 <b>Backtest за ${b.periodDays} дней (${b.periodLabel}):</b>`);
    lines.push(`  ✓ ${b.totalTrades} сделок · ${b.wins}W / ${b.losses}L`);
    lines.push(`  ✓ Win rate: <b>${(b.winRate * 100).toFixed(2)}%</b>`);
    lines.push(`  ✓ Profit factor: <b>${b.profitFactor.toFixed(2)}</b>`);
    lines.push(`  ✓ Net P&L: <b>+${b.netPnlPct.toFixed(2)}%</b> (+${b.netPnlUsd.toFixed(2)} USDT)`);
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
  lines.push(`  • Позиция: 1000 USDT на сделку`);
  lines.push(`  • Safety stop-loss: ${(cfg.slPct * 100).toFixed(2)}% от entry`);
  lines.push(`  • Выходы: полностью на стратегии (Builtin Exits)`);
  lines.push(`  • Time-guard: автоматическое закрытие через 24ч`);

  lines.push(``);
  lines.push(`🔗 <b>Детальная статистика + live-результаты:</b>`);
  lines.push(`<a href="${detailUrl}">${detailUrl}</a>`);

  lines.push(``);
  lines.push(`<i>⚠ Прошлые результаты не гарантируют будущих. Shadow mode — реальные ордера НЕ ставятся, цель — собрать live-статистику для оценки edge.</i>`);

  console.log(lines.join('\n'));
}

main();

/**
 * Track D — `/account/trades` renderer.
 *
 * Shows the user's own Track C decisions (track='strategy', user_id=N)
 * — both active (open positions) and closed history. Today the table
 * is empty for every user because the strategy fan-out (Phase C) hasn't
 * shipped yet — once it does, this page surfaces the real fills.
 *
 * Each row maps a decision row to a compact summary: strategy, symbol,
 * side, entry price, exit price (or "active"), per-trade PnL, and the
 * Bybit order_id for proof-of-execution.
 */

import { pageShell } from '../strategies/landing.js';
import { STRATEGY_CONFIGS, LANDING_BASE_URL } from '../strategies/track-c-config.js';

export type UserTradeRow = {
  id: number;
  created_at: number;
  closed_at: number | null;
  status: string;
  symbol: string;
  side: string | null;
  entry: number | null;
  sl: number | null;
  close_price: number | null;
  close_reason: string | null;
  pnl_pct: number | null;
  pnl_r: number | null;
  strategy_id: string | null;
  strategy_trade_num: number | null;
  exchange_order_id: string | null;
  bybit_qty: number | null;
  bybit_avg_price: number | null;
  bybit_close_avg_price: number | null;
  order_error: string | null;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] ?? c);
}

function ico(emoji: string): string {
  return `<span class="cabinet-ico" aria-hidden="true">${emoji}</span>`;
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function fmtDurationMs(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} мин`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}ч ${min % 60}м`;
  const days = Math.floor(hrs / 24);
  return `${days}д ${hrs % 24}ч`;
}

export function renderTradesPage(args: {
  displayName: string | null;
  activeTrades: UserTradeRow[];
  closedTrades: UserTradeRow[];
  hasApiKey: boolean;
  page: number;
  pageSize: number;
  closedTotal: number;
}): string {
  const activeRows = args.activeTrades
    .map((t) => renderActiveRow(t))
    .join('');
  const closedRows = args.closedTrades
    .map((t) => renderClosedRow(t))
    .join('');

  const noTradesBanner = args.activeTrades.length === 0 && args.closedTrades.length === 0
    ? `
      <div class="trades-empty">
        <div class="trades-empty-icon">${ico('📭')}</div>
        <div class="trades-empty-title">Сделок ещё нет</div>
        <div class="trades-empty-sub">
          ${args.hasApiKey
            ? 'Стратегии работают круглосуточно. Как только появится сигнал — система откроет позицию на вашем счёте и сделка появится здесь.'
            : 'Чтобы начать торговлю, подключите API-ключ Bybit и выберите стратегии в кабинете.'}
        </div>
        ${!args.hasApiKey
          ? '<a class="trades-empty-cta" href="/account/api-key">Подключить ключ →</a>'
          : ''}
      </div>
    `
    : '';

  const activeSection = args.activeTrades.length > 0
    ? `
      <section class="trades-section">
        <h2 class="trades-section-title">${ico('🟢')}Открытые позиции (${args.activeTrades.length})</h2>
        <div class="trades-table-wrap">
          <table class="trades-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Стратегия</th>
                <th>Символ</th>
                <th>Направление</th>
                <th>Вход</th>
                <th>SL</th>
                <th>Открыто</th>
                <th>Order ID</th>
              </tr>
            </thead>
            <tbody>${activeRows}</tbody>
          </table>
        </div>
      </section>
    `
    : '';

  // Pagination footer: «Показано 50 из 247 · ‹ Назад · Вперёд ›».
  // Shown only when closedTotal > pageSize. Pages are 1-indexed; the
  // current page disables its arrow.
  const totalPages = Math.max(1, Math.ceil(args.closedTotal / args.pageSize));
  const showFrom = args.closedTotal === 0 ? 0 : (args.page - 1) * args.pageSize + 1;
  const showTo = Math.min(args.page * args.pageSize, args.closedTotal);
  const paginationHtml = totalPages > 1
    ? `
      <div class="trades-pagination">
        <span class="trades-pagination-info">Показано ${showFrom}-${showTo} из ${args.closedTotal}</span>
        <span class="trades-pagination-nav">
          ${args.page > 1
            ? `<a href="/account/trades?page=${args.page - 1}">← Предыдущая</a>`
            : `<span class="trades-pagination-disabled">← Предыдущая</span>`}
          <span class="trades-pagination-page">стр. ${args.page} из ${totalPages}</span>
          ${args.page < totalPages
            ? `<a href="/account/trades?page=${args.page + 1}">Следующая →</a>`
            : `<span class="trades-pagination-disabled">Следующая →</span>`}
        </span>
      </div>
    `
    : '';

  const closedSection = args.closedTrades.length > 0
    ? `
      <section class="trades-section">
        <h2 class="trades-section-title">${ico('📂')}История сделок (${args.closedTotal})</h2>
        <div class="trades-table-wrap">
          <table class="trades-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Стратегия</th>
                <th>Символ</th>
                <th>Направление</th>
                <th>Вход → Выход</th>
                <th>PnL %</th>
                <th>Длительность</th>
                <th>Причина выхода</th>
              </tr>
            </thead>
            <tbody>${closedRows}</tbody>
          </table>
        </div>
        ${paginationHtml}
      </section>
    `
    : '';

  const body = `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label"><a href="/account" class="cabinet-crumb">Личный кабинет</a> · Сделки</div>
        <h1 class="cabinet-title">История сделок</h1>
        <p class="trades-sub">
          Все сделки, исполненные на вашем счёте Bybit по подключённым
          стратегиям. Каждая запись содержит ссылку на оригинальный сигнал
          (в общем канале) и ID ордера на бирже.
        </p>
      </div>

      ${noTradesBanner}
      ${activeSection}
      ${closedSection}

      <div class="trades-back">
        <a href="/account">← Назад в кабинет</a>
      </div>
    </main>
  `;

  return pageShell('Сделки · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
    authed: { displayName: args.displayName, phone: null },
  });
}

function strategyLabel(strategyId: string | null): string {
  if (!strategyId) return '—';
  const cfg = STRATEGY_CONFIGS[strategyId];
  if (!cfg) return escapeHtml(strategyId);
  const name = cfg.name ?? `${cfg.symbol ?? 'ANY'} ${cfg.timeframe}m`;
  return `<a href="${LANDING_BASE_URL}/strategies/${cfg.code}" target="_blank" rel="noopener">STRAT-${escapeHtml(cfg.code)}</a> · ${escapeHtml(name)}`;
}

function tradeIdStr(t: UserTradeRow): string {
  if (!t.strategy_id || t.strategy_trade_num === null) return `#${t.id}`;
  const cfg = STRATEGY_CONFIGS[t.strategy_id];
  const sym = cfg?.symbol ?? t.symbol;
  // Same convention as the public landing: 3 letters + #NNN
  const prefix = sym.replace(/USDT|USD$/i, '').slice(0, 3).toUpperCase();
  return `${prefix}#${String(t.strategy_trade_num).padStart(3, '0')}`;
}

function sideBadge(side: string | null): string {
  if (side === 'long') return `<span class="trade-side long">🟢 long</span>`;
  if (side === 'short') return `<span class="trade-side short">🔴 short</span>`;
  return '—';
}

function renderActiveRow(t: UserTradeRow): string {
  const orderId = t.exchange_order_id
    ? `<code class="mono small" title="Bybit order ID">${escapeHtml(t.exchange_order_id.slice(0, 10))}…</code>`
    : '<span class="muted">—</span>';
  return `
    <tr>
      <td class="mono">${escapeHtml(tradeIdStr(t))}</td>
      <td>${strategyLabel(t.strategy_id)}</td>
      <td class="mono">${escapeHtml(t.symbol)}</td>
      <td>${sideBadge(t.side)}</td>
      <td class="mono">${t.entry !== null ? t.entry.toFixed(4) : '—'}</td>
      <td class="mono">${t.sl !== null ? t.sl.toFixed(4) : '—'}</td>
      <td class="muted">${fmtDateTime(t.created_at)}</td>
      <td>${orderId}</td>
    </tr>
  `;
}

function renderClosedRow(t: UserTradeRow): string {
  const pnlPct = t.pnl_pct ?? 0;
  const pnlCls = pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg';
  const sign = pnlPct >= 0 ? '+' : '';
  const dur = t.closed_at && t.created_at
    ? fmtDurationMs(t.closed_at - t.created_at)
    : '—';
  const reason = t.close_reason === 'sl_hit'
    ? '🛡 SL'
    : t.close_reason === 'manual' && t.exchange_order_id
      ? '🏁 стратегия'
      : escapeHtml(t.close_reason ?? '—');
  return `
    <tr>
      <td class="mono">${escapeHtml(tradeIdStr(t))}</td>
      <td>${strategyLabel(t.strategy_id)}</td>
      <td class="mono">${escapeHtml(t.symbol)}</td>
      <td>${sideBadge(t.side)}</td>
      <td class="mono">
        ${t.entry !== null ? t.entry.toFixed(4) : '—'}
        <span class="muted">→</span>
        ${t.close_price !== null ? t.close_price.toFixed(4) : '—'}
      </td>
      <td class="mono ${pnlCls}">${sign}${pnlPct.toFixed(2)}%</td>
      <td class="muted">${dur}</td>
      <td>${reason}</td>
    </tr>
  `;
}

function styles(): string {
  return `
<style>
  .cabinet-main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
  .cabinet-greeting { margin-bottom: 18px; }
  .cabinet-greeting-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: #6b7480; margin-bottom: 6px;
  }
  .cabinet-crumb { color: inherit; text-decoration: none; transition: color 0.15s; }
  .cabinet-crumb:hover { color: #4ad991; }
  .cabinet-title { font-size: 26px; font-weight: 600; margin: 0 0 10px 0; color: #e8edf2; }
  .cabinet-ico { display: inline-block; margin-right: 8px; vertical-align: -1px; line-height: 1; }
  .trades-sub { color: #9aa5b1; font-size: 13.5px; line-height: 1.55; margin: 0 0 24px 0; max-width: 740px; }

  .trades-empty {
    display: flex; flex-direction: column; align-items: center;
    gap: 10px; padding: 60px 24px; text-align: center;
    background: #11161d; border: 1px dashed #2a323d; border-radius: 14px;
  }
  .trades-empty-icon { font-size: 42px; }
  .trades-empty-title {
    font-size: 18px; font-weight: 600; color: #e8edf2;
  }
  .trades-empty-sub {
    font-size: 13.5px; color: #9aa5b1; max-width: 480px; line-height: 1.55;
  }
  .trades-empty-cta {
    margin-top: 14px; padding: 9px 18px;
    background: #4ad991; color: #0b0e13; border-radius: 8px;
    text-decoration: none; font-weight: 600; font-size: 13.5px;
  }
  .trades-empty-cta:hover { background: #5ce0a0; }

  .trades-section { margin: 28px 0; }
  .trades-section-title {
    font-size: 15px; font-weight: 600; color: #e8edf2;
    margin: 0 0 14px 0;
  }

  .trades-table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    background: #11161d; border: 1px solid #1f2630; border-radius: 12px;
  }
  .trades-table {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  .trades-table th {
    text-align: left; padding: 12px 14px; font-weight: 500;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #6b7480; background: #0e131a; border-bottom: 1px solid #1f2630;
    white-space: nowrap;
  }
  .trades-table td {
    padding: 11px 14px; border-bottom: 1px solid #1a1f27;
    color: #cfd6dd; white-space: nowrap;
  }
  .trades-table tr:last-child td { border-bottom: none; }
  .trades-table .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .trades-table .small { font-size: 11.5px; }
  .trades-table .muted { color: #6b7480; }
  .trades-table a { color: #4ad991; text-decoration: none; }
  .trades-table a:hover { text-decoration: underline; }

  .trade-side {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    font-size: 11px; font-weight: 600;
  }
  .trade-side.long { background: rgba(74, 217, 145, 0.12); color: #4ad991; }
  .trade-side.short { background: rgba(255, 99, 99, 0.12); color: #ff8b8b; }

  .pnl-pos { color: #4ad991; }
  .pnl-neg { color: #ff8b8b; }

  .trades-pagination {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 16px; border-top: 1px solid #1a1f27;
    font-size: 13px; color: #9aa5b1; flex-wrap: wrap; gap: 12px;
  }
  .trades-pagination-info { color: #6b7480; }
  .trades-pagination-nav { display: flex; gap: 16px; align-items: center; }
  .trades-pagination-nav a {
    color: #4ad991; text-decoration: none; padding: 4px 10px;
    border: 1px solid #2a323d; border-radius: 6px; transition: border-color 0.15s;
  }
  .trades-pagination-nav a:hover { border-color: #4ad991; }
  .trades-pagination-disabled { color: #3a4350; padding: 4px 10px; }
  .trades-pagination-page { color: #cfd6dd; }

  .trades-back { text-align: center; margin-top: 28px; }
  .trades-back a { color: #8590a0; font-size: 13px; text-decoration: none; }
  .trades-back a:hover { color: #4ad991; }

  @media (max-width: 640px) {
    .trades-table { min-width: 760px; }
    .trades-pagination { padding: 12px 14px; gap: 8px; }
    .trades-pagination-nav { gap: 8px; }
    .trades-pagination-nav a { padding: 4px 8px; font-size: 12px; }
  }
  @media (max-width: 380px) {
    .cabinet-main { padding: 20px 12px 60px; }
  }
</style>
`;
}

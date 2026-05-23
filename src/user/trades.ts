/**
 * Track D — `/account/trades` renderer.
 *
 * Shows the user's own Track C decisions (track='strategy', user_id=N).
 * The layout matches the public /strategies feed (combined active+closed
 * table, sort selector, reason pills, pagination) so visitors who came
 * from the landing don't have to re-learn a different UI in the cabinet.
 *
 * The only material difference vs the shadow feed: the «Объём» column
 * shows the user's actual fill notional (bybit_qty × bybit_avg_price)
 * instead of the static $1000 shadow-trade constant, and PnL USD is
 * anchored to that real notional — so the number matches what the user
 * actually saw on their Bybit account.
 *
 * Reuses CSS classes that already live in pageShell (.feed-table,
 * .feed-strat-cell, .reason-pill, .feed-time-cell, .feed-page-link,
 * .feed-sort-*, etc.) — no per-page duplication of those styles.
 */

import { pageShell } from '../strategies/landing.js';
import {
  STRATEGY_CONFIGS,
  LANDING_BASE_URL,
  formatStrategyTradeId,
} from '../strategies/track-c-config.js';
import type {
  UserActiveFeedRow,
  UserClosedFeedRow,
  FeedSort,
} from '../strategies/live-stats.js';

/** Row shape returned by the existing user-trade SQL — kept for the
 *  dashboard which still uses it for the «Открытых сейчас» card. The
 *  trades page itself works off UserActiveFeedRow / UserClosedFeedRow. */
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

function fmtDate(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

const FEED_SORT_OPTIONS: ReadonlyArray<{ value: FeedSort; label: string }> = [
  { value: 'close_desc', label: 'Закрытие: сначала новые' },
  { value: 'close_asc',  label: 'Закрытие: сначала старые' },
  { value: 'entry_desc', label: 'Вход: сначала новые' },
  { value: 'entry_asc',  label: 'Вход: сначала старые' },
  { value: 'pnl_desc',   label: 'PnL: лучшие сверху' },
  { value: 'pnl_asc',    label: 'PnL: худшие сверху' },
];

function stratCellHtml(strategyId: string, tradeNum: number | null, fallbackId: number): string {
  const cfg = STRATEGY_CONFIGS[strategyId];
  if (!cfg) return `<span class="dim">${escapeHtml(strategyId)}</span>`;
  const num = tradeNum ?? fallbackId;
  const tradeIdStr = formatStrategyTradeId(cfg, num);
  const symbol = cfg.symbol ?? 'ANY';
  // Public detail page on the landing — opens in a new tab so the user
  // doesn't lose their cabinet context. LANDING_BASE_URL keeps staging
  // installs pointing at the right host.
  return (
    `<a class="feed-strat-cell" href="${LANDING_BASE_URL}/strategies/${escapeHtml(cfg.code)}" target="_blank" rel="noopener">` +
      `<span class="feed-strat-id">${tradeIdStr}</span>` +
      `<span class="feed-strat-meta">${escapeHtml(symbol)} · ${escapeHtml(cfg.timeframe)}m</span>` +
    `</a>`
  );
}

function timeCellHtml(entryAt: number, exitAt: number | null): string {
  const exitLine = exitAt === null
    ? `<span class="feed-time-exit feed-time-exit-empty">— ещё открыта</span>`
    : `<span class="feed-time-exit">→ ${fmtDate(exitAt)}</span>`;
  return (
    `<div class="feed-time-cell">` +
      `<span class="feed-time-entry">${fmtDate(entryAt)}</span>` +
      exitLine +
    `</div>`
  );
}

type ReasonInfo = { label: string; cls: string; title: string };

function reasonLabel(t: UserClosedFeedRow): ReasonInfo {
  if (t.closeReason === 'sl_hit' || t.forceCloseReason === 'bybit_sl_hit') {
    return { label: 'Стоп-лосс', cls: 'reason-sl',
      title: 'Safety stop-loss сработал на Bybit' };
  }
  if (t.forceCloseReason === 'strategy_exit') {
    return { label: 'По стратегии', cls: 'reason-strat',
      title: 'Стратегия LuxAlgo прислала сигнал на выход (Builtin Exit)' };
  }
  if (t.forceCloseReason === 'reverse_signal') {
    return { label: 'Разворот', cls: 'reason-reverse',
      title: 'Стратегия прислала противоположный сигнал — позиция закрыта чтобы открыть новую в обратную сторону' };
  }
  if (t.forceCloseReason === 'time_guard') {
    return { label: 'Тайм-аут 24ч', cls: 'reason-time',
      title: 'Позиция держалась > 24ч без сигнала на выход — закрыта по тайм-гарду' };
  }
  if (t.forceCloseReason === 'manual_close') {
    return { label: 'Вручную', cls: 'reason-manual',
      title: 'Позиция закрыта вручную на Bybit (оператор или экстренная остановка). Не сигнал стратегии.' };
  }
  if (t.forceCloseReason === 'bybit_reconcile') {
    return { label: 'Реконсиль', cls: 'reason-manual',
      title: 'Позиция исчезла с Bybit между нашими проверками, точная причина не известна' };
  }
  return { label: t.closeReason ?? '—', cls: 'reason-strat', title: '' };
}

function notionalCell(n: number | null): string {
  if (n === null) return '<span class="dim">—</span>';
  // Two-decimal precision for live notional — fill price has fractional
  // qty rounded by Bybit's qtyStep, so the actual frozen notional rarely
  // hits a round number.
  return `$${n.toFixed(2)}`;
}

export function renderTradesPage(args: {
  displayName: string | null;
  activeTrades: UserActiveFeedRow[];
  closedTrades: UserClosedFeedRow[];
  closedTotal: number;
  hasApiKey: boolean;
  page: number;
  pageSize: number;
  sort: FeedSort;
}): string {
  const { activeTrades, closedTrades, closedTotal, hasApiKey, page, sort } = args;
  const totalPages = Math.max(1, Math.ceil(closedTotal / args.pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  // Empty-state banner takes over the entire page when the user has no
  // history yet. Two flavours — pre-API-key vs post-API-key — give the
  // user a concrete next step instead of a generic «нет данных».
  const noTradesBanner = activeTrades.length === 0 && closedTrades.length === 0
    ? `
      <div class="trades-empty">
        <div class="trades-empty-icon">${ico('📭')}</div>
        <div class="trades-empty-title">Сделок ещё нет</div>
        <div class="trades-empty-sub">
          ${hasApiKey
            ? 'Стратегии работают круглосуточно. Как только появится сигнал — система откроет позицию на вашем счёте, и сделка появится здесь.'
            : 'Чтобы начать торговлю, подключите API-ключ Bybit и выберите тариф в кабинете.'}
        </div>
        ${!hasApiKey
          ? '<a class="trades-empty-cta" href="/account/api-key">Подключить ключ →</a>'
          : ''}
      </div>
    `
    : '';

  // Active rows (no PnL yet — show «—» on the right; «Exit / SL» column
  // shows the safety stop price + distance %).
  const activeRows = activeTrades.map((t) => {
    const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
    const ageMs = Date.now() - t.entryAt;
    const slDistPct = t.sl !== null
      ? (Math.abs(t.entryPrice - t.sl) / t.entryPrice) * 100
      : null;
    const slCell = t.sl !== null
      ? `${t.sl.toFixed(4)} <span class="feed-sl-pct">(−${slDistPct!.toFixed(2)}%)</span>`
      : '—';
    return `
      <tr class="feed-row-active">
        <td>${stratCellHtml(t.strategyId, t.strategyTradeNum, t.id)}</td>
        <td class="dt">${timeCellHtml(t.entryAt, null)}</td>
        <td class="dt">${fmtDuration(ageMs)}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${notionalCell(t.notionalUsd)}</td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${slCell}</td>
        <td class="right">—</td>
        <td><span class="reason-pill reason-active" title="Позиция сейчас открыта, ждём сигнал выхода или SL">🟢 В работе</span></td>
      </tr>
    `;
  }).join('');

  const closedRows = closedTrades.map((t) => {
    const cls = t.pnlUsd >= 0 ? 'pos' : 'neg';
    const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
    const r = reasonLabel(t);
    const dur = fmtDuration(t.exitAt - t.entryAt);
    const pnlSign = t.pnlUsd >= 0 ? '+' : '';
    return `
      <tr>
        <td>${stratCellHtml(t.strategyId, t.strategyTradeNum, t.id)}</td>
        <td class="dt">${timeCellHtml(t.entryAt, t.exitAt)}</td>
        <td class="dt">${dur}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${notionalCell(t.notionalUsd)}</td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${t.exitPrice.toFixed(4)}</td>
        <td class="right mono ${cls}">${pnlSign}$${t.pnlUsd.toFixed(2)} <span class="feed-pnl-pct ${cls}">(${pnlSign}${t.pnlPct.toFixed(2)}%)</span></td>
        <td><span class="reason-pill ${r.cls}" title="${escapeHtml(r.title)}">${r.label}</span></td>
      </tr>
    `;
  }).join('');

  // Pagination — sort param threaded through every link so it survives
  // page navigation.
  const sortQs = sort && sort !== 'close_desc' ? `&sort=${encodeURIComponent(sort)}` : '';
  const pageLink = (n: number, label: string, disabled: boolean, current = false): string => {
    if (disabled) return `<span class="feed-page-link feed-page-disabled">${label}</span>`;
    if (current) return `<span class="feed-page-link feed-page-current">${label}</span>`;
    return `<a class="feed-page-link" href="?p=${n}${sortQs}#feed">${label}</a>`;
  };
  const paginationHtml = closedTotal > args.pageSize
    ? `
      <div class="feed-pagination">
        ${pageLink(1, '«', safePage === 1)}
        ${pageLink(Math.max(1, safePage - 1), '‹', safePage === 1)}
        <span class="feed-page-info">
          Страница <b>${safePage}</b> из <b>${totalPages}</b>
          <span class="dim">· ${closedTotal} закрытых сделок всего</span>
        </span>
        ${pageLink(Math.min(totalPages, safePage + 1), '›', safePage === totalPages)}
        ${pageLink(totalPages, '»', safePage === totalPages)}
      </div>
    `
    : '';

  const activeBlock = activeTrades.length > 0
    ? `
      <div class="feed-subsection">
        <div class="feed-subsection-title">
          <span class="pulse-dot active" aria-hidden="true"></span>
          Сейчас открыто: <b>${activeTrades.length}</b>
        </div>
      </div>
    `
    : '';

  const sortOptionsHtml = FEED_SORT_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === sort ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
  ).join('');
  const sortFormHtml = `
    <form method="GET" action="/account/trades#feed" class="feed-sort-form">
      <label for="feed-sort-select" class="feed-sort-label">Сортировка</label>
      <select id="feed-sort-select" name="sort" class="feed-sort-select"
              onchange="this.form.submit()">
        ${sortOptionsHtml}
      </select>
      <input type="hidden" name="p" value="1"/>
      <noscript><button class="feed-sort-apply" type="submit">Применить</button></noscript>
    </form>
  `;

  const closedBlock = closedTrades.length > 0
    ? `
      <div class="feed-subsection">
        <div class="feed-subsection-title">
          Закрытые · показано ${closedTrades.length} из ${closedTotal}
        </div>
        ${sortFormHtml}
      </div>
    `
    : '';

  // Only render the table block if there's at least one row in either
  // active or closed — otherwise the empty banner covers the whole page.
  const feedBlock = activeTrades.length > 0 || closedTrades.length > 0
    ? `
      <div class="section" id="feed">
        <div class="section-title">
          📋 Ваши сделки
          <span class="refresh-note">⟳ обновляется при перезагрузке</span>
        </div>

        ${activeBlock}
        ${closedBlock}

        <div class="card table-wrap">
          <table class="feed-table">
            <thead>
              <tr>
                <th>Стратегия</th>
                <th>Время сделки <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint);font-size:10.5px;">(UTC)</span></th>
                <th>Длительн.</th>
                <th>Сторона</th>
                <th class="right" title="Размер позиции в USDT — bybit_qty × средняя цена входа">Объём</th>
                <th class="right">Entry</th>
                <th class="right" title="Цена выхода для закрытых, safety SL (и расстояние в %) для активных">Exit / SL</th>
                <th class="right">P&amp;L</th>
                <th>Причина выхода</th>
              </tr>
            </thead>
            <tbody>${activeRows}${closedRows}</tbody>
          </table>
        </div>

        <div class="feed-reason-legend">
          <b>Расшифровка причин:</b>
          <span class="reason-pill reason-strat">По стратегии</span> — exit-сигнал LuxAlgo. ·
          <span class="reason-pill reason-sl">Стоп-лосс</span> — сработал safety SL. ·
          <span class="reason-pill reason-reverse">Разворот</span> — пришёл противоположный сигнал. ·
          <span class="reason-pill reason-time">Тайм-аут</span> — позиция > 24ч без сигнала. ·
          <span class="reason-pill reason-manual">Вручную</span> — закрыто вручную на Bybit.
        </div>

        ${paginationHtml}
      </div>
    `
    : '';

  const body = `
    ${localStyles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label"><a href="/account" class="cabinet-crumb">Личный кабинет</a> · Сделки</div>
        <h1 class="cabinet-title">История сделок</h1>
        <p class="trades-sub">
          Все сделки, исполненные на вашем счёте Bybit. Каждая запись —
          реальная позиция, открытая по сигналу подключённой стратегии.
          Кликните по тикеру стратегии, чтобы открыть её страницу
          с полной публичной статистикой.
        </p>
      </div>

      ${noTradesBanner}
      ${feedBlock}

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

/** Only the page-specific styles. The feed-table / reason-pill /
 *  side-long-short / feed-sort-* CSS lives in pageShell, so we don't
 *  re-declare those here — they'd just be duplicates. */
function localStyles(): string {
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

  .trades-back { text-align: center; margin-top: 28px; }
  .trades-back a { color: #8590a0; font-size: 13px; text-decoration: none; }
  .trades-back a:hover { color: #4ad991; }

  @media (max-width: 380px) {
    .cabinet-main { padding: 20px 12px 60px; }
  }
</style>
`;
}

/**
 * Track D — `/account` dashboard renderer.
 *
 * Five stat-cards in the header (subscription, API key, strategies,
 * open positions, total PnL) followed by a row of quick action links.
 * Visual identity matches landing.ts pageShell — same dark theme,
 * same .stat-card / .stat-grid CSS classes inherited from the public
 * site.
 *
 * Mobile help-icon (💬) is suppressed because the inline "Поддержка"
 * link in the cabinet body is more discoverable for paying users.
 */

import { pageShell } from '../strategies/landing.js';
import type { SubscriptionRow } from '../db/repos/user-subscriptions.js';
import type { ApiKeySummary } from '../db/repos/user-api-keys.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build the greeting headline.
 *  Priority: display_name → "Привет, {name}" / fallback → "Личный кабинет"
 *  Legacy users (registered before migration 021, no display_name) see
 *  the neutral "Личный кабинет" until they set their name. */
function greetingTitle(displayName: string | null): string {
  if (displayName && displayName.trim()) {
    return `Привет, <span class="cabinet-name">${escapeHtml(displayName.trim())}</span>`;
  }
  return 'Личный кабинет';
}

function fmtDaysLeft(accessUntil: number, now = Date.now()): {
  daysLeft: number;
  text: string;
  cls: string;
} {
  const ms = accessUntil - now;
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) {
    return { daysLeft: 0, text: `просрочено ${Math.abs(days)} дн.`, cls: 'sub-expired' };
  }
  if (days === 0) {
    return { daysLeft: 0, text: 'истекает сегодня', cls: 'sub-warn' };
  }
  if (days <= 3) {
    return { daysLeft: days, text: `${days} ${pluralDay(days)} осталось`, cls: 'sub-warn' };
  }
  return { daysLeft: days, text: `${days} ${pluralDay(days)} осталось`, cls: 'sub-ok' };
}

function pluralDay(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

function fmtDate(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function relativeAgo(ms: number | null): string {
  if (!ms) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec} сек назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  const days = Math.floor(hrs / 24);
  return `${days} дн назад`;
}

export function renderDashboard(args: {
  displayName: string | null;
  phone: string | null;
  subscription: SubscriptionRow | null;
  apiKey: ApiKeySummary | null;
  enabledStrategiesCount: number;
  totalStrategiesAvailable: number;
  totalNotionalUsd: number;
  openPositionsCount: number;
  closedPositionsCount: number;
  totalPnlPct: number | null;
}): string {
  const sub = args.subscription;
  const subBlock = sub
    ? renderSubscriptionCard(sub)
    : renderSubscriptionCard(null);

  const apiKeyBlock = renderApiKeyCard(args.apiKey);

  const strategiesBlock = renderStrategiesCard({
    enabled: args.enabledStrategiesCount,
    available: args.totalStrategiesAvailable,
    notional: args.totalNotionalUsd,
  });

  const openBlock = renderOpenPositionsCard(args.openPositionsCount);

  const pnlBlock = renderPnlCard({
    pnlPct: args.totalPnlPct,
    closedCount: args.closedPositionsCount,
  });

  // Support link removed from the body — already lives in the site header
  // ("Поддержка" nav link) and was visually duplicating it here.
  const greeting = `
    <div class="cabinet-greeting">
      <div class="cabinet-greeting-label">Личный кабинет</div>
      <h1 class="cabinet-title">${greetingTitle(args.displayName)}</h1>
    </div>
  `;

  const cards = `
    <div class="cabinet-stat-grid">
      ${subBlock}
      ${apiKeyBlock}
      ${strategiesBlock}
      ${openBlock}
      ${pnlBlock}
    </div>
  `;

  const quickLinks = `
    <div class="cabinet-actions">
      <a class="cabinet-action" href="/account/strategies">
        <div class="cabinet-action-title">${ico('⚙️')}Мои стратегии</div>
        <div class="cabinet-action-sub">Включить, выключить, изменить размер позиции и плечо</div>
      </a>
      <a class="cabinet-action" href="/account/api-key">
        <div class="cabinet-action-title">${ico('🔑')}Подключение Bybit</div>
        <div class="cabinet-action-sub">API-ключ для исполнения сделок на вашем счёте</div>
      </a>
      <a class="cabinet-action" href="/account/trades">
        <div class="cabinet-action-title">${ico('📈')}История сделок</div>
        <div class="cabinet-action-sub">Все ваши сделки по подключённым стратегиям</div>
      </a>
      <a class="cabinet-action" href="/account/subscription">
        <div class="cabinet-action-title">${ico('💳')}Подписка</div>
        <div class="cabinet-action-sub">Статус доступа и продление</div>
      </a>
    </div>
  `;

  const body = `
    ${cabinetStyles()}
    <main class="cabinet-main">
      ${greeting}
      ${cards}
      ${quickLinks}
    </main>
  `;

  return pageShell('Личный кабинет · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
  });
}

/** Emoji span with consistent right-margin so the icon never visually
 *  collides with the following uppercase label. Used everywhere a
 *  card label or action title leads with an emoji. */
function ico(emoji: string): string {
  return `<span class="cabinet-ico" aria-hidden="true">${emoji}</span>`;
}

function renderSubscriptionCard(sub: SubscriptionRow | null): string {
  if (!sub) {
    return `
      <div class="stat-card cabinet-card cabinet-card-warn">
        <div class="stat-card-label">Подписка</div>
        <div class="stat-card-value">—</div>
        <div class="stat-card-sub">Не активирована</div>
      </div>
    `;
  }
  // VIP short-circuits all lifecycle states. No countdown, no expiry.
  if (sub.plan === 'vip' && sub.status !== 'cancelled') {
    return `
      <div class="stat-card cabinet-card cabinet-card-vip">
        <div class="stat-card-label">${ico('👑')}VIP-доступ</div>
        <div class="stat-card-value">Активна</div>
        <div class="stat-card-sub">постоянная подписка · без ограничений</div>
      </div>
    `;
  }
  const isCancelled = sub.status === 'cancelled';
  const days = fmtDaysLeft(sub.access_until);
  let title = '';
  let emoji = '';
  let cls = '';
  if (sub.status === 'cancelled') {
    title = 'Отменена';
    emoji = '⏸';
    cls = 'cabinet-card-warn';
  } else if (sub.status === 'expired' || days.daysLeft === 0) {
    title = 'Истекла';
    emoji = '⛔';
    cls = 'cabinet-card-warn';
  } else if (sub.status === 'trial') {
    title = 'Демо доступ';
    emoji = '🎁';
    cls = days.cls === 'sub-warn' ? 'cabinet-card-warn' : 'cabinet-card-ok';
  } else {
    title = 'Активна';
    emoji = '✅';
    cls = 'cabinet-card-ok';
  }
  const accessDateStr = fmtDate(sub.access_until);
  return `
    <div class="stat-card cabinet-card ${cls}">
      <div class="stat-card-label">${ico(emoji)}Подписка</div>
      <div class="stat-card-value">${title}</div>
      <div class="stat-card-sub">${isCancelled ? '—' : `${escapeHtml(days.text)} · до ${accessDateStr}`}</div>
    </div>
  `;
}

function renderApiKeyCard(key: ApiKeySummary | null): string {
  if (!key) {
    return `
      <div class="stat-card cabinet-card cabinet-card-warn">
        <div class="stat-card-label">${ico('🔑')}API-ключ Bybit</div>
        <div class="stat-card-value">Не подключён</div>
        <div class="stat-card-sub"><a href="/account/api-key">Подключить →</a></div>
      </div>
    `;
  }
  if (key.revoked_at) {
    return `
      <div class="stat-card cabinet-card cabinet-card-warn">
        <div class="stat-card-label">${ico('🔑')}API-ключ Bybit</div>
        <div class="stat-card-value">Отозван</div>
        <div class="stat-card-sub"><a href="/account/api-key">Подключить новый →</a></div>
      </div>
    `;
  }
  if (key.last_verify_error) {
    return `
      <div class="stat-card cabinet-card cabinet-card-warn">
        <div class="stat-card-label">${ico('🔑')}API-ключ Bybit</div>
        <div class="stat-card-value">Ошибка проверки</div>
        <div class="stat-card-sub">${escapeHtml(key.last_verify_error)} · <a href="/account/api-key">обновить →</a></div>
      </div>
    `;
  }
  return `
    <div class="stat-card cabinet-card cabinet-card-ok">
      <div class="stat-card-label">${ico('🔑')}API-ключ Bybit</div>
      <div class="stat-card-value">Подключён</div>
      <div class="stat-card-sub">проверен ${relativeAgo(key.last_verified_at)}</div>
    </div>
  `;
}

function renderStrategiesCard(args: {
  enabled: number;
  available: number;
  notional: number;
}): string {
  const label = args.enabled === 0
    ? 'Не выбраны'
    : `${args.enabled} из ${args.available}`;
  const sub = args.enabled === 0
    ? `<a href="/account/strategies">Выбрать стратегии →</a>`
    : `общий депозит $${args.notional.toFixed(0)}`;
  return `
    <div class="stat-card cabinet-card">
      <div class="stat-card-label">${ico('⚙️')}Стратегии</div>
      <div class="stat-card-value">${label}</div>
      <div class="stat-card-sub">${sub}</div>
    </div>
  `;
}

function renderOpenPositionsCard(openNow: number): string {
  const sub = openNow > 0
    ? `<a href="/account/trades">Смотреть позиции →</a>`
    : 'ожидаем сигнал стратегии';
  return `
    <div class="stat-card cabinet-card">
      <div class="stat-card-label">${ico('📊')}Открытых позиций</div>
      <div class="stat-card-value">${openNow}</div>
      <div class="stat-card-sub">${sub}</div>
    </div>
  `;
}

function renderPnlCard(args: { pnlPct: number | null; closedCount: number }): string {
  if (args.closedCount === 0 || args.pnlPct === null) {
    return `
      <div class="stat-card cabinet-card">
        <div class="stat-card-label">${ico('📈')}Результат</div>
        <div class="stat-card-value">—</div>
        <div class="stat-card-sub">сделок ещё не было</div>
      </div>
    `;
  }
  const sign = args.pnlPct >= 0 ? '+' : '';
  const cls = args.pnlPct >= 0 ? 'cabinet-card-ok' : 'cabinet-card-bad';
  return `
    <div class="stat-card cabinet-card ${cls}">
      <div class="stat-card-label">${ico('📈')}Результат</div>
      <div class="stat-card-value">${sign}${args.pnlPct.toFixed(2)}%</div>
      <div class="stat-card-sub">${args.closedCount} сделок закрыто</div>
    </div>
  `;
}

/** Cabinet-local styles. Inherits .stat-card / .stat-card-value /
 *  .stat-card-sub / .stat-card-label from the landing's global CSS
 *  (no duplication). Only the cabinet-specific layout pieces and
 *  status colour modifiers are defined here. */
function cabinetStyles(): string {
  return `
<style>
  .cabinet-main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 28px 20px 80px;
  }
  .cabinet-greeting {
    margin-bottom: 28px;
  }
  .cabinet-greeting-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #6b7480;
    margin-bottom: 6px;
  }
  .cabinet-title {
    font-size: 26px;
    font-weight: 600;
    margin: 0;
    color: #e8edf2;
  }
  .cabinet-name {
    color: #4ad991;
  }
  /* Emoji wrapper — explicit margin so the icon never visually collides
     with the uppercase / letter-spaced label that follows it. Also
     normalises emoji width across system font stacks (Apple Color Emoji
     vs Segoe UI Emoji vs Noto). */
  .cabinet-ico {
    display: inline-block;
    margin-right: 8px;
    font-style: normal;
    font-size: 1.05em;
    line-height: 1;
    vertical-align: -1px;
  }
  .cabinet-stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
    margin-bottom: 32px;
  }
  .cabinet-card {
    border: 1px solid #1f2630;
    background: #11161d;
    border-radius: 14px;
    padding: 18px 18px 16px;
    transition: border-color 0.15s;
  }
  .cabinet-card-ok { border-color: rgba(74, 217, 145, 0.35); }
  .cabinet-card-warn { border-color: rgba(255, 188, 70, 0.40); }
  .cabinet-card-bad { border-color: rgba(255, 99, 99, 0.40); }
  .cabinet-card-vip {
    border-color: rgba(212, 175, 55, 0.55);
    background: linear-gradient(180deg, #1a1611 0%, #11161d 70%);
  }
  .cabinet-card-vip .stat-card-value { color: #f3d266; }
  .cabinet-card .stat-card-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7a8593;
    margin-bottom: 8px;
  }
  .cabinet-card .stat-card-value {
    font-size: 22px;
    font-weight: 600;
    color: #e8edf2;
    margin-bottom: 6px;
    line-height: 1.15;
  }
  .cabinet-card .stat-card-sub {
    font-size: 12.5px;
    color: #9aa5b1;
  }
  .cabinet-card .stat-card-sub a {
    color: #4ad991;
    text-decoration: none;
  }
  .cabinet-card .stat-card-sub a:hover { text-decoration: underline; }

  .cabinet-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }
  .cabinet-action {
    display: block;
    padding: 18px 20px;
    border: 1px solid #1f2630;
    border-radius: 12px;
    background: #11161d;
    color: #e8edf2;
    text-decoration: none;
    transition: border-color 0.15s, transform 0.15s;
  }
  .cabinet-action:hover {
    border-color: #4ad991;
    transform: translateY(-1px);
  }
  .cabinet-action-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .cabinet-action-sub {
    font-size: 12.5px;
    color: #8590a0;
    line-height: 1.45;
  }

  @media (max-width: 540px) {
    .cabinet-title { font-size: 22px; }
  }
</style>
`;
}

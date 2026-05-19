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
import type { MarginState } from './margin.js';

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
  margin: MarginState;
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

  // Margin banner: red full-width strip shown ONLY when the user is
  // currently flagged as having insufficient balance. Either the cron
  // set the flag (computed deficit), or fan-out just hit a rejected
  // order. Either way, message + CTA to /account/api-key.
  const marginBanner = renderMarginBanner(args);
  // Status banner: shown when marginBanner doesn't apply. Tells the
  // user explicitly whether trading is active, paused, missing config,
  // etc. Mutually exclusive with marginBanner — they're both at the top.
  const statusBanner = marginBanner ? '' : renderStatusBanner(args);

  const marginCard = renderMarginCard(args.margin, args.enabledStrategiesCount);

  const cards = `
    <div class="cabinet-stat-grid">
      ${subBlock}
      ${apiKeyBlock}
      ${strategiesBlock}
      ${marginCard}
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
      ${marginBanner}
      ${statusBanner}
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

/** Full-width red banner shown when the user's wallet doesn't have
 *  enough margin to cover their enabled strategies. Two trigger paths:
 *
 *  1. balance-monitor cron observed `balance < required + used`
 *     → set insufficient_balance_at, flag is non-null here
 *  2. fan-out hit a Bybit 110007/110012 rejection
 *     → same flag set, same display
 *
 *  We render the SAME banner for both. Body adapts to whichever data
 *  is available (live computed deficit vs cached snapshot from the
 *  rejection). Always shows the CTA "Пополните Derivatives + Проверить
 *  связь" with the api-key route link. */
function renderMarginBanner(args: {
  margin: MarginState;
  enabledStrategiesCount: number;
}): string {
  const m = args.margin;
  const flagged = m.insufficientBalanceAt !== null;
  const computedShort =
    m.balanceUsdt !== null &&
    m.requiredUsdt > 0 &&
    m.freeUsdt !== null &&
    m.freeUsdt < m.requiredUsdt;
  if (!flagged && !computedShort) return '';
  // Don't show the banner for users with zero enabled strategies —
  // there's no margin to be short of. The cron also won't flag them.
  if (args.enabledStrategiesCount === 0) return '';

  const balance = m.balanceUsdt !== null ? `$${m.balanceUsdt.toFixed(2)}` : '—';
  const required = `$${m.requiredUsdt.toFixed(2)}`;
  const used = `$${m.usedUsdt.toFixed(2)}`;
  const deficitHint = m.deficitUsdt !== null && m.deficitUsdt > 0
    ? `Не хватает: <b>$${m.deficitUsdt.toFixed(2)}</b>.`
    : '';
  return `
    <div class="cabinet-banner-bad">
      <div class="cabinet-banner-icon">${ico('💸')}</div>
      <div class="cabinet-banner-body">
        <div class="cabinet-banner-title">Недостаточно средств на фьючерсном счёте Bybit</div>
        <div class="cabinet-banner-text">
          Баланс: <b>${balance}</b> · Нужно: <b>${required}</b> (под все включённые стратегии)${m.usedUsdt > 0 ? ` · В позициях: <b>${used}</b>` : ''}.
          ${deficitHint}
          <br/>
          Пока баланса недостаточно — <b>новые сделки система не открывает</b>. Уже открытые позиции продолжают работать.
          <br/>
          Пополните USDT-кошелёк раздела <b>Derivatives</b> в Bybit (или переведите из Funding/Spot во фьючерсный кошелёк) —
          в течение 5 минут мы проверим баланс и снова включим вас в сигналы.
        </div>
        <div class="cabinet-banner-actions">
          <a class="cabinet-banner-btn" href="/account/api-key">Проверить связь →</a>
          <a class="cabinet-banner-btn cabinet-banner-btn-secondary" href="/account/strategies">Изменить стратегии</a>
        </div>
      </div>
    </div>
  `;
}

/**
 * Status banner — top-of-dashboard explicit "what's happening" strip.
 *
 * Three states (mutually exclusive, in priority order):
 *
 *   - missing setup → amber. Subscription card / api-key card already
 *     visualise the specific gap; this banner just adds an explicit
 *     line so the user can't miss it ("выберите стратегии", etc).
 *
 *   - paused → amber. trading_paused_at is set; trading is off until
 *     user resumes it from /account/strategies.
 *
 *   - all-green → green. Subscription active, key verified, strategies
 *     enabled, margin sufficient, not paused. The user needed a way to
 *     confirm "yes, everything's running, just waiting for a signal" —
 *     this is it.
 *
 * Returns '' when the user has no subscription / no key — those cases
 * surface their own warning cards and a banner would be redundant.
 */
function renderStatusBanner(args: {
  subscription: SubscriptionRow | null;
  apiKey: ApiKeySummary | null;
  enabledStrategiesCount: number;
  margin: MarginState;
}): string {
  const sub = args.subscription;
  const key = args.apiKey;

  // Subscription gates — if any fail, show no banner. The Sub /
  // ApiKey cards already shout the issue with a contrasting border
  // and a direct link, and we don't want to compete with them.
  if (!sub) return '';
  if (sub.status === 'expired' || sub.status === 'cancelled') return '';
  if (!key || key.revoked_at !== null) return '';
  if (key.last_verified_at === null || key.last_verify_error) return '';

  // Strategy gate — amber, with a clear CTA.
  if (args.enabledStrategiesCount === 0) {
    return `
      <div class="cabinet-banner-amber">
        <div class="cabinet-banner-icon">${ico('⚙️')}</div>
        <div class="cabinet-banner-body">
          <div class="cabinet-banner-title-amber">Выберите стратегии для автоматической торговли</div>
          <div class="cabinet-banner-text">
            Ключ Bybit подключён, доступ активен — осталось включить хотя бы одну стратегию
            и указать размер позиции. После этого бот начнёт торговать по сигналам.
          </div>
          <div class="cabinet-banner-actions">
            <a class="cabinet-banner-btn" href="/account/strategies">Выбрать стратегии →</a>
          </div>
        </div>
      </div>
    `;
  }

  // Paused gate — amber. User can resume from /account/strategies.
  if (sub.trading_paused_at !== null) {
    return `
      <div class="cabinet-banner-amber">
        <div class="cabinet-banner-icon">${ico('⏸')}</div>
        <div class="cabinet-banner-body">
          <div class="cabinet-banner-title-amber">Торговля на паузе</div>
          <div class="cabinet-banner-text">
            Вы остановили автоматическую торговлю. Новые сделки не открываются.
            Уже открытые позиции продолжают работать со стопами.
          </div>
          <div class="cabinet-banner-actions">
            <a class="cabinet-banner-btn" href="/account/strategies">Возобновить торговлю →</a>
          </div>
        </div>
      </div>
    `;
  }

  // All-green path. Mention margin state inline so the user sees the
  // exact numbers without scrolling — confirms "we know your balance
  // is enough, we're tracking signals".
  const m = args.margin;
  const hasBalanceInfo = m.balanceUsdt !== null && args.enabledStrategiesCount > 0;
  const marginLine = hasBalanceInfo
    ? `Обеспечения хватает: свободно <b>$${(m.freeUsdt ?? 0).toFixed(2)}</b>, нужно <b>$${m.requiredUsdt.toFixed(2)}</b> при одновременном срабатывании всех стратегий.`
    : '';
  return `
    <div class="cabinet-banner-ok">
      <div class="cabinet-banner-icon">${ico('✅')}</div>
      <div class="cabinet-banner-body">
        <div class="cabinet-banner-title-ok">Всё готово — стратегии активны</div>
        <div class="cabinet-banner-text">
          ${args.enabledStrategiesCount} ${pluralStrategy(args.enabledStrategiesCount)} включено,
          ключ Bybit подключён, доступ активен.
          <b>Ждём сигнал стратегии</b> — как только сработает, бот откроет позицию на вашем счёте автоматически.
          ${marginLine ? `<br/>${marginLine}` : ''}
        </div>
      </div>
    </div>
  `;
}

function pluralStrategy(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'стратегия';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'стратегии';
  return 'стратегий';
}

/** Stat card showing margin breakdown — balance / required / used / free.
 *  Always visible (even when ok) so the user understands the model and
 *  can plan ahead. Colour reflects status:
 *    - red    when deficit > 0 OR flag set
 *    - amber  when free < required × 1.2 (close to the edge)
 *    - green  otherwise */
function renderMarginCard(m: MarginState, enabledCount: number): string {
  if (enabledCount === 0) {
    return `
      <div class="stat-card cabinet-card">
        <div class="stat-card-label">${ico('💵')}Обеспечение</div>
        <div class="stat-card-value">—</div>
        <div class="stat-card-sub">Выберите стратегии чтобы увидеть расчёт</div>
      </div>
    `;
  }
  if (m.balanceUsdt === null) {
    return `
      <div class="stat-card cabinet-card cabinet-card-warn">
        <div class="stat-card-label">${ico('💵')}Обеспечение</div>
        <div class="stat-card-value">Нужно: $${m.requiredUsdt.toFixed(2)}</div>
        <div class="stat-card-sub"><a href="/account/api-key">Подключите ключ для проверки баланса →</a></div>
      </div>
    `;
  }
  const flagged = m.insufficientBalanceAt !== null;
  const free = m.freeUsdt ?? 0;
  const isShort = flagged || free < m.requiredUsdt;
  const isClose = !isShort && free < m.requiredUsdt * 1.2;
  const cls = isShort ? 'cabinet-card-bad' : isClose ? 'cabinet-card-warn' : 'cabinet-card-ok';
  const statusEmoji = isShort ? '⚠️' : isClose ? '⚡' : '✅';
  const statusText = isShort
    ? `Не хватает $${Math.max(0, m.requiredUsdt - free).toFixed(2)}`
    : isClose
      ? `Запас тонкий`
      : `Хватает с запасом`;
  return `
    <div class="stat-card cabinet-card ${cls}">
      <div class="stat-card-label">${ico('💵')}Обеспечение</div>
      <div class="stat-card-value">${statusEmoji} $${free.toFixed(2)}</div>
      <div class="stat-card-sub">
        нужно $${m.requiredUsdt.toFixed(2)} · ${statusText}
        <br/>
        <span style="opacity:0.7">баланс $${m.balanceUsdt.toFixed(2)}${m.usedUsdt > 0 ? ` · в позициях $${m.usedUsdt.toFixed(2)}` : ''}</span>
      </div>
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

  /* Full-width green "everything's running" banner — same shape as
     the red insufficient-balance banner, different palette. */
  .cabinet-banner-ok {
    display: flex;
    gap: 16px;
    padding: 16px 22px;
    margin: 0 0 24px;
    background: linear-gradient(180deg, rgba(74, 217, 145, 0.10) 0%, rgba(74, 217, 145, 0.04) 100%);
    border: 1px solid rgba(74, 217, 145, 0.40);
    border-radius: 14px;
    color: #cfd6dd;
    align-items: flex-start;
  }
  .cabinet-banner-title-ok {
    font-size: 15px;
    font-weight: 600;
    color: #4ad991;
    margin-bottom: 6px;
  }
  /* Amber banner — needs-action variants (no strategies enabled,
     trading paused, etc). */
  .cabinet-banner-amber {
    display: flex;
    gap: 16px;
    padding: 16px 22px;
    margin: 0 0 24px;
    background: linear-gradient(180deg, rgba(255, 188, 70, 0.10) 0%, rgba(255, 188, 70, 0.04) 100%);
    border: 1px solid rgba(255, 188, 70, 0.45);
    border-radius: 14px;
    color: #cfd6dd;
    align-items: flex-start;
  }
  .cabinet-banner-title-amber {
    font-size: 15px;
    font-weight: 600;
    color: #ffbc46;
    margin-bottom: 6px;
  }
  /* Full-width red insufficient-balance banner */
  .cabinet-banner-bad {
    display: flex;
    gap: 16px;
    padding: 18px 22px;
    margin: 0 0 24px;
    background: linear-gradient(180deg, rgba(255, 99, 99, 0.12) 0%, rgba(255, 99, 99, 0.06) 100%);
    border: 1px solid rgba(255, 99, 99, 0.45);
    border-radius: 14px;
    color: #e8c5c5;
    align-items: flex-start;
  }
  .cabinet-banner-icon {
    font-size: 28px;
    line-height: 1;
    flex-shrink: 0;
  }
  .cabinet-banner-icon .cabinet-ico { margin-right: 0; }
  .cabinet-banner-body { flex: 1; }
  .cabinet-banner-title {
    font-size: 15px;
    font-weight: 600;
    color: #ff8b8b;
    margin-bottom: 8px;
  }
  .cabinet-banner-text {
    font-size: 13.5px;
    line-height: 1.6;
    color: #cfd6dd;
    margin-bottom: 12px;
  }
  .cabinet-banner-text b { color: #ffd17a; }
  .cabinet-banner-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .cabinet-banner-btn {
    display: inline-block;
    padding: 8px 16px;
    border-radius: 8px;
    background: #4ad991;
    color: #0b0e13;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }
  .cabinet-banner-btn:hover { background: #5ce0a0; }
  .cabinet-banner-btn-secondary {
    background: transparent;
    color: #cfd6dd;
    border: 1px solid #2a323d;
  }
  .cabinet-banner-btn-secondary:hover {
    border-color: #4ad991;
    color: #fff;
  }

  @media (max-width: 540px) {
    .cabinet-title { font-size: 22px; }
    .cabinet-banner-bad,
    .cabinet-banner-ok,
    .cabinet-banner-amber { flex-direction: column; }
  }
</style>
`;
}

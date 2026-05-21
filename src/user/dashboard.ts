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
import { TIER_CONFIGS, TIER_ORDER, type TierId } from '../strategies/tier-config.js';
import { csrfInput } from '../auth/csrf.js';

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
  /** CSRF token for upgrade form. Issued by the GET handler. */
  csrfToken?: string;
}): string {
  const sub = args.subscription;
  const subBlock = sub
    ? renderSubscriptionCard(sub)
    : renderSubscriptionCard(null);

  const apiKeyBlock = renderApiKeyCard(args.apiKey);

  // TRACK E — tier card replaces the generic strategies-count card
  // for non-VIP users. VIP keeps the manual one (their strategies are
  // operator-defined, not tier-derived).
  //
  // Phase E follow-up: only show the tier card AFTER user explicitly
  // picks a tier. Heuristic = user_strategies rows exist (enabledStrategiesCount > 0).
  // Before that, render a "Тариф не выбран" prompt — the default
  // tier_id='standard' inserted by ensureTrialFor is misleading otherwise
  // (user sees Standard before connecting Bybit or picking anything).
  const isVip = sub?.plan === 'vip';
  let strategiesBlock: string;
  if (isVip) {
    strategiesBlock = renderStrategiesCard({
      enabled: args.enabledStrategiesCount,
      available: args.totalStrategiesAvailable,
      notional: args.totalNotionalUsd,
    });
  } else if (sub?.tier_id && args.enabledStrategiesCount > 0) {
    strategiesBlock = renderTierStatCard(sub.tier_id as TierId);
  } else {
    strategiesBlock = renderTierUnsetCard(
      args.apiKey,
      args.margin.balanceUsdt,
      sub?.selected_tier_id ?? null,
    );
  }

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
        <div class="cabinet-action-title">${ico('⚙️')}Стратегии в работе</div>
        <div class="cabinet-action-sub">Какие стратегии торгуют на вашем счёте и с каким размером позиции</div>
      </a>
      <a class="cabinet-action" href="/account/subscription/select-tier">
        <div class="cabinet-action-title">${ico('💳')}Сменить тариф</div>
        <div class="cabinet-action-sub">Выбрать другой тариф автотрейдинга под текущий депозит</div>
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

  // TRACK E Phase C — onboarding checklist. Shows new users what's
  // left to do (connect key, top up balance) until trading actually
  // starts. Hidden once all checkpoints are complete + first trade
  // is open. For VIP override users we skip the checklist.
  const onboardingChecklist = renderOnboardingChecklist(args);

  // TRACK E — upgrade promo. Shown when balance-monitor noted that
  // user's balance moved them up a tier (tier_transition_target_id set
  // to a HIGHER tier). User clicks to confirm — applyUpgrade via POST.
  const upgradePromo = renderUpgradePromo(args);

  const body = `
    ${cabinetStyles()}
    <main class="cabinet-main">
      ${greeting}
      ${marginBanner}
      ${statusBanner}
      ${onboardingChecklist}
      ${upgradePromo}
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

/** Phase G follow-up — pre-activation tier card. Three states:
 *   - No Bybit key connected yet → ask to connect first.
 *   - Key connected, no tier picked → CTA «Выбрать тариф».
 *   - Tier picked but not yet activated (balance < min) → show shortfall.
 *  Deposit gating is handled INSIDE the picker page (where the
 *  «Проверить баланс» button lives), so this card no longer
 *  intermediates a separate "deposit first, then pick" flow.
 */
function renderTierUnsetCard(
  apiKey: ApiKeySummary | null,
  balanceUsdt: number | null,
  selectedTierId: string | null,
): string {
  const keyConnected = !!(apiKey && apiKey.last_verified_at && !apiKey.revoked_at);
  let body = '';
  if (!keyConnected) {
    body = `
      <div class="stat-card-value" style="font-size:18px">Подключите Bybit</div>
      <div class="stat-card-sub" style="line-height:1.6">
        После подключения API-ключа сможете выбрать тариф.
        <br/>
        <a href="/account/api-key" style="color:#4ad991; text-decoration:none">Подключить ключ →</a>
      </div>
    `;
  } else if (selectedTierId) {
    const tier = TIER_CONFIGS[selectedTierId as TierId];
    const cur = balanceUsdt !== null ? balanceUsdt : 0;
    const need = tier ? Math.max(0, tier.minBalanceUsdt - cur) : 0;
    body = `
      <div class="stat-card-value" style="font-size:18px">${tier?.name ?? 'Тариф'} · ждём депозит</div>
      <div class="stat-card-sub" style="line-height:1.6">
        Нужно <b style="color:#f3d266">$${need.toFixed(0)}</b> на Bybit для активации.
        Пополните Unified Trading Account (единый торговый аккаунт).
        <br/>
        <a href="/account/subscription/select-tier" style="color:#4ad991; text-decoration:none">Проверить баланс →</a>
      </div>
    `;
  } else {
    body = `
      <div class="stat-card-value" style="font-size:18px">Тариф не выбран</div>
      <div class="stat-card-sub" style="line-height:1.6">
        Выберите план под размер депозита. Можно сменить в любой момент.
        <br/>
        <a href="/account/subscription/select-tier" style="color:#4ad991; text-decoration:none; font-weight:600">Выбрать тариф →</a>
      </div>
    `;
  }
  return `
    <div class="stat-card cabinet-card">
      <div class="stat-card-label">${ico('💳')}Тариф автотрейдинга</div>
      ${body}
    </div>
  `;
}

/** TRACK E — tier-card replaces the generic strategies-count card.
 *  Shows tier name, expected PnL range, max DD, and # strategies. */
function renderTierStatCard(tierId: TierId): string {
  const tier = TIER_CONFIGS[tierId];
  if (!tier) return '';
  const emoji = tierEmoji(tierId);
  const sub = tier.expectedMonthlyPnlRangeUsd;
  return `
    <div class="stat-card cabinet-card">
      <div class="stat-card-label">${ico(emoji)}Ваш тариф</div>
      <div class="stat-card-value">${tier.name}</div>
      <div class="stat-card-sub">
        ${tier.strategyIds.length} стратегий · ≤${tier.expectedMaxDdPct}% DD
        <br/>
        <span style="color:#4ad991">$${sub.low}–$${sub.high}/мес</span> по бэктесту
        <br/>
        <a href="/account/subscription/select-tier" style="color:#8590a0; font-size:11.5px; text-decoration:underline">Сменить тариф →</a>
      </div>
    </div>
  `;
}

function tierEmoji(tierId: TierId): string {
  switch (tierId) {
    case 'starter': return '🥉';
    case 'standard': return '🥈';
    case 'plus': return '🥇';
    case 'pro': return '🏆';
    case 'vip': return '👑';
  }
}

/**
 * TRACK E Phase C — onboarding checklist.
 *
 * For new users guides them step-by-step from registration → first
 * trade. Each checkpoint either shows a green ✓ (done) or an amber
 * action button (CTA to next step). Hidden when all done OR when
 * user has VIP override (operator setup).
 *
 * Checkpoints (Phase G follow-up — 4 steps, deposit folded INTO tier-picker
 * page where the "Проверить баланс" button lives):
 *   1. Регистрация (always done — user is in /account)
 *   2. Подключение Bybit (api_key.last_verified_at !== null)
 *   3. Выбор тарифа и активация
 *       - "done" when tier is actually activated (user_strategies > 0)
 *       - "current" if not yet activated; CTA leads to /select-tier
 *         where the user picks + tops up + clicks "Проверить баланс"
 *         (assignTier auto-fires when balance is sufficient).
 *   4. Стратегии работают (openCount + closedCount > 0)
 */
function renderOnboardingChecklist(args: {
  subscription: SubscriptionRow | null;
  apiKey: ApiKeySummary | null;
  enabledStrategiesCount: number;
  openPositionsCount: number;
  closedPositionsCount: number;
  margin: MarginState;
  csrfToken?: string;
}): string {
  const sub = args.subscription;
  if (!sub) return '';
  if (sub.plan === 'vip') return ''; // VIP override = bypass onboarding

  // Compute checkpoint statuses.
  const keyConnected = !!(args.apiKey && args.apiKey.last_verified_at && !args.apiKey.revoked_at);
  const tierActivated = args.enabledStrategiesCount > 0;
  const tradingStarted = args.openPositionsCount + args.closedPositionsCount > 0;

  // If all done → hide. User no longer needs the wizard.
  if (keyConnected && tierActivated && tradingStarted) return '';

  type CtaLink = { kind: 'link'; label: string; href: string; primary?: boolean };
  type CtaForm = { kind: 'form'; label: string; action: string; primary?: boolean };
  type Cta = CtaLink | CtaForm;
  type Step = { num: number; title: string; done: boolean; ctas?: Cta[] };

  // Step 3 title is dynamic to reflect state:
  //   - tier picked but balance insufficient → "Выбор тарифа · ждём депозит для {Tier}"
  //   - tier picked + activated → "Тариф {Tier} активирован" (will be done=true)
  //   - nothing picked → "Выбор тарифа и активация"
  const selectedTierObj = sub.selected_tier_id
    ? TIER_CONFIGS[sub.selected_tier_id as TierId]
    : null;
  let tierStepTitle = 'Выбор тарифа и активация';
  if (tierActivated && selectedTierObj) {
    tierStepTitle = `Тариф ${selectedTierObj.name} активирован`;
  } else if (selectedTierObj) {
    tierStepTitle = `Выбран ${selectedTierObj.name} · нужен депозит $${selectedTierObj.minBalanceUsdt}+`;
  }

  const steps: Step[] = [
    { num: 1, title: 'Регистрация', done: true },
    {
      num: 2,
      title: 'Подключение Bybit',
      done: keyConnected,
      ctas: keyConnected
        ? undefined
        : [{ kind: 'link', label: 'Подключить ключ →', href: '/account/api-key', primary: true }],
    },
    {
      num: 3,
      title: tierStepTitle,
      done: tierActivated,
      ctas: tierActivated || !keyConnected
        ? undefined
        : [{
            kind: 'link',
            label: sub.selected_tier_id ? 'Открыть выбор тарифа →' : 'Выбрать тариф →',
            href: '/account/subscription/select-tier',
            primary: true,
          }],
    },
    {
      num: 4,
      title: 'Стратегии работают',
      done: tradingStarted,
      ctas: undefined,
    },
  ];

  const stepsHtml = steps
    .map((s) => {
      const cls = s.done ? 'done' : steps.findIndex((x) => !x.done) === steps.indexOf(s) ? 'current' : 'pending';
      const ctaHtml = (s.ctas ?? []).map((c) => {
        const btnCls = c.primary ? 'onboarding-cta' : 'onboarding-cta onboarding-cta-ghost';
        if (c.kind === 'link') {
          const external = c.href.startsWith('http');
          return `<a class="${btnCls}" href="${escapeHtml(c.href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(c.label)}</a>`;
        }
        // form CTA (POST with csrf)
        return `
          <form method="POST" action="${escapeHtml(c.action)}" style="display:inline">
            <input type="hidden" name="_csrf" value="${escapeHtml(args.csrfToken ?? '')}"/>
            <button type="submit" class="${btnCls}">${escapeHtml(c.label)}</button>
          </form>
        `;
      }).join('');
      return `
        <div class="onboarding-step ${cls}">
          <div class="onboarding-marker">${s.done ? '✓' : s.num}</div>
          <div class="onboarding-body">
            <div class="onboarding-title">${escapeHtml(s.title)}</div>
            ${ctaHtml ? `<div class="onboarding-cta-row">${ctaHtml}</div>` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  const doneCount = steps.filter((s) => s.done).length;

  return `
    <div class="onboarding-checklist">
      <div class="onboarding-header">
        <div class="onboarding-h-left">
          <div class="onboarding-h-title">${ico('🎯')}Что осталось сделать</div>
          <div class="onboarding-h-sub">${doneCount} из ${steps.length} шагов выполнено</div>
        </div>
        <div class="onboarding-progress">
          <div class="onboarding-progress-bar" style="width:${Math.round((doneCount / steps.length) * 100)}%"></div>
        </div>
      </div>
      <div class="onboarding-steps">${stepsHtml}</div>
    </div>
  `;
}

/** Upgrade promo banner. Shown when balance-monitor saw the user's
 *  balance climb above their current tier's max — tier_transition_target_id
 *  points at a HIGHER tier. User clicks «Перейти» to confirm; we don't
 *  auto-apply upgrades because they increase the subscription price. */
function renderUpgradePromo(args: {
  subscription: SubscriptionRow | null;
  csrfToken?: string;
}): string {
  const sub = args.subscription;
  if (!sub || sub.plan === 'vip') return '';
  const targetTier = sub.tier_transition_target_id as TierId | null;
  if (!targetTier) return '';
  const currentTier = sub.tier_id as TierId;
  const fromIdx = TIER_ORDER.indexOf(currentTier);
  const toIdx = TIER_ORDER.indexOf(targetTier);
  if (toIdx <= fromIdx) return ''; // only upgrades, not downgrade-pending
  const target = TIER_CONFIGS[targetTier];
  if (!target) return '';
  const current = TIER_CONFIGS[currentTier];
  const expectedDelta = target.expectedMonthlyPnlRangeUsd.low - current.expectedMonthlyPnlRangeUsd.low;
  return `
    <div class="cabinet-banner-promo">
      <div class="cabinet-banner-icon">${ico('🚀')}</div>
      <div class="cabinet-banner-body">
        <div class="cabinet-banner-title-promo">Доступен новый тариф: ${tierEmoji(targetTier)} ${target.name}</div>
        <div class="cabinet-banner-text">
          Ваш депозит вырос — открылся доступ к <b>${target.name}</b> с ${target.strategyIds.length} стратегиями.
          Ожидаемая прибыль <b>$${target.expectedMonthlyPnlRangeUsd.low}–$${target.expectedMonthlyPnlRangeUsd.high}/мес</b>
          (примерно +$${expectedDelta} к текущему уровню). Подписка <b>$${target.monthlyPriceUsd}/мес</b>.
        </div>
        <div class="cabinet-banner-actions">
          <form method="POST" action="/account/subscription/upgrade" style="display:inline">
            ${args.csrfToken ? csrfInput(args.csrfToken) : ''}
            <input type="hidden" name="targetTier" value="${targetTier}" />
            <button class="cabinet-banner-btn" type="submit">Перейти на ${target.name} →</button>
          </form>
          <form method="POST" action="/account/subscription/dismiss-upgrade" style="display:inline">
            ${args.csrfToken ? csrfInput(args.csrfToken) : ''}
            <button class="cabinet-banner-btn cabinet-banner-btn-secondary" type="submit">Пока остаться</button>
          </form>
        </div>
      </div>
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

/** Full-width banner about margin state. Two states (mutually exclusive):
 *
 *  1. RED — trading is currently blocked. The api-key row has
 *     insufficient_balance_at set, which only happens reactively:
 *       a) fan-out tried to open a trade and Bybit said insufficient
 *          (110007 / 110012 / 110045), OR
 *       b) pre-flight in executeUserEntry saw free < single-trade need.
 *     This is the "real" block: the next signal WILL fail unless they
 *     top up.
 *
 *  2. YELLOW — informational only. The worst-case sum across all
 *     enabled strategies (Σ notional/leverage) exceeds free margin.
 *     Trading still works for individual signals (it's rare for many
 *     strategies to fire concurrently across different symbols/TFs).
 *     We just warn that under a coordinated spike not every signal
 *     would fit. No action needed unless they want full coverage.
 *
 *  Returns '' if neither condition holds. */
function renderMarginBanner(args: {
  margin: MarginState;
  enabledStrategiesCount: number;
}): string {
  const m = args.margin;
  if (args.enabledStrategiesCount === 0) return '';

  const flagged = m.insufficientBalanceAt !== null;
  const balanceStr = m.balanceUsdt !== null ? `$${m.balanceUsdt.toFixed(2)}` : '—';
  const usedStr = `$${m.usedUsdt.toFixed(2)}`;
  const freeStr = m.freeUsdt !== null ? `$${m.freeUsdt.toFixed(2)}` : '—';

  if (flagged) {
    // Hard block. Bybit said "no" (or our per-trade pre-flight did).
    return `
      <div class="cabinet-banner-bad">
        <div class="cabinet-banner-icon">${ico('💸')}</div>
        <div class="cabinet-banner-body">
          <div class="cabinet-banner-title">Торговля приостановлена — недостаточно средств</div>
          <div class="cabinet-banner-text">
            Bybit отклонил последнюю попытку открыть сделку из-за нехватки обеспечения.
            Баланс: <b>${balanceStr}</b>${m.usedUsdt > 0 ? ` · В позициях: <b>${usedStr}</b>` : ''} · Свободно: <b>${freeStr}</b>.
            <br/>
            <b>Новые сделки система не открывает</b> пока баланс не вырастет. Уже открытые позиции продолжают работать.
            <br/>
            Пополните <b>Unified Trading Account (единый торговый аккаунт)</b> в Bybit (или переведите USDT из Funding-кошелька) —
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

  // Soft warning: worst-case (all strategies fire at once) doesn't
  // fit in free margin, but individual signals work fine. Don't show
  // unless balance is known.
  const worstCaseShort =
    m.balanceUsdt !== null && m.requiredUsdt > 0 && m.freeUsdt !== null && m.freeUsdt < m.requiredUsdt;
  if (!worstCaseShort) return '';
  const shortBy = `$${(m.requiredUsdt - (m.freeUsdt ?? 0)).toFixed(2)}`;
  return `
    <div class="cabinet-banner-amber">
      <div class="cabinet-banner-icon">${ico('💡')}</div>
      <div class="cabinet-banner-body">
        <div class="cabinet-banner-title-amber">Не хватит обеспечения при одновременном срабатывании всех стратегий</div>
        <div class="cabinet-banner-text">
          Сейчас свободно <b>${freeStr}</b>. Это покрывает любую <b>одну</b> сделку из ваших стратегий — торговля идёт нормально.
          Но если все ${args.enabledStrategiesCount} стратегий выстрелят в одну минуту (редкий случай), не хватит <b>${shortBy}</b> на полное покрытие — последние ордера будут пропущены.
          <br/>
          Чтобы такого не было — либо пополните счёт ещё на <b>${shortBy}</b>, либо уменьшите размер позиции / увеличьте плечо на 1-2 стратегиях.
        </div>
        <div class="cabinet-banner-actions">
          <a class="cabinet-banner-btn cabinet-banner-btn-secondary" href="/account/strategies">Настроить стратегии</a>
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

  // Phase G follow-up — single «Выберите тариф» banner. The tier-picker
  // page itself handles the balance check (with «Проверить баланс»
  // button + auto-activate when sufficient), so dashboard doesn't gate
  // on balance anymore — it just routes the user to the picker.
  if (args.enabledStrategiesCount === 0) {
    const balance = args.margin.balanceUsdt;
    const balanceLine = balance !== null
      ? `Сейчас на счёте <b>$${balance.toFixed(0)} USDT</b>. `
      : '';
    const selectedTier = sub.selected_tier_id
      ? TIER_CONFIGS[sub.selected_tier_id as TierId]
      : null;
    const title = selectedTier
      ? `Тариф ${selectedTier.name} выбран — ждём пополнение`
      : 'Выберите тариф автотрейдинга';
    const text = selectedTier
      ? `${balanceLine}Для активации тарифа <b>${selectedTier.name}</b> нужен баланс от <b>$${selectedTier.minBalanceUsdt}</b>. ` +
        `Пополните Unified Trading Account (единый торговый аккаунт) на Bybit и нажмите «Проверить баланс» — тариф активируется автоматически.`
      : `${balanceLine}Тариф определяет какие стратегии работают на вашем счёте и каким объёмом. ` +
        `Подбор стратегий внутри тарифа — наша задача, вы только выбираете план под размер депозита.`;
    return `
      <div class="cabinet-banner-amber">
        <div class="cabinet-banner-icon">${ico('💳')}</div>
        <div class="cabinet-banner-body">
          <div class="cabinet-banner-title-amber">${title}</div>
          <div class="cabinet-banner-text">${text}</div>
          <div class="cabinet-banner-actions">
            <a class="cabinet-banner-btn" href="/account/subscription/select-tier">${selectedTier ? 'Открыть выбор тарифа →' : 'Выбрать тариф →'}</a>
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

  // All-green path. The yellow worst-case banner already handles the
  // "хватит на одиночные но не на все" case; here we only land when
  // either margin is fully sufficient OR balance is unknown (no key
  // / not yet verified). Keep the banner crisp — just "all good".
  const m = args.margin;
  const worstCaseFits = m.balanceUsdt !== null && (m.freeUsdt ?? 0) >= m.requiredUsdt;
  const marginLine =
    m.balanceUsdt !== null && worstCaseFits
      ? `Свободно <b>$${(m.freeUsdt ?? 0).toFixed(2)}</b> — хватает на все стратегии при одновременном срабатывании.`
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
  // Three-tier status:
  //   - red:   currently flagged (Bybit said no / pre-flight blocked).
  //            That's an ACTIONABLE state: trading halted until top-up.
  //   - amber: worst-case sum doesn't fit. Trading WORKS, just may
  //            skip a few signals under simultaneous fire. Soft hint.
  //   - green: even worst-case sum fits.
  const worstCaseFits = free >= m.requiredUsdt;
  const cls = flagged
    ? 'cabinet-card-bad'
    : worstCaseFits
      ? 'cabinet-card-ok'
      : 'cabinet-card-warn';
  const statusEmoji = flagged ? '⚠️' : worstCaseFits ? '✅' : '💡';
  const statusText = flagged
    ? `Заблокировано Bybit'ом`
    : worstCaseFits
      ? `Хватает на все стратегии одновременно`
      : `Хватает на одиночные сделки`;
  return `
    <div class="stat-card cabinet-card ${cls}">
      <div class="stat-card-label">${ico('💵')}Обеспечение</div>
      <div class="stat-card-value">${statusEmoji} $${free.toFixed(2)}</div>
      <div class="stat-card-sub">
        ${statusText}
        <br/>
        <span style="opacity:0.7">баланс $${m.balanceUsdt.toFixed(2)} · нужно макс $${m.requiredUsdt.toFixed(2)}${m.usedUsdt > 0 ? ` · в позициях $${m.usedUsdt.toFixed(2)}` : ''}</span>
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
  /* TRACK E Phase C — onboarding checklist */
  .onboarding-checklist {
    background: linear-gradient(180deg, rgba(74, 217, 145, 0.06) 0%, rgba(74, 217, 145, 0.02) 100%);
    border: 1px solid rgba(74, 217, 145, 0.35);
    border-radius: 14px;
    padding: 20px 22px;
    margin: 0 0 24px;
  }
  .onboarding-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin-bottom: 16px;
  }
  .onboarding-h-title { font-size: 15px; font-weight: 600; color: #4ad991; margin-bottom: 2px; }
  .onboarding-h-sub { font-size: 12px; color: #8590a0; }
  .onboarding-progress {
    width: 180px; height: 6px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px; overflow: hidden;
  }
  .onboarding-progress-bar {
    height: 100%; background: #4ad991;
    transition: width 0.3s ease;
  }
  .onboarding-steps {
    display: flex; flex-direction: column; gap: 12px;
  }
  .onboarding-step {
    display: flex; align-items: center; gap: 14px;
    padding: 12px 14px; border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid transparent;
  }
  .onboarding-step.done {
    opacity: 0.6;
  }
  .onboarding-step.current {
    border-color: rgba(74, 217, 145, 0.35);
    background: rgba(74, 217, 145, 0.04);
  }
  .onboarding-marker {
    width: 28px; height: 28px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 13px;
    flex-shrink: 0;
  }
  .onboarding-step.done .onboarding-marker {
    background: #4ad991; color: #0b0e13;
  }
  .onboarding-step.current .onboarding-marker {
    background: rgba(74, 217, 145, 0.20); color: #4ad991;
    border: 2px solid #4ad991;
  }
  .onboarding-step.pending .onboarding-marker {
    background: rgba(255, 255, 255, 0.05); color: #6b7480;
  }
  .onboarding-body {
    flex: 1;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
  }
  .onboarding-title { font-size: 14px; color: #cfd6dd; }
  .onboarding-step.done .onboarding-title { color: #8590a0; text-decoration: line-through; }
  .onboarding-cta-row {
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;
  }
  .onboarding-cta {
    background: #4ad991; color: #0b0e13; padding: 6px 14px;
    border-radius: 7px; font-size: 13px; font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
    border: none; cursor: pointer; font-family: inherit;
  }
  .onboarding-cta:hover { background: #5ce0a0; text-decoration: none; }
  .onboarding-cta-ghost {
    background: transparent; color: #cfd6dd;
    border: 1px solid #2a323d;
  }
  .onboarding-cta-ghost:hover { background: rgba(74,217,145,0.08); border-color: #4ad991; color: #4ad991; }

  /* Upgrade promo banner — blue-ish accent, less alarming than red */
  .cabinet-banner-promo {
    display: flex; gap: 16px; padding: 18px 22px; margin: 0 0 24px;
    background: linear-gradient(180deg, rgba(74, 217, 145, 0.12) 0%, rgba(74, 217, 145, 0.04) 100%);
    border: 1px solid rgba(74, 217, 145, 0.50);
    border-radius: 14px; color: #cfd6dd; align-items: flex-start;
  }
  .cabinet-banner-title-promo {
    font-size: 15px; font-weight: 600; color: #4ad991; margin-bottom: 6px;
  }
  .cabinet-banner-promo .cabinet-banner-text b { color: #e8edf2; }

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
    text-align: center;
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
  @media (max-width: 380px) {
    .cabinet-main { padding: 20px 12px 60px; }
    .cabinet-stat-grid { grid-template-columns: 1fr; }
  }
</style>
`;
}

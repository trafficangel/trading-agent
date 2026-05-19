/**
 * Track D — `/account/subscription` page.
 *
 * Detailed view of the user's subscription state — bigger and more
 * explicit than the dashboard's single stat-card. Always reachable
 * from the «💳 Подписка» quick-action on /account.
 *
 * Each state has its own copy block:
 *   - Trial → countdown + "what happens after 14 days"
 *   - Active → countdown + renewal CTA
 *   - VIP → permanent badge + thank-you copy
 *   - Expired → red banner + how to renew
 *   - Cancelled → grey state + reactivation hint
 *
 * Renewal flow is manual via Telegram for now (no Stripe). The page
 * prominently surfaces the operator's TG handle for payment.
 */

import { pageShell } from '../strategies/landing.js';
import type { SubscriptionRow } from '../db/repos/user-subscriptions.js';

const SUPPORT_TG = 'https://t.me/dboykod';
const PRICE_USD = 50;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

function ico(emoji: string): string {
  return `<span class="cabinet-ico" aria-hidden="true">${emoji}</span>`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function daysBetween(a: number, b: number): number {
  return Math.ceil((b - a) / 86_400_000);
}

function pluralDay(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

export function renderSubscriptionPage(args: {
  displayName: string | null;
  subscription: SubscriptionRow | null;
}): string {
  const sub = args.subscription;

  const main = sub ? renderSubBlock(sub) : renderMissingBlock();

  const body = `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label">Личный кабинет · Подписка</div>
        <h1 class="cabinet-title">Моя подписка</h1>
      </div>
      ${main}
      <div class="sub-back">
        <a href="/account">← Назад в кабинет</a>
      </div>
    </main>
  `;

  return pageShell('Подписка · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
  });
}

function renderMissingBlock(): string {
  return `
    <div class="sub-card sub-card-warn">
      <div class="sub-card-title">${ico('⚠️')}Подписка не активирована</div>
      <div class="sub-card-body">
        Похоже что подписка не была создана автоматически — это редкая
        ошибка. Напишите оператору, чтобы он восстановил доступ.
      </div>
      <a class="sub-btn-primary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
        Написать в Telegram → @dboykod
      </a>
    </div>
  `;
}

function renderSubBlock(sub: SubscriptionRow): string {
  // VIP — perpetual, status doesn't matter (unless cancelled).
  if (sub.plan === 'vip' && sub.status !== 'cancelled') {
    return renderVipBlock(sub);
  }
  if (sub.status === 'cancelled') return renderCancelledBlock(sub);
  if (sub.status === 'expired' || sub.access_until <= Date.now()) {
    return renderExpiredBlock(sub);
  }
  if (sub.status === 'trial') return renderTrialBlock(sub);
  return renderActiveBlock(sub);
}

function renderVipBlock(sub: SubscriptionRow): string {
  return `
    <div class="sub-card sub-card-vip">
      <div class="sub-badge sub-badge-vip">${ico('👑')}VIP</div>
      <div class="sub-card-title">Постоянный доступ</div>
      <div class="sub-meta-grid">
        <div>
          <div class="sub-meta-label">План</div>
          <div class="sub-meta-value">VIP</div>
        </div>
        <div>
          <div class="sub-meta-label">Срок действия</div>
          <div class="sub-meta-value">Бессрочно</div>
        </div>
        <div>
          <div class="sub-meta-label">Подписка с</div>
          <div class="sub-meta-value">${fmtDate(sub.created_at)}</div>
        </div>
      </div>
      <div class="sub-card-body">
        Вы пользуетесь автотрейдингом на правах VIP — без оплаты и без
        ограничений по сроку. Спасибо за участие в бета-тестировании
        и обратную связь.
      </div>
    </div>
  `;
}

function renderTrialBlock(sub: SubscriptionRow): string {
  const daysLeft = Math.max(0, daysBetween(Date.now(), sub.access_until));
  const isUrgent = daysLeft <= 3;
  const totalTrial = daysBetween(sub.trial_started_at, sub.access_until);
  const pct = totalTrial > 0 ? Math.min(100, ((totalTrial - daysLeft) / totalTrial) * 100) : 0;

  return `
    <div class="sub-card ${isUrgent ? 'sub-card-warn' : 'sub-card-ok'}">
      <div class="sub-badge ${isUrgent ? 'sub-badge-warn' : 'sub-badge-trial'}">
        ${ico('🎁')}Демо доступ
      </div>
      <div class="sub-card-title">
        Осталось <span class="sub-days-big">${daysLeft}</span> ${pluralDay(daysLeft)}
      </div>
      <div class="sub-progress">
        <div class="sub-progress-bar" style="width: ${pct.toFixed(1)}%"></div>
      </div>
      <div class="sub-progress-labels">
        <span>Начало: ${fmtDate(sub.trial_started_at)}</span>
        <span>Конец: ${fmtDate(sub.access_until)}</span>
      </div>

      <div class="sub-meta-grid">
        <div>
          <div class="sub-meta-label">План</div>
          <div class="sub-meta-value">Бесплатный триал</div>
        </div>
        <div>
          <div class="sub-meta-label">Истекает</div>
          <div class="sub-meta-value">${fmtDateTime(sub.access_until)}</div>
        </div>
        <div>
          <div class="sub-meta-label">После триала</div>
          <div class="sub-meta-value">$${PRICE_USD} / мес</div>
        </div>
      </div>

      <div class="sub-card-body">
        ${isUrgent
          ? `<b class="sub-warn-text">⚠️ Триал почти закончился.</b> Чтобы продолжить
             пользоваться автотрейдингом после ${fmtDate(sub.access_until)}, напишите
             оператору для оплаты и продления.`
          : `После ${fmtDate(sub.access_until)} торговля автоматически приостановится.
             Чтобы продолжить — напишите оператору в Telegram, мы продлим подписку
             вручную после оплаты ($${PRICE_USD}/мес).`}
      </div>

      <a class="sub-btn-primary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
        ${ico('💳')}Оплатить $${PRICE_USD} / мес — @dboykod
      </a>
    </div>
  `;
}

function renderActiveBlock(sub: SubscriptionRow): string {
  const daysLeft = Math.max(0, daysBetween(Date.now(), sub.access_until));
  const isUrgent = daysLeft <= 7;
  return `
    <div class="sub-card ${isUrgent ? 'sub-card-warn' : 'sub-card-ok'}">
      <div class="sub-badge sub-badge-active">${ico('✅')}Активна</div>
      <div class="sub-card-title">
        Осталось <span class="sub-days-big">${daysLeft}</span> ${pluralDay(daysLeft)}
      </div>

      <div class="sub-meta-grid">
        <div>
          <div class="sub-meta-label">План</div>
          <div class="sub-meta-value">Стандарт · $${PRICE_USD}/мес</div>
        </div>
        <div>
          <div class="sub-meta-label">Срок действия до</div>
          <div class="sub-meta-value">${fmtDateTime(sub.access_until)}</div>
        </div>
        ${sub.manually_extended_by
          ? `<div>
              <div class="sub-meta-label">Последнее продление</div>
              <div class="sub-meta-value sub-meta-mono">${escapeHtml(sub.manually_extended_by)}</div>
            </div>`
          : ''}
      </div>

      <div class="sub-card-body">
        ${isUrgent
          ? `<b class="sub-warn-text">Подписка истекает через ${daysLeft} ${pluralDay(daysLeft)}.</b>
             Чтобы продлить — напишите оператору, пришлёт реквизиты для оплаты.`
          : `Доступ активен до ${fmtDate(sub.access_until)}. Можете торговать без ограничений.
             Для продления свяжитесь с оператором ближе к концу периода.`}
      </div>

      ${isUrgent
        ? `<a class="sub-btn-primary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
            ${ico('💳')}Продлить — @dboykod
          </a>`
        : ''}
    </div>
  `;
}

function renderExpiredBlock(sub: SubscriptionRow): string {
  const daysExpired = daysBetween(sub.access_until, Date.now());
  return `
    <div class="sub-card sub-card-bad">
      <div class="sub-badge sub-badge-bad">${ico('⛔')}Истекла</div>
      <div class="sub-card-title">Доступ к автотрейдингу приостановлен</div>

      <div class="sub-meta-grid">
        <div>
          <div class="sub-meta-label">Истекла</div>
          <div class="sub-meta-value">${fmtDateTime(sub.access_until)} (${daysExpired} ${pluralDay(daysExpired)} назад)</div>
        </div>
        <div>
          <div class="sub-meta-label">Был план</div>
          <div class="sub-meta-value">${sub.plan === 'vip' ? 'VIP' : 'Стандарт'}</div>
        </div>
      </div>

      <div class="sub-card-body">
        Новые сделки на ваш счёт <b>не открываются</b>. Уже открытые позиции
        продолжают жить до своего естественного выхода — стратегия их закроет.
        Кабинет, история и настройки доступны как обычно.
        <br/><br/>
        Чтобы возобновить торговлю — напишите оператору в Telegram, мы продлим
        подписку вручную после оплаты ($${PRICE_USD}/мес).
      </div>

      <a class="sub-btn-primary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
        ${ico('💳')}Продлить — @dboykod
      </a>
    </div>
  `;
}

function renderCancelledBlock(sub: SubscriptionRow): string {
  return `
    <div class="sub-card sub-card-bad">
      <div class="sub-badge sub-badge-bad">${ico('⏸')}Отменена</div>
      <div class="sub-card-title">Подписка отменена</div>

      <div class="sub-meta-grid">
        <div>
          <div class="sub-meta-label">Дата отмены</div>
          <div class="sub-meta-value">${fmtDateTime(sub.updated_at)}</div>
        </div>
      </div>

      <div class="sub-card-body">
        Подписка отменена, новые сделки не открываются. Если хотите
        возобновить доступ — напишите оператору, восстановим подписку.
      </div>

      <a class="sub-btn-primary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
        ${ico('🔄')}Восстановить — @dboykod
      </a>
    </div>
  `;
}

function styles(): string {
  return `
<style>
  .cabinet-main { max-width: 720px; margin: 0 auto; padding: 28px 20px 80px; }
  .cabinet-greeting { margin-bottom: 20px; }
  .cabinet-greeting-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: #6b7480; margin-bottom: 6px;
  }
  .cabinet-title {
    font-size: 26px; font-weight: 600; margin: 0; color: #e8edf2;
  }
  .cabinet-ico {
    display: inline-block; margin-right: 8px; vertical-align: -1px; line-height: 1;
  }

  .sub-card {
    background: #11161d; border: 1px solid #1f2630; border-radius: 16px;
    padding: 28px 30px; margin: 20px 0;
  }
  .sub-card-ok { border-color: rgba(74, 217, 145, 0.45); }
  .sub-card-warn { border-color: rgba(255, 188, 70, 0.45); }
  .sub-card-bad { border-color: rgba(255, 99, 99, 0.45); }
  .sub-card-vip {
    border-color: rgba(212, 175, 55, 0.55);
    background: linear-gradient(180deg, #1a1611 0%, #11161d 70%);
  }

  .sub-badge {
    display: inline-block; padding: 5px 12px; border-radius: 999px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
    margin-bottom: 14px;
  }
  .sub-badge-vip {
    background: rgba(212, 175, 55, 0.12); color: #f3d266;
    border: 1px solid rgba(212, 175, 55, 0.55);
  }
  .sub-badge-trial, .sub-badge-active {
    background: rgba(74, 217, 145, 0.10); color: #4ad991;
    border: 1px solid rgba(74, 217, 145, 0.45);
  }
  .sub-badge-warn {
    background: rgba(255, 188, 70, 0.10); color: #ffbc46;
    border: 1px solid rgba(255, 188, 70, 0.45);
  }
  .sub-badge-bad {
    background: rgba(255, 99, 99, 0.10); color: #ff8b8b;
    border: 1px solid rgba(255, 99, 99, 0.45);
  }

  .sub-card-title {
    font-size: 22px; font-weight: 600; color: #e8edf2;
    margin: 0 0 18px 0; line-height: 1.25;
  }
  .sub-days-big {
    color: #4ad991; font-size: 26px; font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .sub-card-warn .sub-days-big { color: #ffbc46; }
  .sub-card-bad .sub-days-big { color: #ff8b8b; }

  .sub-progress {
    height: 8px; background: #0e131a; border-radius: 999px;
    overflow: hidden; margin-bottom: 6px;
  }
  .sub-progress-bar {
    height: 100%; background: #4ad991;
    border-radius: 999px; transition: width 0.3s;
  }
  .sub-card-warn .sub-progress-bar { background: #ffbc46; }
  .sub-progress-labels {
    display: flex; justify-content: space-between;
    font-size: 11.5px; color: #6b7480; margin-bottom: 22px;
  }

  .sub-meta-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px 24px; margin: 18px 0;
    padding: 16px 18px; background: rgba(255,255,255,0.02);
    border-radius: 10px; border: 1px solid #1a1f27;
  }
  .sub-meta-label {
    font-size: 11px; color: #6b7480; letter-spacing: 0.06em;
    text-transform: uppercase; margin-bottom: 4px;
  }
  .sub-meta-value { font-size: 14px; color: #e8edf2; }
  .sub-meta-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }

  .sub-card-body {
    font-size: 13.5px; line-height: 1.6; color: #9aa5b1;
    margin: 16px 0;
  }
  .sub-warn-text { color: #ffbc46; }

  .sub-btn-primary {
    display: inline-flex; align-items: center;
    padding: 12px 22px; background: #4ad991; color: #0b0e13;
    border-radius: 9px; font-weight: 600; font-size: 14.5px;
    text-decoration: none; margin-top: 8px;
    transition: background 0.15s;
  }
  .sub-btn-primary:hover { background: #5ce0a0; }

  .sub-back { text-align: center; margin-top: 26px; }
  .sub-back a { color: #8590a0; font-size: 13px; text-decoration: none; }
  .sub-back a:hover { color: #4ad991; }

  @media (max-width: 540px) {
    .sub-card { padding: 20px; }
    .sub-card-title { font-size: 18px; }
    .sub-days-big { font-size: 22px; }
  }
</style>
`;
}

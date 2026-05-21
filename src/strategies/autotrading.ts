/**
 * Public landing — `/autotrading` (Track D pitch).
 *
 * Explains the SaaS copytrading product to potential subscribers:
 *   - Hero with pricing
 *   - 3-step "how it works" funnel
 *   - Safety section (trade-only key, IP whitelist, no withdraw)
 *   - Strategies preview
 *   - FAQ
 *
 * CTA leads to /strategies (existing OTP-gated registration form).
 * Once registered, users land in /account and see the trial-day
 * countdown — they connect their API key + pick strategies inside
 * the cabinet, not on this page.
 *
 * Visual identity matches the public home page (same hero spacing,
 * same stat cards, same CSS variables).
 */

import type { FastifyInstance } from 'fastify';
import { pageShell } from './landing.js';
import { STRATEGY_CONFIGS, BYBIT_REF_URL, BYBIT_REF_BONUS_DAYS } from './track-c-config.js';
import { listTiers } from './tier-config.js';

const PRICE_USD = 50;
const TRIAL_DAYS = 14;
const SUPPORT_TG = 'https://t.me/dboykod';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

function ico(emoji: string): string {
  return `<span class="at-ico" aria-hidden="true">${emoji}</span>`;
}

function renderPage(): string {
  const strategies = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
  const stratList = strategies
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(
      (s) => `
        <a href="/strategies/${s.code}" class="at-strat-card">
          <div class="at-strat-code">STRAT-${escapeHtml(s.code)}</div>
          <div class="at-strat-name">${escapeHtml(s.name ?? s.id)}</div>
          <div class="at-strat-meta">${escapeHtml(s.symbol ?? 'ANY')} · ${escapeHtml(s.timeframe)}m · SL ${(s.slPct * 100).toFixed(1)}%</div>
        </a>
      `,
    )
    .join('');

  const body = `
    ${styles()}
    <main class="at-main">
      ${renderHero()}
      ${renderBybitBonus()}
      ${renderHowItWorks()}
      ${renderSafety()}

      <section class="at-section">
        <h2 class="at-section-title">${ico('🤖')}${strategies.length} стратегий в портфеле</h2>
        <p class="at-section-sub">
          Выберите любые из ${strategies.length} активных стратегий — система будет торговать
          по ним на вашем счёте автоматически. Полная статистика и история сделок
          по каждой — на странице стратегии.
        </p>
        <div class="at-strat-grid">${stratList}</div>
        <div style="text-align:center; margin-top:18px">
          <a href="/strategies" class="at-btn-secondary">Подробнее обо всех стратегиях →</a>
        </div>
      </section>

      ${renderPricing()}
      ${renderFaq()}
      ${renderFinalCta()}
    </main>
  `;

  return pageShell('Автотрейдинг · Robot Claude', body, {
    lang: 'ru',
    robots: 'index, follow',
  });
}

function renderHero(): string {
  return `
    <section class="at-hero">
      <div class="at-hero-eyebrow">Автоматическая торговля · SaaS</div>
      <h1 class="at-hero-title">
        Наши стратегии. <span class="at-accent">Ваш счёт Bybit.</span>
      </h1>
      <p class="at-hero-sub">
        Подключите свой Bybit-аккаунт — система открывает и закрывает позиции
        по нашим стратегиям автоматически. Деньги остаются у вас, мы не имеем
        права на вывод.
      </p>
      <div class="at-hero-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary">${ico('🚀')}Попробовать бесплатно</a>
        <div class="at-hero-pricing">
          <b>${TRIAL_DAYS} дней бесплатно</b>, потом <b>$${PRICE_USD}/мес</b>
        </div>
        <div class="at-hero-login">
          Уже регистрировались? <a href="/strategies?login=1">Войти →</a>
        </div>
      </div>
      <div class="at-hero-pills">
        <span class="at-pill">${ico('🛡')}Ключ без права на вывод</span>
        <span class="at-pill">${ico('🔒')}AES-256-GCM шифрование</span>
        <span class="at-pill">${ico('📈')}${Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled).length} активных стратегий</span>
      </div>
    </section>
  `;
}

function renderBybitBonus(): string {
  return `
    <section class="at-section at-bonus">
      <div class="at-bonus-card">
        <div class="at-bonus-icon">${ico('🎁')}</div>
        <div class="at-bonus-body">
          <div class="at-bonus-title">Нет аккаунта на Bybit? Получите +${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно</div>
          <div class="at-bonus-sub">
            Зарегистрируйтесь на Bybit по нашей ссылке — и мы добавим вам
            <b>${BYBIT_REF_BONUS_DAYS} дней автотрейдинга</b> сверх 14-дневного триала.
            После регистрации пришлите ваш Bybit UID оператору в Telegram —
            продлим подписку вручную.
          </div>
        </div>
        <div class="at-bonus-actions">
          <a class="at-btn-primary" href="${BYBIT_REF_URL}" target="_blank" rel="noopener">
            ${ico('🚀')}Открыть Bybit
          </a>
          <a class="at-btn-secondary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
            Написать оператору
          </a>
        </div>
      </div>
    </section>
  `;
}

function renderHowItWorks(): string {
  return `
    <section class="at-section at-how">
      <h2 class="at-section-title">${ico('🛠')}Как это работает</h2>
      <div class="at-how-grid">
        <div class="at-how-step">
          <div class="at-how-num">1</div>
          <div class="at-how-title">Регистрация</div>
          <div class="at-how-body">
            Telegram-OTP на ваш номер. Без паролей, без email.
            Доступ к кабинету сразу после ввода кода.
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">2</div>
          <div class="at-how-title">Bybit API-ключ</div>
          <div class="at-how-body">
            <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">Зарегистрируйтесь на Bybit</a>
            (+${BYBIT_REF_BONUS_DAYS} дней бесплатно за нашу реф-ссылку) и создайте API-ключ
            с правом <b>только на торговлю</b> (без вывода средств). Подробная пошаговая
            инструкция со скриншотами появится в кабинете после регистрации.
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">3</div>
          <div class="at-how-title">Выбор стратегий</div>
          <div class="at-how-body">
            Включите нужные стратегии, задайте размер позиции (USDT)
            и плечо. Система начинает торговать сразу.
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderSafety(): string {
  return `
    <section class="at-section at-safety">
      <h2 class="at-section-title">${ico('🛡')}Безопасность ваших средств</h2>
      <div class="at-safety-grid">
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🚫')}</div>
          <div class="at-safety-title">Не можем выводить деньги</div>
          <div class="at-safety-body">
            API-ключ создаётся <b>без права на withdraw и transfer</b>.
            Это физически невозможно технически — Bybit отклонит любую
            попытку вывести с нашей стороны.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🔒')}</div>
          <div class="at-safety-title">Ключи зашифрованы</div>
          <div class="at-safety-body">
            При сохранении ключ шифруется <b>AES-256-GCM</b>. Никто, включая
            нас, не может прочитать ваш secret после ввода — только использовать
            для выставления ордеров.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🤖')}</div>
          <div class="at-safety-title">Только маркет-ордера и SL</div>
          <div class="at-safety-body">
            С вашим ключом мы можем только три действия: открыть позицию,
            закрыть позицию, поставить защитный стоп. Никакой доступ к споту,
            переводам и профилю невозможен — Bybit отклонит любую попытку.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('⏹')}</div>
          <div class="at-safety-title">Отзыв в один клик</div>
          <div class="at-safety-body">
            Если что-то не нравится — отключите ключ в кабинете
            или на Bybit. Новые сделки прекратятся, открытые позиции
            продолжат жить до своего естественного выхода.
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderPricing(): string {
  const tiers = listTiers();
  const cards = tiers
    .map((t) => {
      const maxStr = t.maxBalanceUsdt === Number.POSITIVE_INFINITY ? '∞' : `$${t.maxBalanceUsdt.toLocaleString()}`;
      const sub = t.expectedMonthlyPnlRangeUsd;
      return `
        <div class="at-tier-card">
          <div class="at-tier-name">${tierEmoji(t.id)} ${escapeHtml(t.name)}</div>
          <div class="at-tier-depo">Депозит $${t.minBalanceUsdt.toLocaleString()}–${maxStr}</div>
          <div class="at-tier-price"><span class="at-tier-price-num">$${t.monthlyPriceUsd}</span><span class="at-tier-price-period">/мес</span></div>
          <ul class="at-tier-features">
            <li>${t.strategyIds.length} стратегий в портфеле</li>
            <li>~$${sub.low}–$${sub.high}/мес ожидаемая прибыль</li>
            <li>Max просадка ≤${t.expectedMaxDdPct}%</li>
            <li>До ${t.maxConcurrentPositions} одновременных позиций</li>
          </ul>
          <div class="at-tier-pitch">${escapeHtml(t.pitch)}</div>
        </div>
      `;
    })
    .join('');
  return `
    <section class="at-section at-pricing">
      <h2 class="at-section-title">${ico('💳')}Тарифы</h2>
      <p class="at-pricing-intro">
        Тариф назначается автоматически по балансу вашего Bybit-счёта.
        Чем больше депозит — тем больше доступных стратегий и тем выше ожидаемая прибыль.
        Подписка покрывает не больше 18-20% потенциального месячного дохода.
      </p>
      <div class="at-tier-grid">
        ${cards}
      </div>
      <div class="at-pricing-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary">${ico('🎁')}Начать ${TRIAL_DAYS} дней бесплатно</a>
      </div>
      <div class="at-price-disclaimer">
        ⚠ Цифры доходности рассчитаны по историческим данным бэктестов. <b>Прошлые результаты не гарантируют будущих</b>.
        Криптотрейдинг сопряжён с риском полной потери капитала. Robot Claude — сервис автоматизации сделок,
        не финансовый консультант. Все решения о размере депозита и риске вы принимаете самостоятельно.
      </div>
    </section>
  `;
}

function tierEmoji(id: 'starter' | 'standard' | 'plus' | 'pro' | 'vip'): string {
  switch (id) {
    case 'starter': return '🥉';
    case 'standard': return '🥈';
    case 'plus': return '🥇';
    case 'pro': return '🏆';
    case 'vip': return '👑';
  }
}

function renderFaq(): string {
  const items = [
    {
      q: `Как получить +${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно?`,
      a: `Зарегистрируйтесь на Bybit по нашей реферальной ссылке — кнопка «Открыть Bybit» в жёлтой плашке наверху этой страницы. После создания аккаунта откройте свой профиль на Bybit, скопируйте Bybit UID (8-значное число вашего аккаунта) и пришлите его оператору @dboykod в Telegram вместе со скриншотом подтверждающим, что вы зарегистрированы по нашей ссылке. Мы вручную продлим вашу подписку на ${BYBIT_REF_BONUS_DAYS} дней сверх стандартного 14-дневного триала — итого ${14 + BYBIT_REF_BONUS_DAYS} дней бесплатно.`,
    },
    {
      q: 'Где хранятся мои деньги?',
      a: 'На вашем счёте Bybit. Мы только отправляем ордера через API. Депозит, баланс, прибыль — всё на вашей бирже, мы доступа к выводу не имеем.',
    },
    {
      q: 'Что если стратегия в минусе?',
      a: 'Просадка — это нормально для любой торговой системы. У каждой стратегии есть Safety SL (защитный стоп выше исторических убытков), который ограничивает потери. На странице каждой стратегии видна вся история сделок включая убыточные.',
    },
    {
      q: 'Сколько денег нужно для начала?',
      a: 'Минимальный депозит на Bybit USDT-perp — около $10 на сделку. Мы рекомендуем начать с $200-500 чтобы попробовать 2-3 стратегии одновременно. Размер позиции задаёте вы для каждой стратегии отдельно.',
    },
    {
      q: 'Можно ли вручную закрыть позицию?',
      a: 'Да, в любой момент через интерфейс Bybit. Наша система не противодействует — увидит закрытие при следующей сверке и пометит сделку завершённой в вашей истории.',
    },
    {
      q: 'Что с плечом и ликвидацией?',
      a: 'Плечо вы выбираете сами для каждой стратегии. Мы показываем рекомендуемый максимум, рассчитанный так, чтобы Safety SL срабатывал раньше, чем биржа ликвидирует позицию. Использовать большее плечо — на ваш риск.',
    },
    {
      q: 'Прошлая доходность гарантирует будущую?',
      a: 'Нет. Все цифры на сайте — это исторический бэктест и реальная статистика. Рынок меняется, любая стратегия может перестать работать. Не торгуйте больше, чем готовы потерять.',
    },
  ];
  const html = items
    .map(
      (it) => `
        <details class="at-faq-item">
          <summary>${escapeHtml(it.q)}</summary>
          <div class="at-faq-answer">${escapeHtml(it.a)}</div>
        </details>
      `,
    )
    .join('');
  return `
    <section class="at-section at-faq">
      <h2 class="at-section-title">${ico('❓')}Частые вопросы</h2>
      <div class="at-faq-list">${html}</div>
    </section>
  `;
}

function renderFinalCta(): string {
  return `
    <section class="at-section at-cta-final">
      <h2 class="at-cta-title">Готовы начать?</h2>
      <p class="at-cta-sub">
        ${TRIAL_DAYS} дней бесплатного доступа. Без привязки карты. Отмена в один клик.
      </p>
      <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">Зарегистрироваться</a>
      <p class="at-cta-login">
        Уже регистрировались? <a href="/strategies?login=1">Войти →</a>
      </p>
      <p class="at-cta-help">
        Вопросы? Напишите оператору: <a href="${SUPPORT_TG}" target="_blank" rel="noopener">@dboykod</a>
      </p>
    </section>
  `;
}

function styles(): string {
  return `
<style>
  .at-main { max-width: 1100px; margin: 0 auto; padding: 30px 20px 80px; }
  .at-ico { display: inline-block; margin-right: 8px; vertical-align: -1px; line-height: 1; }

  /* ----- Hero ----- */
  .at-hero { text-align: center; padding: 40px 0 50px; }
  .at-hero-eyebrow {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em;
    color: #6b7480; margin-bottom: 16px;
  }
  .at-hero-title {
    font-size: 44px; font-weight: 700; line-height: 1.1; margin: 0 0 18px 0;
    color: #e8edf2; letter-spacing: -0.02em;
  }
  .at-hero-title .at-accent { color: #4ad991; }
  .at-hero-sub {
    font-size: 17px; line-height: 1.55; color: #9aa5b1; max-width: 680px;
    margin: 0 auto 28px; padding: 0 12px;
  }
  .at-hero-cta { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .at-hero-pricing { font-size: 13.5px; color: #8590a0; }
  .at-hero-pricing b { color: #cfd6dd; }
  .at-hero-login {
    font-size: 13px; color: #6b7480; margin-top: 4px;
  }
  .at-hero-login a {
    color: #4ad991; text-decoration: none; font-weight: 500;
  }
  .at-hero-login a:hover { text-decoration: underline; }
  .at-hero-pills {
    display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
    margin-top: 28px;
  }
  .at-pill {
    padding: 6px 14px; border: 1px solid #1f2630; border-radius: 999px;
    font-size: 12.5px; color: #8590a0; background: #11161d;
  }

  /* ----- Buttons ----- */
  .at-btn-primary {
    display: inline-flex; align-items: center;
    padding: 13px 24px; background: #4ad991; color: #0b0e13;
    border-radius: 9px; font-weight: 600; font-size: 15px;
    text-decoration: none; transition: background 0.15s;
  }
  .at-btn-primary:hover { background: #5ce0a0; }
  .at-btn-secondary {
    display: inline-block; padding: 9px 18px;
    border: 1px solid #2a323d; background: transparent;
    color: #cfd6dd; border-radius: 8px; font-size: 14px;
    text-decoration: none; transition: border-color 0.15s;
  }
  .at-btn-secondary:hover { border-color: #4ad991; }
  .at-btn-full { display: block; text-align: center; width: 100%; box-sizing: border-box; }
  .at-btn-large { padding: 16px 32px; font-size: 16px; }

  /* ----- Sections ----- */
  .at-section { margin: 60px 0; }
  .at-section-title {
    font-size: 22px; font-weight: 600; color: #e8edf2;
    margin: 0 0 12px 0; text-align: center;
  }
  .at-section-sub {
    color: #9aa5b1; font-size: 14px; line-height: 1.55;
    text-align: center; max-width: 640px; margin: 0 auto 26px;
  }

  /* ----- Bybit referral bonus ----- */
  .at-bonus { margin: 36px 0; }
  .at-bonus-card {
    display: grid; grid-template-columns: auto 1fr auto;
    gap: 22px; align-items: center;
    padding: 22px 26px;
    background: linear-gradient(135deg, rgba(212,175,55,0.10) 0%, rgba(74,217,145,0.08) 100%);
    border: 1px solid rgba(212, 175, 55, 0.45);
    border-radius: 16px;
  }
  .at-bonus-icon { font-size: 36px; line-height: 1; }
  .at-bonus-title {
    font-size: 17px; font-weight: 600; color: #f3d266;
    margin-bottom: 6px; line-height: 1.3;
  }
  .at-bonus-sub {
    font-size: 13.5px; color: #cfd6dd; line-height: 1.55;
  }
  .at-bonus-sub b { color: #f3d266; }
  .at-bonus-actions {
    display: flex; flex-direction: column; gap: 8px;
    flex-shrink: 0;
  }
  .at-bonus-actions .at-btn-primary {
    padding: 11px 18px; font-size: 13.5px; white-space: nowrap;
  }
  .at-bonus-actions .at-btn-secondary {
    padding: 9px 14px; font-size: 12.5px; text-align: center; white-space: nowrap;
  }
  @media (max-width: 720px) {
    .at-bonus-card { grid-template-columns: 1fr; text-align: left; }
    .at-bonus-icon { font-size: 28px; }
    .at-bonus-actions { flex-direction: row; flex-wrap: wrap; }
  }

  /* ----- How it works ----- */
  .at-how-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 18px;
  }
  .at-how-step {
    background: #11161d; border: 1px solid #1f2630; border-radius: 14px;
    padding: 22px 22px 24px; text-align: left;
  }
  .at-how-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 50%;
    background: #4ad991; color: #0b0e13; font-weight: 700;
    margin-bottom: 12px;
  }
  .at-how-title {
    font-size: 16px; font-weight: 600; color: #e8edf2; margin-bottom: 8px;
  }
  .at-how-body { font-size: 13.5px; color: #9aa5b1; line-height: 1.55; }

  /* ----- Safety ----- */
  .at-safety-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
  }
  .at-safety-card {
    background: #0e131a; border: 1px solid #1a1f27; border-radius: 12px;
    padding: 18px 20px;
  }
  .at-safety-icon { font-size: 24px; margin-bottom: 8px; }
  .at-safety-title {
    font-size: 14.5px; font-weight: 600; color: #e8edf2; margin-bottom: 6px;
  }
  .at-safety-body { font-size: 13px; color: #8590a0; line-height: 1.55; }

  /* ----- Strategies preview ----- */
  .at-strat-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }
  .at-strat-card {
    background: #11161d; border: 1px solid #1f2630; border-radius: 10px;
    padding: 14px 16px; text-decoration: none; color: inherit;
    transition: border-color 0.15s, transform 0.15s;
  }
  .at-strat-card:hover { border-color: #4ad991; transform: translateY(-1px); }
  .at-strat-code {
    font-size: 10.5px; color: #6b7480; letter-spacing: 0.06em;
    text-transform: uppercase; margin-bottom: 4px;
  }
  .at-strat-name {
    font-size: 14px; font-weight: 600; color: #e8edf2; margin-bottom: 4px;
  }
  .at-strat-meta { font-size: 11.5px; color: #8590a0; }

  /* ----- Pricing (TRACK E tier table) ----- */
  .at-pricing-intro {
    text-align: center; color: #cfd6dd; font-size: 14px; line-height: 1.6;
    max-width: 720px; margin: 0 auto 24px;
  }
  .at-tier-grid {
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    margin-bottom: 28px;
  }
  .at-tier-card {
    background: linear-gradient(180deg, #161c25 0%, #11161d 70%);
    border: 1px solid #1f2630; border-radius: 14px;
    padding: 20px 18px;
    display: flex; flex-direction: column;
  }
  .at-tier-card:nth-child(3) { border-color: rgba(74, 217, 145, 0.45); }
  .at-tier-name {
    font-size: 16px; font-weight: 600; color: #e8edf2; margin-bottom: 4px;
  }
  .at-tier-depo { font-size: 11.5px; color: #8590a0; margin-bottom: 12px; }
  .at-tier-price { display: flex; align-items: baseline; gap: 4px; margin-bottom: 14px; }
  .at-tier-price-num { font-size: 28px; font-weight: 700; color: #4ad991; }
  .at-tier-price-period { font-size: 12px; color: #8590a0; }
  .at-tier-features {
    list-style: none; padding: 0; margin: 0 0 12px 0;
    font-size: 12.5px; color: #cfd6dd; line-height: 1.55;
    flex: 1;
  }
  .at-tier-features li {
    padding: 4px 0;
    padding-left: 14px;
    position: relative;
  }
  .at-tier-features li::before {
    content: '✓'; color: #4ad991;
    position: absolute; left: 0;
  }
  .at-tier-pitch { font-size: 11.5px; color: #8590a0; line-height: 1.5; margin-top: auto; padding-top: 10px; border-top: 1px solid #1a1f27; }
  .at-pricing-cta { text-align: center; margin-bottom: 18px; }
  .at-price-disclaimer {
    background: rgba(255, 188, 70, 0.06); border: 1px solid rgba(255, 188, 70, 0.30);
    border-radius: 8px; padding: 12px 16px;
    font-size: 12px; color: #cfd6dd; line-height: 1.55;
    max-width: 760px; margin: 0 auto;
  }
  .at-price-disclaimer b { color: #ffbc46; }

  /* Legacy single-price card kept for back-compat in other landing layouts */
  .at-price-card {
    max-width: 480px; margin: 0 auto;
    background: linear-gradient(180deg, #161c25 0%, #11161d 70%);
    border: 1px solid rgba(74, 217, 145, 0.45); border-radius: 16px;
    padding: 32px 30px; text-align: center;
  }
  .at-price-amount {
    display: flex; align-items: baseline; justify-content: center;
    gap: 6px; margin-bottom: 22px;
  }
  .at-price-num { font-size: 52px; font-weight: 700; color: #e8edf2; }
  .at-price-period { font-size: 16px; color: #8590a0; }
  .at-price-features {
    list-style: none; padding: 0; margin: 0 0 22px 0; text-align: left;
  }
  .at-price-features li {
    padding: 8px 0; color: #cfd6dd; font-size: 14px;
    border-bottom: 1px solid #1a1f27;
  }
  .at-price-features li:last-child { border-bottom: none; }
  .at-price-features b { color: #4ad991; }
  .at-price-note {
    font-size: 12px; color: #6b7480; margin-top: 12px; line-height: 1.5;
  }

  /* ----- FAQ ----- */
  .at-faq-list { max-width: 720px; margin: 0 auto; }
  .at-faq-item {
    background: #11161d; border: 1px solid #1f2630; border-radius: 10px;
    padding: 14px 18px; margin-bottom: 8px;
  }
  .at-faq-item summary {
    cursor: pointer; font-size: 14.5px; font-weight: 500; color: #e8edf2;
    list-style: none; padding: 4px 0;
  }
  .at-faq-item summary::-webkit-details-marker { display: none; }
  .at-faq-item summary::before {
    content: '+ '; color: #4ad991; font-weight: 700; margin-right: 4px;
  }
  .at-faq-item[open] summary::before { content: '− '; }
  .at-faq-answer {
    padding-top: 10px; margin-top: 10px; border-top: 1px solid #1a1f27;
    font-size: 13.5px; color: #9aa5b1; line-height: 1.6;
  }

  /* ----- Final CTA ----- */
  .at-cta-final { text-align: center; margin: 80px 0 40px; }
  .at-cta-title {
    font-size: 30px; font-weight: 700; color: #e8edf2; margin: 0 0 12px 0;
  }
  .at-cta-sub {
    font-size: 14.5px; color: #9aa5b1; margin: 0 auto 28px; max-width: 480px;
  }
  .at-cta-login {
    font-size: 13.5px; color: #8590a0; margin-top: 16px;
  }
  .at-cta-login a {
    color: #4ad991; text-decoration: none; font-weight: 500;
  }
  .at-cta-login a:hover { text-decoration: underline; }
  .at-cta-help { font-size: 13px; color: #6b7480; margin-top: 20px; }
  .at-cta-help a { color: #4ad991; text-decoration: none; }
  .at-cta-help a:hover { text-decoration: underline; }

  @media (max-width: 640px) {
    .at-hero-title { font-size: 32px; }
    .at-hero-sub { font-size: 15px; }
    .at-section { margin: 40px 0; }
    .at-section-title { font-size: 19px; }
    .at-cta-title { font-size: 24px; }
  }
  @media (max-width: 480px) {
    .at-price-num { font-size: 38px; }
    .at-hero-title { font-size: 26px; }
  }
</style>
`;
}

export async function autotradingRoute(app: FastifyInstance): Promise<void> {
  app.get('/autotrading', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300'); // 5 min CDN-style cache
    return reply.send(renderPage());
  });
}

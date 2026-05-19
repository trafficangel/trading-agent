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
import { STRATEGY_CONFIGS } from './track-c-config.js';

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
        <a href="/strategies" class="at-btn-primary">${ico('🚀')}Попробовать бесплатно</a>
        <div class="at-hero-pricing">
          <b>${TRIAL_DAYS} дней бесплатно</b>, потом <b>$${PRICE_USD}/мес</b>
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
            Создайте ключ на Bybit с правом <b>только на торговлю</b> и
            IP-whitelist (наш VPS). Подробная инструкция в кабинете.
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
          <div class="at-safety-icon">${ico('🌐')}</div>
          <div class="at-safety-title">IP-whitelist</div>
          <div class="at-safety-body">
            Ключ работает <b>только с нашего VPS</b>. Даже если ключ
            утечёт — он бесполезен для атакующего без правильного IP.
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
  return `
    <section class="at-section at-pricing">
      <h2 class="at-section-title">${ico('💳')}Стоимость</h2>
      <div class="at-price-card">
        <div class="at-price-amount">
          <span class="at-price-num">$${PRICE_USD}</span>
          <span class="at-price-period">/ месяц</span>
        </div>
        <ul class="at-price-features">
          <li>${ico('🎁')}<b>${TRIAL_DAYS} дней бесплатно</b> — без привязки карты</li>
          <li>${ico('🤖')}Все стратегии портфеля доступны сразу</li>
          <li>${ico('📊')}Кабинет с live-статистикой и историей сделок</li>
          <li>${ico('💬')}Поддержка в Telegram</li>
          <li>${ico('⏹')}Отмена в любой момент</li>
        </ul>
        <a href="/strategies" class="at-btn-primary at-btn-full">Начать ${TRIAL_DAYS}-дневный триал</a>
        <div class="at-price-note">
          Оплата подписки пока вручную через оператора. После окончания
          триала свяжемся в Telegram для оплаты — никаких автосписаний.
        </div>
      </div>
    </section>
  `;
}

function renderFaq(): string {
  const items = [
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
      <a href="/strategies" class="at-btn-primary at-btn-large">Зарегистрироваться</a>
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

  /* ----- Pricing ----- */
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

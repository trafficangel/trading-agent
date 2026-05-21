/**
 * Public landing — `/autotrading` (Track D/E pitch).
 *
 * Phase D rewrite (May 21, 2026):
 *   - 14-day automatic trial REMOVED. Free month is conditional on
 *     Bybit referral signup via BYBIT_REF_URL.
 *   - Pricing changed from grid to horizontal scroll-snap carousel
 *     with virtual «Free» card upfront.
 *   - Hero CTA is explicit «Регистрация» (not «How it works»).
 *   - Tier choice belongs to the user (auto-assign reframed as
 *     «suggested by your balance»). Balance check just validates.
 *   - FAQ adds BingX + Hyperliquid roadmap.
 *   - New positive-leverage block alongside the red/green safety block.
 *
 * CTA leads to /strategies (existing OTP-gated registration form).
 * Once registered, users land in /account and see the onboarding
 * checklist (register ✓ → Bybit → deposit → trade).
 */

import type { FastifyInstance } from 'fastify';
import { pageShell } from './landing.js';
import { STRATEGY_CONFIGS, BYBIT_REF_URL, BYBIT_REF_BONUS_DAYS } from './track-c-config.js';
import { listTiers } from './tier-config.js';

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
      ${renderPricing()}
      ${renderBybitBonus()}
      ${renderLeveragePositive()}
      ${renderSafety()}
      ${renderLeverageEducation()}

      <section class="at-section at-strat-details">
        <details class="at-strat-details-toggle">
          <summary>
            ${ico('🔍')}Хотите разобраться, какие именно стратегии торгуют?
            <span class="at-strat-details-hint">(для дотошных)</span>
          </summary>
          <div class="at-strat-details-content">
            <p>
              Мы используем стратегии созданные через <b>LuxAlgo AI Strategy Builder</b> —
              известный сервис для разработки алгоритмических стратегий.
              Каждую стратегию мы предварительно проверяем на бэктесте минимум 200 дней
              и пересчитываем доходность на реальную комиссию Bybit.
              На странице каждой стратегии — её полная история сделок, win-rate, drawdown.
            </p>
            <div class="at-strat-grid">${stratList}</div>
            <div style="text-align:center; margin-top:18px">
              <a href="/strategies" class="at-btn-secondary">Полная статистика всех стратегий →</a>
            </div>
          </div>
        </details>
      </section>

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
      <div class="at-hero-eyebrow">Автоматическая торговля криптовалютой · Bybit</div>
      <h1 class="at-hero-title">
        Пассивный доход на криптотрейдинге. <span class="at-accent">Деньги — на вашей бирже.</span>
      </h1>
      <p class="at-hero-sub">
        Наша система торгует за вас на вашем счёте Bybit по проверенным стратегиям.
        Вы не торгуете руками — система открывает и закрывает позиции автоматически.
        <b>Это не фонд и не пирамида</b> — мы не принимаем депозиты на нашу сторону.
        Ваши средства всегда у вас на бирже под вашим контролем.
      </p>
      <div class="at-hero-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}Регистрация</a>
        <span class="at-hero-cta-or">или</span>
        <a href="#pricing" class="at-hero-link">посмотреть тарифы ↓</a>
      </div>
      <div class="at-hero-pills">
        <span class="at-pill">${ico('🛡')}Деньги на Bybit, не у нас</span>
        <span class="at-pill">${ico('🚫')}Ключ без права на вывод</span>
        <span class="at-pill at-pill-hl">${ico('💸')}Минус-месяц → следующий бесплатно</span>
        <span class="at-pill">${ico('🎁')}+${BYBIT_REF_BONUS_DAYS} дней бесплатно</span>
        <span class="at-pill">${ico('⏹')}Отмена в один клик</span>
      </div>
      <div class="at-hero-login">
        Уже зарегистрированы? <a href="/strategies?login=1">Войти в кабинет →</a>
      </div>
    </section>
  `;
}

function renderBybitBonus(): string {
  return `
    <section class="at-section at-bonus" id="bonus">
      <div class="at-bonus-card">
        <div class="at-bonus-icon">${ico('🎁')}</div>
        <div class="at-bonus-body">
          <div class="at-bonus-title">Получите +${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно</div>
          <div class="at-bonus-sub">
            Зарегистрируйте новый аккаунт на Bybit по нашей ссылке — и мы добавим вам
            <b>${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно</b>. Полный Starter:
            3 стратегии, реальная торговля, ваш депозит, ваш контроль.
            Кнопка ниже — стандартная регистрация на Bybit, без скрытых платежей.
          </div>
        </div>
        <div class="at-bonus-actions">
          <a class="at-btn-primary" href="${BYBIT_REF_URL}" target="_blank" rel="noopener">
            ${ico('🚀')}Открыть Bybit
          </a>
          <a class="at-btn-secondary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
            Спросить оператора
          </a>
        </div>
      </div>
    </section>
  `;
}

function renderHowItWorks(): string {
  return `
    <section class="at-section at-how" id="how">
      <h2 class="at-section-title">${ico('🛠')}Как начать за 4 шага</h2>
      <p class="at-section-sub">
        Если у вас уже есть Bybit-аккаунт с депозитом — все 4 шага занимают ~10 минут.
        Если нет — сначала Bybit (см. шаг 3 — там бонус +${BYBIT_REF_BONUS_DAYS} дней автотрейдинга).
      </p>
      <div class="at-how-grid">
        <div class="at-how-step">
          <div class="at-how-num">1</div>
          <div class="at-how-title">Регистрация</div>
          <div class="at-how-body">
            По номеру телефона через Telegram-бот — 30 секунд. Без паролей, без email,
            без подтверждения карты. Сразу попадаете в личный кабинет.
            <a href="/strategies?from=autotrading">Зарегистрироваться →</a>
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">2</div>
          <div class="at-how-title">Выбор тарифа</div>
          <div class="at-how-body">
            Посмотрите <a href="#pricing">тарифную сетку</a> ниже на странице.
            Решите, какой депозит готовы выделить ($300 минимум). Чем больше —
            тем больше стратегий включается в работу и тем выше потенциальная прибыль.
            <b>Депозит остаётся на вашем Bybit</b>, нам ничего переводить не нужно.
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">3</div>
          <div class="at-how-title">Подключение Bybit</div>
          <div class="at-how-body">
            Если у вас ещё нет аккаунта на Bybit —
            <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">зарегистрируйтесь по нашей ссылке</a>
            и получите <b>+${BYBIT_REF_BONUS_DAYS} дней автотрейдинга</b>.
            Затем создаёте API-ключ <b>с правом только на торговлю</b>
            (без вывода средств) — инструкция со скриншотами в кабинете,
            одна кнопка открывает нужную страницу Bybit.
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">4</div>
          <div class="at-how-title">Пополнение и старт</div>
          <div class="at-how-body">
            Переведите USDT на <b>Derivatives-кошелёк</b> Bybit под выбранный тариф
            (минимум $300 для Starter, $800 для Standard, и т.д.).
            Стратегии включатся автоматически и <b>сама начнут торговать</b>.
            Открывайте кабинет — и просто смотрите, как идут сделки.
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderSafety(): string {
  return `
    <section class="at-section at-safety">
      <h2 class="at-section-title">${ico('🛡')}Это не пирамида и не фонд</h2>
      <p class="at-section-sub">
        Главное отличие нашего сервиса от «волшебных стратегий» и копитрейдинг-пирамид:
        <b>ваши деньги всё время у вас</b>. Мы — софт-сервис, который выставляет ордера
        на вашем счёте Bybit по API. Не банк, не управляющая компания, не фонд.
      </p>
      <div class="at-safety-grid">
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('💰')}</div>
          <div class="at-safety-title">Депозит — на вашей бирже</div>
          <div class="at-safety-body">
            Вы ничего не переводите нам. Депозит лежит на <b>вашем</b> аккаунте Bybit.
            Тариф у нас — это лишь конфигурация торговли вашего капитала,
            не вложение в наш «фонд».
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🚫')}</div>
          <div class="at-safety-title">Не можем вывести деньги</div>
          <div class="at-safety-body">
            API-ключ создаётся <b>без права на withdraw и transfer</b>.
            Технически невозможно вывести что-то с вашего счёта —
            Bybit отклонит любую попытку с нашей стороны.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🔒')}</div>
          <div class="at-safety-title">Ключи зашифрованы</div>
          <div class="at-safety-body">
            При сохранении ключ шифруется <b>AES-256-GCM</b>. Даже наш сервер
            не может прочитать ваш secret после ввода — только использовать
            для выставления ордеров через Bybit API.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🤖')}</div>
          <div class="at-safety-title">Только торговля и стоп</div>
          <div class="at-safety-body">
            С вашим ключом мы делаем только три действия: открыть позицию,
            закрыть позицию, поставить защитный стоп. Доступ к споту, переводам,
            профилю — невозможен.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('⏹')}</div>
          <div class="at-safety-title">Отзыв в один клик</div>
          <div class="at-safety-body">
            Не нравится результат — отключите ключ в кабинете или удалите
            его на Bybit. Открытые позиции мы закроем market-ордером перед
            отключением. Ваши деньги останутся как есть.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('📊')}</div>
          <div class="at-safety-title">Открытая статистика</div>
          <div class="at-safety-body">
            Все сделки наших стратегий — публичны на сайте, в режиме
            реального времени. Никто не «прячет» убытки, никаких
            «отобранных» успешных скриншотов.
          </div>
        </div>
        <div class="at-safety-card at-safety-card-hl">
          <div class="at-safety-icon">${ico('💸')}</div>
          <div class="at-safety-title">Money-back: убыточный месяц → следующий бесплатно</div>
          <div class="at-safety-body">
            Если по итогам календарного месяца ваш счёт на нашей системе
            ушёл в минус (сумма закрытых сделок < $0) — мы автоматически
            продлеваем подписку на 30 дней <b>бесплатно</b>. Не нужно
            писать оператору, мы сами сделаем. <b>Мы платим только если
            заработали для вас</b>.
          </div>
        </div>
      </div>
    </section>
  `;
}

/**
 * Positive framing of leverage — answer to «но я же боюсь плеча,
 * меня тренировали так думать». Показываем что плечо + защитный
 * стоп = инструмент роста PnL без увеличения риска.
 */
function renderLeveragePositive(): string {
  return `
    <section class="at-section at-lev-pos">
      <h2 class="at-section-title">${ico('⚡')}Зачем нам плечо: больше прибыли с управляемым риском</h2>
      <p class="at-section-sub">
        Плечо у нас — это не «казино», это инструмент. Оно позволяет открыть позицию
        <b>в несколько раз больше</b>, чем размер маржи, и заработать больше с того же депозита —
        при условии что риск контролируется фиксированным стоп-лоссом.
      </p>
      <div class="at-lev-pos-grid">
        <div class="at-lev-pos-col at-lev-pos-without">
          <div class="at-lev-pos-col-title">${ico('🐢')}Без плеча — депозит $1 000 на BCH</div>
          <div class="at-lev-pos-stats">
            <div class="at-lev-pos-row"><span>Маржа в сделке</span><b>$200</b></div>
            <div class="at-lev-pos-row"><span>Размер позиции</span><b>$200</b></div>
            <div class="at-lev-pos-row"><span>Плечо</span><b>1×</b></div>
            <div class="at-lev-pos-row at-lev-pos-row-hl"><span>Ожидаемый PnL/мес</span><b>~$2.6</b></div>
            <div class="at-lev-pos-row"><span>Худшая потеря (SL hit)</span><b>$8 (0.8%)</b></div>
          </div>
          <div class="at-lev-pos-conclusion">
            На таком депозите плечо 1× даёт <b>0.3% прироста в месяц</b> — это меньше,
            чем стоит подписка, и даже банковский вклад прибыльнее.
          </div>
        </div>
        <div class="at-lev-pos-col at-lev-pos-with">
          <div class="at-lev-pos-col-title">${ico('🚀')}С безопасным плечом 11× — тот же $1 000</div>
          <div class="at-lev-pos-stats">
            <div class="at-lev-pos-row"><span>Маржа в сделке</span><b>$200</b></div>
            <div class="at-lev-pos-row"><span>Размер позиции</span><b>$2 200</b></div>
            <div class="at-lev-pos-row"><span>Плечо</span><b>11×</b></div>
            <div class="at-lev-pos-row at-lev-pos-row-hl"><span>Ожидаемый PnL/мес</span><b>~$29</b></div>
            <div class="at-lev-pos-row"><span>Худшая потеря (SL hit)</span><b>$88 (8.8%)</b></div>
          </div>
          <div class="at-lev-pos-conclusion">
            То же депозита, но <b>в 11 раз больше торгового объёма</b> → в 11 раз
            больше прибыли. <b>Стоп-лосс срабатывает раньше ликвидации</b>: убыток
            заранее известный, фиксированный.
          </div>
        </div>
      </div>
      <div class="at-lev-pos-callout">
        ${ico('🎯')}<b>Главная мысль:</b> плечо — это <b>множитель доступного капитала</b>.
        Без управления риском оно опасно. С нашим стоп-лоссом (формула <code>safe_leverage = floor(0.7 / (slPct + 0.02))</code>)
        ликвидация структурно невозможна, а PnL растёт пропорционально плечу.
        Это <b>не «играть в казино плечом 50×»</b> — это математически выверенный размер позиции.
      </div>
    </section>
  `;
}

/**
 * Leverage demystification — отдельная секция для пользователей, которые
 * боятся плеча из-за прошлых неудачных опытов или травмирующего опыта
 * мейнстримных «гуру» которые говорят «плечо = смерть».
 */
function renderLeverageEducation(): string {
  return `
    <section class="at-section at-leverage">
      <h2 class="at-section-title">${ico('🛡')}Почему ликвидация исключена</h2>
      <p class="at-section-sub">
        Многие блогеры говорят «плечо — это смерть». На самом деле плечо опасно
        не само по себе, а <b>без управления риском</b>. Сравним два подхода —
        типичный и наш.
      </p>
      <div class="at-lev-grid">
        <div class="at-lev-bad">
          <div class="at-lev-card-title">${ico('💀')}Как теряют деньги другие</div>
          <ol class="at-lev-list">
            <li>Открывают позицию с плечом 20×-50× «потому что хочется быстро»</li>
            <li>Не ставят стоп-лосс «потому что верят в идею»</li>
            <li>Цена идёт на 2-5% против — биржа закрывает позицию принудительно (ликвидация)</li>
            <li>Теряют весь маржинальный депозит за минуты</li>
            <li>«Плечо — это зло»</li>
          </ol>
        </div>
        <div class="at-lev-good">
          <div class="at-lev-card-title">${ico('🛡')}Как у нас</div>
          <ol class="at-lev-list">
            <li><b>Плечо подбирается под стоп-лосс</b> стратегии — индивидуально для каждой пары</li>
            <li><b>Формула</b>: <code>leverage = floor(0.7 / (slPct + 0.02))</code> — 30% запас до ликвидации</li>
            <li>Например BCH с SL 4% → плечо 11× (а не 50×). На BTC SL 5% → плечо 10×</li>
            <li>Если цена идёт против — сначала срабатывает наш стоп-лосс (фиксируем известный убыток), <b>биржа не успевает ликвидировать</b></li>
            <li>Максимальная потеря на одной сделке — <b>1.5-2.5%</b> от вашего депозита</li>
          </ol>
        </div>
      </div>
      <div class="at-lev-example">
        <h3 class="at-lev-example-title">Пример: одна сделка по BCH в тарифе Plus</h3>
        <div class="at-lev-example-grid">
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Ваш депозит</div>
            <div class="at-lev-stat-val">$3 000</div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Margin (заморозка)</div>
            <div class="at-lev-stat-val">$90 <span class="at-lev-pct">(3%)</span></div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Плечо</div>
            <div class="at-lev-stat-val">11×</div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Размер позиции</div>
            <div class="at-lev-stat-val">$990</div>
          </div>
          <div class="at-lev-stat at-lev-stat-bad">
            <div class="at-lev-stat-label">Худший убыток (SL hit)</div>
            <div class="at-lev-stat-val">$39.60 <span class="at-lev-pct">(1.3%)</span></div>
          </div>
          <div class="at-lev-stat at-lev-stat-ok">
            <div class="at-lev-stat-label">Ликвидация</div>
            <div class="at-lev-stat-val">${ico('🚫')}Невозможна</div>
          </div>
        </div>
        <p class="at-lev-note">
          Стоп-лосс срабатывает раньше ликвидации, потому что мы оставили 30% буфер
          между ним и ликвидационной ценой биржи. Это не магия — это математика
          управления риском.
        </p>
      </div>
    </section>
  `;
}

function renderPricing(): string {
  const tiers = listTiers();
  const starterPrice = tiers[0]?.monthlyPriceUsd ?? 12;

  // Virtual Free card — not in TIER_CONFIGS. Conditional on Bybit referral signup.
  const freeCard = `
    <div class="at-tier-card at-tier-free">
      <div class="at-tier-badge">${ico('🎁')}Бонус</div>
      <div class="at-tier-name">🆓 Free</div>
      <div class="at-tier-depo">$300+ депозит на Bybit</div>
      <div class="at-tier-price">
        <span class="at-tier-price-num">$0</span>
        <span class="at-tier-price-period">/мес × ${BYBIT_REF_BONUS_DAYS} дней</span>
      </div>
      <ul class="at-tier-features">
        <li>3 стратегии (как Starter)</li>
        <li>До 2 одновременных позиций</li>
        <li>Реальная торговля на вашем счёте</li>
        <li><b>Условие</b>: новый аккаунт Bybit по <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">нашей ссылке</a></li>
      </ul>
      <div class="at-tier-pitch">
        Полный Starter на ${BYBIT_REF_BONUS_DAYS} дней, без оплаты. После — переход на платный Starter $${starterPrice}/мес или отключение.
      </div>
    </div>
  `;

  const cards = tiers
    .map((t, i) => {
      const isPopular = t.id === 'standard';
      const maxStr = t.maxBalanceUsdt === Number.POSITIVE_INFINITY ? '∞' : `$${t.maxBalanceUsdt.toLocaleString()}`;
      const sub = t.expectedMonthlyPnlRangeUsd;
      const badge = isPopular ? `<div class="at-tier-badge at-tier-badge-popular">${ico('⭐')}Популярный</div>` : '';
      return `
        <div class="at-tier-card ${isPopular ? 'at-tier-popular' : ''}" data-tier-index="${i + 1}">
          ${badge}
          <div class="at-tier-name">${tierEmoji(t.id)} ${escapeHtml(t.name)}</div>
          <div class="at-tier-depo">Депозит $${t.minBalanceUsdt.toLocaleString()}–${maxStr}</div>
          <div class="at-tier-price">
            <span class="at-tier-price-num">$${t.monthlyPriceUsd}</span>
            <span class="at-tier-price-period">/мес</span>
          </div>
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
    <section class="at-section at-pricing" id="pricing">
      <h2 class="at-section-title">${ico('💳')}Тарифы и доходность</h2>
      <p class="at-pricing-intro">
        Тариф вы выбираете сами по размеру депозита, который готовы выделить под автотрейдинг.
        Чем больше депозит — тем больше стратегий в работе и тем выше ожидаемая прибыль.
        Подписка покрывает не больше 18-20% потенциального месячного дохода.
        <b>Прокрутите вправо</b>, чтобы увидеть все тарифы →
      </p>
      <div class="at-tier-carousel" role="region" aria-label="Тарифы">
        ${freeCard}
        ${cards}
      </div>
      <div class="at-tier-scroll-hint">
        ${ico('👆')}Свайпните или прокрутите вбок чтобы листать тарифы
      </div>
      <div class="at-pricing-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}Зарегистрироваться</a>
        <div class="at-pricing-cta-sub">
          После регистрации — выберете тариф, подключите Bybit, начнёте торговать.
        </div>
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
      q: 'Чем вы отличаетесь от копитрейдинг-пирамид и «волшебных» сервисов?',
      a: 'Главное: ваши деньги остаются на вашем Bybit-аккаунте. Мы их не принимаем, не управляем фондом, не обещаем фиксированную доходность. Наш сервис — это софт, который выставляет торговые ордера на вашем счёте по проверенным стратегиям. Технически невозможно вывести что-то с вашего счёта в нашу сторону: ключ создаётся без права на withdraw и transfer.',
    },
    {
      q: 'Как назначается тариф? Я могу выбрать сам?',
      a: 'Тариф выбираете вы сами при подключении Bybit-аккаунта. Мы только проверяем, что ваш баланс достаточен для выбранного тарифа: $300+ для Starter, $800+ для Standard, $2 500+ для Plus и т.д. Если выбрали Plus, а на счёте $500 — попросим пополнить или выбрать тариф попроще. Если депозит вырастет — подскажем перейти на тариф выше с пересчётом подписки. Если депозит сильно упадёт — автоматически переключим на меньший тариф через 72 часа, открытые позиции не трогаются.',
    },
    {
      q: `Как получить ${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно?`,
      a: `Условие одно: зарегистрируйте новый аккаунт на Bybit по нашей ссылке (кнопка «Открыть Bybit» в блоке «Получите +${BYBIT_REF_BONUS_DAYS} дней» на этой странице). После регистрации создаёте API-ключ как обычно и подключаете его в нашем кабинете. Мы автоматически проверим что ваш Bybit-аккаунт зарегистрирован по нашему партнёрскому каналу, и активируем ${BYBIT_REF_BONUS_DAYS} дней автотрейдинга без оплаты. По истечении бонусного периода — стандартная подписка $${listTiers()[0]?.monthlyPriceUsd ?? 12}/мес за Starter или отключение в один клик.`,
    },
    {
      q: 'Сколько денег нужно для начала?',
      a: 'Минимум $300 USDT на Bybit Derivatives кошельке. Ниже этой суммы автотрейдинг не запускается — это экономически невыгодно ни вам, ни нам (даже подписка съест значимую часть ожидаемой прибыли).',
    },
    {
      q: 'Что такое плечо и не опасно ли это?',
      a: 'Плечо — это инструмент, который позволяет открыть позицию больше, чем у вас заморожено маржи. Опасно его использовать БЕЗ управления риском. У нас плечо подобрано автоматически под стоп-лосс каждой стратегии так, чтобы СНАЧАЛА срабатывал наш стоп (фиксированный убыток 1-3% депозита), а не ликвидация биржи. Ваш максимальный убыток на одной сделке известен заранее. Подробнее в секциях «Безопасное плечо» и «Почему ликвидация исключена» выше.',
    },
    {
      q: 'Зачем тогда плечо если оно опасно?',
      a: 'Без плеча торговать криптофьючерсами в режиме автотрейдинга экономически бессмысленно: на депозите $1 000 при размере позиции $200 ожидаемая прибыль ~$2.6/мес — меньше подписки. С плечом 11× (безопасно подобранным под наш SL) тот же депозит торгует объёмом $2 200, и ожидаемая прибыль становится $29/мес. Главное — стоп-лосс срабатывает раньше ликвидации, поэтому худший убыток в сделке известен заранее. Это математика, а не казино.',
    },
    {
      q: 'Какие биржи поддерживаются? Будут ли другие?',
      a: 'Сейчас только Bybit USDT-perp futures — выбрали потому что хорошая ликвидность, низкие комиссии (0.055% taker), и удобный API. На очереди: <b>BingX</b> (CEX, для рынков где Bybit недоступен по гео — Q3 2026), затем <b>Hyperliquid</b> (DEX-perp, для пользователей которые принципиально не хотят KYC и предпочитают on-chain — Q4 2026). Когда добавим — вы сможете в кабинете переключить «биржу для автотрейдинга» без перерегистрации.',
    },
    {
      q: 'Что если стратегия в минусе?',
      a: 'Каждая стратегия имеет защитный стоп-лосс. Просадки бывают, это нормально для любой торговой системы. У тарифа есть обещание макс. просадки (Starter ≤8%, Standard ≤15%, Plus/Pro/VIP ≤18%). Если просадка превышает обещанное — мы пересматриваем тариф или исключаем стратегию.',
    },
    {
      q: '💸 Что если месяц закрылся в минус — я платил подписку зря?',
      a: '<b>Нет.</b> У нас работает <b>money-back guarantee</b>: если сумма закрытых сделок за календарный месяц на вашем счёте была отрицательной, мы автоматически продлеваем подписку на <b>следующие 30 дней бесплатно</b>. Логика — раз за месяц вы не заработали, мы тоже не зарабатываем. <b>Условия</b>: применяется с первого <i>оплаченного</i> месяца (триал и Bybit-бонус не считаются), и считается ваш персональный PnL, а не наш shadow-аккаунт. Никаких заявок не нужно — программа сама проверяет 1-го числа каждого месяца и продлевает access. В Telegram-логах вы увидите уведомление о применении гарантии.',
    },
    {
      q: 'Можно ли вручную закрыть позицию или поторговать самому?',
      a: 'Да, в любой момент через интерфейс Bybit. Наша система не противодействует — она увидит закрытие при следующей сверке (раз в минуту) и пометит сделку завершённой в вашей истории. Можете торговать параллельно на том же аккаунте — мы трогаем только позиции которые открывала наша система.',
    },
    {
      q: 'Как остановить торговлю?',
      a: 'В кабинете /account/strategies нажмите «Остановить торговлю» — новые сделки перестанут открываться. Открытые позиции продолжат жить со стопами до естественного закрытия. Возобновить торговлю — кнопка «Возобновить» там же. Для полного отказа — отключите API-ключ в /account/api-key (открытые позиции мы предварительно закроем market-ордером).',
    },
    {
      q: 'Прошлая доходность гарантирует будущую?',
      a: 'Нет. Все цифры на сайте — это исторический бэктест и реальная статистика наших стратегий. Рынок меняется, любая стратегия может перестать работать. Криптотрейдинг сопряжён с риском полной потери капитала. Не торгуйте больше, чем готовы потерять.',
    },
    {
      q: 'Как происходит оплата?',
      a: `Если вы зарегистрировали Bybit по нашей ссылке — первые ${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно (определяется автоматически при подключении ключа). После окончания бонусного периода — связываемся с вами в Telegram для оплаты подписки. Если вы пришли со «своим» Bybit — подписка начинается с первого дня. Никаких автосписаний с карты, оплата ручная через оператора. Вы сами решаете, продлевать ли подписку. Плюс работает money-back guarantee (см. вопрос «Что если месяц закрылся в минус»).`,
    },
  ];
  const html = items
    .map(
      (it) => `
        <details class="at-faq-item">
          <summary>${escapeHtml(it.q)}</summary>
          <div class="at-faq-answer">${it.a}</div>
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
      <h2 class="at-cta-title">Готовы запустить пассивный доход?</h2>
      <p class="at-cta-sub">
        Регистрация — 30 секунд. Без привязки карты. Отмена в один клик.
        Ваш капитал остаётся на Bybit под вашим контролем.
        +${BYBIT_REF_BONUS_DAYS} дней бесплатно если зарегистрируетесь на Bybit по <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">нашей ссылке</a>.
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
  .at-hero-cta {
    display: flex; flex-direction: row; flex-wrap: wrap;
    align-items: center; justify-content: center; gap: 12px;
  }
  .at-hero-cta-or { font-size: 13px; color: #6b7480; }
  .at-hero-link {
    color: #4ad991; font-size: 14px; text-decoration: none; font-weight: 500;
  }
  .at-hero-link:hover { text-decoration: underline; }
  .at-hero-pricing { font-size: 13.5px; color: #8590a0; }
  .at-hero-pricing b { color: #cfd6dd; }
  .at-hero-login {
    font-size: 13px; color: #6b7480; margin-top: 8px;
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
  .at-pill-hl {
    color: #4ad991; border-color: rgba(74, 217, 145, 0.45);
    background: rgba(74, 217, 145, 0.06);
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
  /* Explicit breakpoints to avoid the 3+1 wrap that auto-fit produces
   * around 1000px width: desktop = 4 in a row, tablet = 2×2 grid,
   * mobile = single column. Predictable composition for the funnel. */
  .at-how-grid {
    display: grid; gap: 18px;
    grid-template-columns: repeat(4, 1fr);
  }
  @media (max-width: 980px) {
    .at-how-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 540px) {
    .at-how-grid { grid-template-columns: 1fr; }
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
  .at-how-body a { color: #4ad991; text-decoration: none; }
  .at-how-body a:hover { text-decoration: underline; }

  /* ----- Safety ----- */
  .at-safety-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
  }
  .at-safety-card {
    background: #0e131a; border: 1px solid #1a1f27; border-radius: 12px;
    padding: 18px 20px;
  }
  .at-safety-card-hl {
    background: linear-gradient(180deg, rgba(74,217,145,0.06) 0%, #0e131a 70%);
    border-color: rgba(74, 217, 145, 0.45);
    grid-column: 1 / -1;
  }
  .at-safety-card-hl .at-safety-title { color: #4ad991; font-size: 16px; }
  .at-safety-card-hl .at-safety-body { color: #cfd6dd; font-size: 13.5px; }
  .at-safety-card-hl .at-safety-body b { color: #4ad991; }
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

  /* ----- Pricing (TRACK E carousel) -----
   * Horizontal scroll-snap carousel using flexbox with FIXED-width cards.
   * The earlier grid-auto-columns approach broke on desktop because 1fr
   * stretched all 6 cards to fit the container instead of overflowing.
   * Flex with "flex: 0 0 320px" forces each card to keep its width and
   * the row overflows horizontally so the user has something to scroll.
   */
  .at-pricing-intro {
    text-align: center; color: #cfd6dd; font-size: 14px; line-height: 1.6;
    max-width: 720px; margin: 0 auto 24px;
  }
  .at-pricing-intro b { color: #4ad991; }
  .at-tier-carousel {
    display: flex;
    gap: 16px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding: 24px 4px 16px;
    margin: 0 -4px 12px;
    scrollbar-color: #2a323d transparent;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }
  .at-tier-carousel::-webkit-scrollbar { height: 8px; }
  .at-tier-carousel::-webkit-scrollbar-track { background: transparent; }
  .at-tier-carousel::-webkit-scrollbar-thumb { background: #2a323d; border-radius: 4px; }
  .at-tier-scroll-hint {
    text-align: center; font-size: 11.5px; color: #6b7480;
    margin: 6px 0 18px; letter-spacing: 0.02em;
  }
  .at-tier-card {
    background: linear-gradient(180deg, #161c25 0%, #11161d 70%);
    border: 1px solid #1f2630; border-radius: 14px;
    padding: 28px 18px 20px;
    display: flex; flex-direction: column;
    scroll-snap-align: start;
    position: relative;
    /* Fixed width so the row actually overflows and a horizontal scroll
     * appears. 320px wide ≈ comfortable card; on mobile (≤640px) we use
     * 86vw so only one card is visible at a time and the swipe feels natural. */
    flex: 0 0 320px;
    min-width: 0;
  }
  @media (max-width: 640px) {
    .at-tier-card { flex: 0 0 86vw; }
  }
  .at-tier-card.at-tier-popular {
    border-color: rgba(74, 217, 145, 0.55);
    background: linear-gradient(180deg, rgba(74,217,145,0.06) 0%, #11161d 70%);
  }
  .at-tier-card.at-tier-free {
    border-color: rgba(243, 210, 102, 0.55);
    background: linear-gradient(180deg, rgba(243,210,102,0.05) 0%, #11161d 70%);
  }
  .at-tier-badge {
    /* Badge sits inside the card padding (top: 8px) so the carousel
     * overflow-x doesn't clip it. Padding-top on the card reserves room. */
    position: absolute; top: 8px; left: 14px;
    background: rgba(243, 210, 102, 0.18);
    color: #f3d266;
    padding: 3px 10px; border-radius: 999px;
    font-size: 10.5px; font-weight: 600;
    border: 1px solid rgba(243, 210, 102, 0.4);
    letter-spacing: 0.04em;
  }
  .at-tier-badge-popular {
    background: rgba(74, 217, 145, 0.18);
    color: #4ad991;
    border-color: rgba(74, 217, 145, 0.45);
  }
  .at-tier-name {
    font-size: 16px; font-weight: 600; color: #e8edf2; margin-bottom: 4px;
  }
  .at-tier-depo { font-size: 11.5px; color: #8590a0; margin-bottom: 12px; }
  .at-tier-price { display: flex; align-items: baseline; gap: 4px; margin-bottom: 14px; }
  .at-tier-price-num { font-size: 28px; font-weight: 700; color: #4ad991; }
  .at-tier-free .at-tier-price-num { color: #f3d266; }
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
  .at-tier-features a {
    color: #4ad991; text-decoration: none;
  }
  .at-tier-features a:hover { text-decoration: underline; }
  .at-tier-pitch { font-size: 11.5px; color: #8590a0; line-height: 1.5; margin-top: auto; padding-top: 10px; border-top: 1px solid #1a1f27; }
  .at-pricing-cta { text-align: center; margin: 28px 0 18px; }
  .at-pricing-cta-sub { font-size: 12.5px; color: #8590a0; margin-top: 10px; }
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

  /* ----- Leverage Positive (new — emphasize PnL upside) ----- */
  .at-lev-pos { margin: 60px auto; }
  .at-lev-pos-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
  }
  .at-lev-pos-col {
    padding: 22px 24px; border-radius: 14px;
    background: #11161d;
    border: 1px solid #1f2630;
  }
  .at-lev-pos-col.at-lev-pos-without { opacity: 0.85; }
  .at-lev-pos-col.at-lev-pos-with {
    border-color: rgba(74, 217, 145, 0.45);
    background: linear-gradient(180deg, rgba(74,217,145,0.05) 0%, #11161d 70%);
  }
  .at-lev-pos-col-title {
    font-size: 15px; font-weight: 600; color: #e8edf2; margin-bottom: 14px;
  }
  .at-lev-pos-with .at-lev-pos-col-title { color: #4ad991; }
  .at-lev-pos-stats { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .at-lev-pos-row {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 6px 0; font-size: 13px; color: #9aa5b1;
    border-bottom: 1px dashed #1a1f27;
  }
  .at-lev-pos-row:last-child { border-bottom: none; }
  .at-lev-pos-row b { color: #e8edf2; font-size: 13.5px; font-weight: 600; }
  .at-lev-pos-row-hl b { color: #4ad991; font-size: 16px; }
  .at-lev-pos-conclusion {
    font-size: 12.5px; color: #cfd6dd; line-height: 1.6;
    padding-top: 12px; border-top: 1px solid #1a1f27;
  }
  .at-lev-pos-callout {
    margin-top: 24px;
    padding: 18px 22px;
    background: rgba(74, 217, 145, 0.06);
    border: 1px solid rgba(74, 217, 145, 0.30);
    border-radius: 12px;
    font-size: 13.5px; color: #cfd6dd; line-height: 1.6;
  }
  .at-lev-pos-callout code {
    font-family: ui-monospace, Menlo, monospace; font-size: 12.5px;
    background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;
  }
  @media (max-width: 720px) {
    .at-lev-pos-grid { grid-template-columns: 1fr; }
  }

  /* ----- Leverage Education (original red/green block) ----- */
  .at-leverage { margin: 60px auto; }
  .at-lev-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
    margin: 24px 0;
  }
  .at-lev-bad, .at-lev-good {
    padding: 22px 24px; border-radius: 14px;
  }
  .at-lev-bad {
    background: rgba(255, 99, 99, 0.06); border: 1px solid rgba(255, 99, 99, 0.30);
  }
  .at-lev-good {
    background: rgba(74, 217, 145, 0.06); border: 1px solid rgba(74, 217, 145, 0.40);
  }
  .at-lev-card-title {
    font-size: 16px; font-weight: 600; margin-bottom: 14px;
  }
  .at-lev-bad .at-lev-card-title { color: #ff8b8b; }
  .at-lev-good .at-lev-card-title { color: #4ad991; }
  .at-lev-list {
    margin: 0; padding-left: 20px; color: #cfd6dd;
    font-size: 13.5px; line-height: 1.6;
  }
  .at-lev-list li { margin-bottom: 6px; }
  .at-lev-list b { color: #e8edf2; }
  .at-lev-list code {
    font-family: ui-monospace, Menlo, monospace; font-size: 12.5px;
    background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;
  }
  .at-lev-example {
    background: #11161d; border: 1px solid #1f2630; border-radius: 14px;
    padding: 22px 24px; margin-top: 20px;
  }
  .at-lev-example-title {
    margin: 0 0 16px 0; font-size: 15px; color: #e8edf2;
  }
  .at-lev-example-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 14px; margin-bottom: 16px;
  }
  .at-lev-stat {
    padding: 12px 14px;
    background: #0e131a; border-radius: 8px;
  }
  .at-lev-stat-bad { background: rgba(255, 99, 99, 0.06); border: 1px solid rgba(255, 99, 99, 0.25); }
  .at-lev-stat-ok { background: rgba(74, 217, 145, 0.06); border: 1px solid rgba(74, 217, 145, 0.40); }
  .at-lev-stat-label {
    font-size: 10.5px; color: #6b7480; text-transform: uppercase;
    letter-spacing: 0.05em; margin-bottom: 4px;
  }
  .at-lev-stat-val { font-size: 16px; font-weight: 600; color: #e8edf2; }
  .at-lev-pct { font-size: 12px; color: #8590a0; font-weight: 400; }
  .at-lev-note {
    font-size: 13px; color: #8590a0; line-height: 1.6; margin: 0;
    padding-top: 14px; border-top: 1px solid #1a1f27;
  }

  /* ----- Strategy details (collapse) ----- */
  .at-strat-details { margin: 50px auto; }
  .at-strat-details-toggle {
    background: #11161d; border: 1px solid #1f2630; border-radius: 12px;
    padding: 18px 22px;
  }
  .at-strat-details-toggle summary {
    cursor: pointer; font-size: 15px; font-weight: 600; color: #cfd6dd;
    list-style: none;
  }
  .at-strat-details-toggle summary::-webkit-details-marker { display: none; }
  .at-strat-details-toggle summary::before {
    content: '▸'; margin-right: 8px; color: #4ad991; transition: transform 0.15s;
    display: inline-block;
  }
  .at-strat-details-toggle[open] summary::before {
    transform: rotate(90deg);
  }
  .at-strat-details-hint {
    color: #6b7480; font-weight: 400; font-size: 13px; margin-left: 6px;
  }
  .at-strat-details-content {
    padding-top: 18px; color: #cfd6dd; font-size: 13.5px; line-height: 1.6;
  }
  .at-strat-details-content p { margin: 0 0 16px 0; }

  @media (max-width: 720px) {
    .at-lev-grid { grid-template-columns: 1fr; }
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
  .at-faq-answer b { color: #e8edf2; }

  /* ----- Final CTA ----- */
  .at-cta-final { text-align: center; margin: 80px 0 40px; }
  .at-cta-title {
    font-size: 30px; font-weight: 700; color: #e8edf2; margin: 0 0 12px 0;
  }
  .at-cta-sub {
    font-size: 14.5px; color: #9aa5b1; margin: 0 auto 28px; max-width: 520px; line-height: 1.55;
  }
  .at-cta-sub a { color: #4ad991; text-decoration: none; }
  .at-cta-sub a:hover { text-decoration: underline; }
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

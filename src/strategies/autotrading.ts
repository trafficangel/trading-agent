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
 *
 * Phase M (May 22, 2026):
 *   - Bilingual RU/EN. All visible strings switch by `lang` parameter
 *     threaded through every render function. The route reads the
 *     preferred lang via getLang() (cookie → Accept-Language → 'ru').
 */

import type { FastifyInstance } from 'fastify';
import { pageShell, jsonLdService, jsonLdFaqPage, getLang } from './landing.js';
import { getAuthedUser } from '../auth/routes.js';
import { STRATEGY_CONFIGS, BYBIT_REF_URL, BYBIT_REF_BONUS_DAYS } from './track-c-config.js';
import { listTiers, tierCoinTickers, getTierMarketingNumbers, computeTierTradeSize } from './tier-config.js';

type Lang = 'ru' | 'en';

const SUPPORT_TG = 'https://t.me/dboykod';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

function ico(emoji: string): string {
  return `<span class="at-ico" aria-hidden="true">${emoji}</span>`;
}

function renderPage(
  lang: Lang,
  authed: { displayName: string | null; phone: string | null } | null = null,
): string {
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

  const stratDetailsSummary = lang === 'en'
    ? `${ico('🔍')}Want to see which strategies are actually trading?`
    : `${ico('🔍')}Хотите разобраться, какие именно стратегии торгуют?`;
  const stratDetailsHint = lang === 'en' ? '(for the curious)' : '(для дотошных)';
  const stratDetailsP = lang === 'en'
    ? `We use strategies built with <b>LuxAlgo AI Strategy Builder</b> — a well-known service for designing algorithmic strategies. Every strategy is first validated on at least 200 days of backtest data and revaluated using Bybit's real fees. Each strategy page shows its full trade history, win-rate and drawdown.`
    : `Мы используем стратегии созданные через <b>LuxAlgo AI Strategy Builder</b> — известный сервис для разработки алгоритмических стратегий. Каждую стратегию мы предварительно проверяем на исторических данных минимум 200 дней и пересчитываем доходность на реальную комиссию Bybit. На странице каждой стратегии — её полная история сделок, процент прибыльных и максимальная просадка.`;
  const stratDetailsLink = lang === 'en'
    ? 'Full statistics for all strategies →'
    : 'Полная статистика всех стратегий →';

  const body = `
    ${styles()}
    <main class="at-main">
      ${renderHero(lang)}
      ${renderBybitBonus(lang)}
      ${renderPricing(lang)}
      ${renderForecastTable(lang)}
      ${renderHowItWorks(lang)}
      ${renderDepositBreakdown(lang)}
      ${renderSafety(lang)}
      ${renderLeverageEducation(lang)}
      ${renderStrategyPipeline(lang)}

      <section class="at-section at-strat-details">
        <details class="at-strat-details-toggle">
          <summary>
            ${stratDetailsSummary}
            <span class="at-strat-details-hint">${stratDetailsHint}</span>
          </summary>
          <div class="at-strat-details-content">
            <p>${stratDetailsP}</p>
            <div class="at-strat-grid">${stratList}</div>
            <div style="text-align:center; margin-top:18px">
              <a href="/strategies" class="at-btn-secondary">${stratDetailsLink}</a>
            </div>
          </div>
        </details>
      </section>

      ${renderFaq(lang)}
      ${renderFinalCta(lang)}
    </main>
  `;

  const title = lang === 'en'
    ? 'Auto-trading on Bybit · Robot Claude'
    : 'Автотрейдинг на Bybit · Robot Claude';

  const description = lang === 'en'
    ? 'Auto-trading on your own Bybit account using vetted strategies. ' +
      'Plans from $12/mo, trade-only API key, transparent live statistics. ' +
      '14-day trial + 30 bonus days via Bybit referral signup.'
    : 'Автотрейдинг на вашем Bybit-аккаунте по проверенным стратегиям. ' +
      'Тарифы от $12/мес, ключ без права на вывод, прозрачная статистика. ' +
      '14 дней теста + 30 дней бонуса по реф-ссылке Bybit.';

  const serviceName = lang === 'en'
    ? 'Robot Claude — auto-trading on Bybit'
    : 'Robot Claude — автотрейдинг на Bybit';
  const serviceDesc = lang === 'en'
    ? 'SaaS that executes trading strategies automatically on Bybit USDT-perp futures. ' +
      'Subscriptions from $12/mo. Trade-only API key, withdraw permission disabled.'
    : 'SaaS-сервис автоматического исполнения торговых стратегий на USDT-perp фьючерсах Bybit. ' +
      'Подписка от $12/мес. Ключ trade-only, без права на withdraw.';

  return pageShell(title, body, {
    lang,
    robots: 'index, follow',
    canonicalPath: '/autotrading',
    description,
    authed,
    jsonLd: [
      jsonLdService({
        name: serviceName,
        description: serviceDesc,
        priceUsd: 12,
      }),
      jsonLdFaqPage(lang === 'en' ? FAQ_ITEMS_EN : FAQ_ITEMS_RU),
    ],
  });
}

function renderHero(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-hero">
      <div class="at-hero-eyebrow">Automated cryptocurrency trading · Bybit</div>
      <h1 class="at-hero-title">
        Passive income from crypto trading. <span class="at-accent">Funds stay on your exchange.</span>
      </h1>
      <p class="at-hero-sub">
        Our system runs vetted strategies on your own Bybit account. <b>Not a fund, not a pyramid</b> —
        we never accept deposits, your money stays on the exchange the whole time.
      </p>
      <div class="at-hero-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}Sign up</a>
        <span class="at-hero-cta-or">or</span>
        <a href="#pricing" class="at-hero-link">see pricing ↓</a>
      </div>
      <div class="at-hero-trial">
        ${ico('🎁')}<b>14 days of real trading on us</b> — no subscription, no card.
      </div>
      <div class="at-hero-login">
        Already registered? <a href="/strategies?login=1">Sign in →</a>
      </div>
      <div class="at-hero-pills">
        <span class="at-pill">${ico('🛡')}Funds on Bybit, not with us</span>
        <span class="at-pill">${ico('🚫')}Trade-only key, no withdraw</span>
        <span class="at-pill">${ico('⏹')}Cancel in one click</span>
      </div>
    </section>
  `;
  }
  return `
    <section class="at-hero">
      <div class="at-hero-eyebrow">Автоматическая торговля криптовалютой · Bybit</div>
      <h1 class="at-hero-title">
        Пассивный доход на криптотрейдинге. <span class="at-accent">Деньги — на вашей бирже.</span>
      </h1>
      <p class="at-hero-sub">
        Система торгует за вас на вашем счёте Bybit по проверенным стратегиям. <b>Не фонд и не пирамида</b> —
        мы не принимаем депозиты, ваши деньги всегда на бирже под вашим контролем.
      </p>
      <div class="at-hero-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}Регистрация</a>
        <span class="at-hero-cta-or">или</span>
        <a href="#pricing" class="at-hero-link">посмотреть тарифы ↓</a>
      </div>
      <div class="at-hero-trial">
        ${ico('🎁')}<b>14 дней реальной торговли бесплатно</b> — без подписки, без карты.
      </div>
      <div class="at-hero-login">
        Уже зарегистрированы? <a href="/strategies?login=1">Войти в кабинет →</a>
      </div>
      <div class="at-hero-pills">
        <span class="at-pill">${ico('🛡')}Деньги на Bybit, не у нас</span>
        <span class="at-pill">${ico('🚫')}Ключ без права на вывод</span>
        <span class="at-pill">${ico('⏹')}Отмена в один клик</span>
      </div>
    </section>
  `;
}

/**
 * Forecast table — Phase O. Sits right after pricing on /autotrading so
 * visitors who just looked at the prices immediately see the expected
 * monthly profit (in USD AND % of deposit) for each tier. Numbers come
 * from STRATEGY_CONFIGS[*].backtest scaled to the tier's notional —
 * same source as /admin/tiers, so if a strategy's backtest is updated
 * or the tier's strategy list changes, this section auto-recomputes.
 */
function renderForecastTable(lang: Lang): string {
  const tiers = listTiers().filter((tier) => tier.id !== 'prof');
  const t = lang === 'en'
    ? {
        title: 'Forecast monthly returns by plan',
        sub:
          'Numbers derived from each strategy\'s backtest, scaled to the trade size you would get on that plan. ' +
          'These are math expectations on historical data, not guarantees — live results will fluctuate around them.',
        colTier: 'Plan',
        colDepo: 'Deposit',
        colSub: 'Subscription',
        colProfit: 'Forecast profit',
        colPct: '% of deposit',
        colTrades: 'Trades/mo',
        perMo: '/mo',
        perYr: '/yr (× 12)',
        avgMo: 'avg',
        disclaimer: 'Past results do not guarantee future returns. Plan deposit is the minimum to qualify — actual profit scales with your deposit.',
      }
    : {
        title: 'Прогнозируемая доходность по тарифам',
        sub:
          'Цифры рассчитаны из проверки каждой стратегии на исторических данных и масштабированы на размер сделки вашего тарифа. ' +
          'Это математическое ожидание, а не гарантия — реальные результаты будут колебаться вокруг этих значений.',
        colTier: 'Тариф',
        colDepo: 'Депозит',
        colSub: 'Подписка',
        colProfit: 'Прогноз прибыли',
        colPct: '% депозита',
        colTrades: 'Сделок/мес',
        perMo: '/мес',
        perYr: '/год (× 12)',
        avgMo: 'средн.',
        disclaimer: 'Прошлые результаты не гарантируют будущих. Депозит тарифа — минимальный для активации; реальная прибыль масштабируется с вашим депозитом.',
      };

  const rows = tiers.map((tier) => {
    // Per-tier monthly aggregates from backtests scaled to tier notional.
    let tradesPerMonth = 0;
    let monthlyGrossUsd = 0;
    for (const sid of tier.strategyIds) {
      const cfg = STRATEGY_CONFIGS[sid];
      const sz = computeTierTradeSize(tier.id, sid);
      const bt = cfg?.backtest;
      if (!cfg || !sz || !bt || bt.periodDays <= 0 || bt.notionalUsd <= 0) continue;
      const scale = sz.notionalUsd / bt.notionalUsd;
      const monthlyFactor = 30 / bt.periodDays;
      tradesPerMonth += bt.totalTrades * monthlyFactor;
      monthlyGrossUsd += bt.netPnlUsd * scale * monthlyFactor;
    }
    const monthlyUsd = Math.round(monthlyGrossUsd);
    const annualUsd = monthlyUsd * 12;
    const pctMonthly = tier.minBalanceUsdt > 0
      ? (monthlyUsd / tier.minBalanceUsdt) * 100
      : 0;
    const pctAnnual = pctMonthly * 12;
    const trades = Math.round(tradesPerMonth);
    const isPopular = tier.id === 'standard';
    return `
      <tr class="${isPopular ? 'at-fc-popular' : ''}">
        <td class="at-fc-tier-cell">
          <div class="at-fc-tier-name">${tierEmoji(tier.id)} ${escapeHtml(tier.name)}</div>
          ${isPopular ? `<div class="at-fc-tier-pop">⭐ ${lang === 'en' ? 'most popular' : 'популярный'}</div>` : ''}
        </td>
        <td class="at-fc-num">$${tier.minBalanceUsdt.toLocaleString()}+</td>
        <td class="at-fc-num">$${tier.monthlyPriceUsd}${t.perMo}</td>
        <td class="at-fc-num at-fc-profit">
          <div class="at-fc-profit-mo"><b>+$${monthlyUsd}</b>${t.perMo}</div>
          <div class="at-fc-profit-yr">≈ +$${annualUsd}${t.perYr}</div>
        </td>
        <td class="at-fc-num at-fc-pct">
          <div class="at-fc-pct-mo"><b>+${pctMonthly.toFixed(1)}%</b>${t.perMo}</div>
          <div class="at-fc-pct-yr">≈ +${pctAnnual.toFixed(0)}%${t.perYr}</div>
        </td>
        <td class="at-fc-num at-fc-trades">
          <div><b>${trades}</b></div>
          <div class="at-fc-trades-sub">${t.avgMo}</div>
        </td>
      </tr>`;
  }).join('');

  return `
    <section class="at-section at-forecast" id="forecast">
      <h2 class="at-section-title">${ico('📊')}${t.title}</h2>
      <p class="at-section-sub">${t.sub}</p>
      <div class="at-fc-tbl-wrap">
        <table class="at-fc-tbl">
          <thead>
            <tr>
              <th>${t.colTier}</th>
              <th class="at-fc-num-h">${t.colDepo}</th>
              <th class="at-fc-num-h">${t.colSub}</th>
              <th class="at-fc-num-h">${t.colProfit}</th>
              <th class="at-fc-num-h">${t.colPct}</th>
              <th class="at-fc-num-h">${t.colTrades}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="at-fc-note">${t.disclaimer}</p>
    </section>
  `;
}

function renderBybitBonus(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-bonus" id="bonus">
      <div class="at-bonus-card">
        <div class="at-bonus-icon">${ico('🎁')}</div>
        <div class="at-bonus-body">
          <div class="at-bonus-title">Up to ${14 + BYBIT_REF_BONUS_DAYS} days of auto-trading for free</div>
          <div class="at-bonus-sub">
            Everyone gets a <b>14-day trial</b> on any tier with no subscription charge.
            Register a brand-new Bybit account via our link and we'll add
            <b>+${BYBIT_REF_BONUS_DAYS} bonus days</b> on top. That's up to ${14 + BYBIT_REF_BONUS_DAYS} days of real trading
            without paying — your deposit, your control.
          </div>
        </div>
        <div class="at-bonus-actions">
          <a class="at-btn-primary" href="${BYBIT_REF_URL}" target="_blank" rel="noopener">
            ${ico('🚀')}Open Bybit
          </a>
          <a class="at-btn-secondary" href="${SUPPORT_TG}" target="_blank" rel="noopener">
            Ask the operator
          </a>
        </div>
      </div>
    </section>
  `;
  }
  return `
    <section class="at-section at-bonus" id="bonus">
      <div class="at-bonus-card">
        <div class="at-bonus-icon">${ico('🎁')}</div>
        <div class="at-bonus-body">
          <div class="at-bonus-title">До ${14 + BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно</div>
          <div class="at-bonus-sub">
            Всем — <b>14 дней тестового периода</b> на любом тарифе без оплаты подписки.
            Если зарегистрируете новый аккаунт на Bybit по нашей ссылке —
            <b>+${BYBIT_REF_BONUS_DAYS} дней бонусом</b>. Итого до ${14 + BYBIT_REF_BONUS_DAYS} дней реальной торговли
            без оплаты, ваш депозит и ваш контроль.
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

function renderHowItWorks(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-how" id="how">
      <h2 class="at-section-title">${ico('🛠')}Get started in 4 steps</h2>
      <p class="at-section-sub">
        If you already have a funded Bybit account, all 4 steps take ~10 minutes.
        If not — start with Bybit (see step 3 — that's where the +${BYBIT_REF_BONUS_DAYS}-day auto-trading bonus lives).
      </p>
      <div class="at-how-grid">
        <div class="at-how-step">
          <div class="at-how-num">1</div>
          <div class="at-how-title">Sign up</div>
          <div class="at-how-body">
            Phone number + Telegram bot — takes 30 seconds. No passwords, no email,
            no card check. You're dropped straight into your account.
            <a href="/strategies?from=autotrading">Register now →</a>
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">2</div>
          <div class="at-how-title">Pick a tier</div>
          <div class="at-how-body">
            Look at the <a href="#pricing">pricing table</a> below.
            Decide how much capital you want to allocate (minimum $300). The larger
            the deposit, the more strategies run in parallel and the higher the expected profit.
            <b>Your deposit stays on your Bybit</b> — there is nothing to transfer to us.
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">3</div>
          <div class="at-how-title">Connect Bybit</div>
          <div class="at-how-body">
            If you don't have a Bybit account yet —
            <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">sign up via our link</a>
            and get <b>+${BYBIT_REF_BONUS_DAYS} bonus auto-trading days</b>.
            Then create an API key <b>with trading permission only</b>
            (no withdraw) — there is an illustrated walkthrough in your account,
            with a button that opens the correct Bybit page directly.
          </div>
        </div>
        <div class="at-how-step">
          <div class="at-how-num">4</div>
          <div class="at-how-title">Fund and go</div>
          <div class="at-how-body">
            Transfer USDT to your <b>Unified Trading Account (UTA)</b> on Bybit, sized for the tier
            you picked (minimum $300 for Starter, $800 for Standard, and so on).
            Strategies switch on automatically and <b>start trading on their own</b>.
            Open the dashboard and watch the trades come in.
          </div>
        </div>
      </div>
    </section>
  `;
  }
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
            Переведите USDT на ваш <b>единый торговый счёт</b> на Bybit под выбранный тариф
            (минимум $300 для Starter, $800 для Standard, и т.д.).
            Стратегии включатся автоматически и <b>сама начнут торговать</b>.
            Открывайте кабинет — и просто смотрите, как идут сделки.
          </div>
        </div>
      </div>
    </section>
  `;
}

/**
 * «Как тариф распоряжается вашим депозитом» — Phase O. Operator
 * feedback: visitors looking at the pricing cards couldn't reconcile
 * the wide SLs they saw on /strategies (UNI 30%, TON 25%, HBAR 28%)
 * with the «безопасно» promise. They need a concrete breakdown.
 *
 * For each balance-based tier (Starter / Standard / Plus / Pro / VIP)
 * we render a card with:
 *   - Total margin pool (% of min-balance + USD)
 *   - Per-strategy notional + SL% + max loss in USD AND % of min-depo
 *   - Worst-case-all-stops aggregate at the bottom
 *
 * Prof tier is intentionally excluded — it's user-managed, no fixed
 * sizes to display.
 */
function renderDepositBreakdown(lang: Lang): string {
  const tiers = listTiers().filter((t) => t.id !== 'prof');
  const t = lang === 'en'
    ? {
        title: 'How a tier uses your deposit',
        sub:
          'No magic. Each plan only freezes a fraction of your Bybit balance as «margin pool»; the rest stays untouched. ' +
          'The pool is split between strategies; each opens a tightly-sized position whose worst-case stop loss falls below 2% of your deposit. ' +
          'Below — exact numbers for every plan at the minimum qualifying deposit.',
        step1Title: '1. Deposit → Margin pool',
        step1Body: 'Each plan uses 12–20% of your deposit as a working margin pool. The remaining 80%+ is reserve, untouched, available for trading any time.',
        step2Title: '2. Pool → strategies',
        step2Body: 'The pool is split equally between the strategies in your plan. Each strategy gets the same margin to work with.',
        step3Title: '3. Strategy → trade',
        step3Body: 'Each strategy uses its margin × its safe leverage to derive a notional. Wider SL = lower leverage = smaller trade. Risk per trade stays bounded by SL × notional.',
        colStrat: 'Strategy',
        colSL: 'SL on price',
        colSize: 'Trade size',
        colLeverage: 'Leverage',
        colMaxLoss: 'Max loss per stop',
        colDepoPct: '% of deposit',
        atDepo: 'At minimum deposit',
        marginPool: 'Margin pool',
        perStrat: 'Per strategy',
        allStops: 'If ALL stops fire at once',
        ofDepo: 'of deposit',
        disclaimer: 'Calculations use the minimum qualifying deposit for each plan. With a larger deposit, the percentages drop proportionally.',
      }
    : {
        title: 'Как тариф распоряжается вашим депозитом',
        sub:
          'Никакой магии. Каждый тариф замораживает только часть вашего баланса на Bybit как «рабочий залог»; остальное лежит нетронутым. ' +
          'Залог делится между стратегиями; каждая открывает аккуратно рассчитанную сделку так, чтобы потеря при срабатывании защитного стопа не превышала 2% от депозита. ' +
          'Ниже — точные цифры для каждого пакета при минимальном размере счёта.',
        step1Title: '1. Депозит → рабочий залог',
        step1Body: 'Каждый тариф использует 12–20% депозита как рабочий залог. Остальные 80%+ — резерв, нетронутый, доступен вам в любой момент.',
        step2Title: '2. Залог → стратегии',
        step2Body: 'Залог делится поровну между стратегиями тарифа. Каждая стратегия получает одинаковую сумму под работу.',
        step3Title: '3. Стратегия → сделка',
        step3Body: 'Каждая стратегия умножает свою долю залога на безопасное плечо и получает размер сделки. Шире защитный стоп → меньше плечо → меньше сделка. Потеря на одной сделке всегда ограничена расстоянием стопа × размер сделки.',
        colStrat: 'Стратегия',
        colSL: 'Стоп от цены',
        colSize: 'Размер сделки',
        colLeverage: 'Плечо',
        colMaxLoss: 'Макс. потеря',
        colDepoPct: '% депозита',
        atDepo: 'При минимальном депозите',
        marginPool: 'Рабочий залог',
        perStrat: 'На каждую стратегию',
        allStops: 'Если ВСЕ стопы сработают одновременно',
        ofDepo: 'от депозита',
        disclaimer: 'Все расчёты сделаны на минимальном депозите тарифа. При большем балансе проценты пропорционально снижаются.',
      };

  const tierBlocks = tiers.map((tier) => {
    const minDepo = tier.minBalanceUsdt;
    const poolPctOfDepo = (tier.marginPoolUsd / minDepo) * 100;
    const perStratMargin = tier.marginPoolUsd / tier.strategyIds.length;
    let worstAllStops = 0;
    const rows = tier.strategyIds.map((sid) => {
      const cfg = STRATEGY_CONFIGS[sid];
      const size = computeTierTradeSize(tier.id, sid);
      if (!cfg || !size) {
        return `<tr><td colspan="6" class="at-bd-empty">${escapeHtml(sid)} — нет данных</td></tr>`;
      }
      const maxLoss = cfg.slPct * size.notionalUsd;
      const maxLossPct = (maxLoss / minDepo) * 100;
      worstAllStops += maxLoss;
      const coin = (cfg.symbol ?? 'ANY').replace(/USDT$/, '');
      return `
        <tr>
          <td class="at-bd-strat">
            <b>${escapeHtml(coin)}</b>
            <span class="at-bd-strat-meta">${escapeHtml(cfg.timeframe)}m · STRAT-${escapeHtml(cfg.code)}</span>
          </td>
          <td class="at-bd-num">−${(cfg.slPct * 100).toFixed(1)}%</td>
          <td class="at-bd-num">$${size.notionalUsd.toFixed(0)}</td>
          <td class="at-bd-num at-bd-dim">${size.leverage}×</td>
          <td class="at-bd-num at-bd-loss">−$${maxLoss.toFixed(2)}</td>
          <td class="at-bd-num at-bd-loss">−${maxLossPct.toFixed(2)}%</td>
        </tr>`;
    }).join('');
    const worstAllPct = (worstAllStops / minDepo) * 100;
    return `
      <div class="at-bd-tier">
        <div class="at-bd-tier-head">
          <div class="at-bd-tier-name">${tierEmoji(tier.id)} ${escapeHtml(tier.name)}</div>
          <div class="at-bd-tier-depo">${t.atDepo} <b>$${minDepo.toLocaleString()}</b></div>
        </div>
        <div class="at-bd-tier-stats">
          <div class="at-bd-stat">
            <div class="at-bd-stat-label">${t.marginPool}</div>
            <div class="at-bd-stat-value"><b>$${tier.marginPoolUsd}</b> <span class="at-bd-dim">(${poolPctOfDepo.toFixed(1)}% ${t.ofDepo})</span></div>
          </div>
          <div class="at-bd-stat">
            <div class="at-bd-stat-label">${t.perStrat}</div>
            <div class="at-bd-stat-value"><b>$${perStratMargin.toFixed(0)}</b> <span class="at-bd-dim">× ${tier.strategyIds.length}</span></div>
          </div>
        </div>
        <div class="at-bd-tbl-wrap">
          <table class="at-bd-tbl">
            <thead>
              <tr>
                <th>${t.colStrat}</th>
                <th class="at-bd-num-h">${t.colSL}</th>
                <th class="at-bd-num-h">${t.colSize}</th>
                <th class="at-bd-num-h">${t.colLeverage}</th>
                <th class="at-bd-num-h">${t.colMaxLoss}</th>
                <th class="at-bd-num-h">${t.colDepoPct}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="at-bd-worst">
          <span class="at-bd-worst-label">${t.allStops}:</span>
          <span class="at-bd-worst-value">
            <b>−$${worstAllStops.toFixed(2)}</b>
            <span class="at-bd-dim">= <b>−${worstAllPct.toFixed(2)}%</b> ${t.ofDepo}</span>
          </span>
        </div>
      </div>`;
  }).join('');

  return `
    <section class="at-section at-bd" id="deposit-breakdown">
      <h2 class="at-section-title">${ico('💰')}${t.title}</h2>
      <p class="at-section-sub">${t.sub}</p>

      <div class="at-bd-steps">
        <div class="at-bd-step">
          <div class="at-bd-step-num">1</div>
          <div>
            <div class="at-bd-step-title">${t.step1Title}</div>
            <div class="at-bd-step-body">${t.step1Body}</div>
          </div>
        </div>
        <div class="at-bd-step">
          <div class="at-bd-step-num">2</div>
          <div>
            <div class="at-bd-step-title">${t.step2Title}</div>
            <div class="at-bd-step-body">${t.step2Body}</div>
          </div>
        </div>
        <div class="at-bd-step">
          <div class="at-bd-step-num">3</div>
          <div>
            <div class="at-bd-step-title">${t.step3Title}</div>
            <div class="at-bd-step-body">${t.step3Body}</div>
          </div>
        </div>
      </div>

      <div class="at-bd-carousel-wrap" data-carousel="focus">
        <button class="rc-carousel-arrow rc-carousel-arrow-prev" data-rc-prev aria-label="prev">‹</button>
        <div class="at-bd-tiers rc-carousel-track">${tierBlocks}</div>
        <button class="rc-carousel-arrow rc-carousel-arrow-next" data-rc-next aria-label="next">›</button>
      </div>

      <p class="at-bd-note">${t.disclaimer}</p>
    </section>
  `;
}

function renderSafety(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-safety">
      <h2 class="at-section-title">${ico('🛡')}Not a pyramid, not a fund</h2>
      <p class="at-section-sub">
        The main difference between us and the "magic strategies" or copy-trading pyramids:
        <b>your money stays with you the whole time</b>. We're a software service that places
        orders on your Bybit account via API. Not a bank, not a fund manager, not a fund.
      </p>
      <div class="at-safety-grid">
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('💰')}</div>
          <div class="at-safety-title">Deposit stays on your exchange</div>
          <div class="at-safety-body">
            You don't transfer anything to us. Your deposit sits in <b>your</b> Bybit account.
            A tier on our side is simply a trading configuration for your capital —
            not an investment in our "fund".
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🚫')}</div>
          <div class="at-safety-title">We can't withdraw your funds</div>
          <div class="at-safety-body">
            The API key is created <b>without withdraw or transfer permission</b>.
            Pulling anything from your account is technically impossible —
            Bybit rejects any such request from our side.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🔒')}</div>
          <div class="at-safety-title">Keys are encrypted</div>
          <div class="at-safety-body">
            Keys are encrypted with <b>AES-256-GCM</b> at rest. Once stored, even our own
            server can't read your secret — it can only use it to place orders
            via the Bybit API.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('🤖')}</div>
          <div class="at-safety-title">Trade and stop, nothing else</div>
          <div class="at-safety-body">
            With your key we only do three things: open a position, close a position,
            place a protective stop. Spot, transfers and your profile are
            entirely out of reach.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('⏹')}</div>
          <div class="at-safety-title">Revoke in one click</div>
          <div class="at-safety-body">
            Don't like the results? Disable the key in your dashboard or delete it
            on Bybit. We'll close open positions with a market order before
            shutting down. Your funds remain exactly as they are.
          </div>
        </div>
        <div class="at-safety-card">
          <div class="at-safety-icon">${ico('📊')}</div>
          <div class="at-safety-title">Open statistics</div>
          <div class="at-safety-body">
            Every trade made by our strategies is published live on the site in
            real time. Nothing is hidden, no cherry-picked "winning screenshots".
          </div>
        </div>
      </div>
    </section>
  `;
  }
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
      </div>
    </section>
  `;
}

/**
 * Leverage demystification — отдельная секция для пользователей, которые
 * боятся плеча из-за прошлых неудачных опытов или травмирующего опыта
 * мейнстримных «гуру» которые говорят «плечо = смерть».
 */
function renderLeverageEducation(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-leverage">
      <h2 class="at-section-title">${ico('🛡')}Why liquidation is off the table</h2>
      <p class="at-section-sub">
        A lot of influencers will tell you "leverage equals death". In reality leverage isn't
        dangerous on its own — it's dangerous <b>without risk management</b>. Here are the
        two approaches side by side: the typical one, and ours.
      </p>
      <div class="at-lev-grid">
        <div class="at-lev-bad">
          <div class="at-lev-card-title">${ico('💀')}How most people blow up</div>
          <ol class="at-lev-list">
            <li>Open a position with 20×-50× leverage "because they want it fast"</li>
            <li>Skip the stop-loss "because they believe in the trade"</li>
            <li>Price moves 2-5% against them — the exchange force-closes the position (liquidation)</li>
            <li>The entire margin deposit is gone in minutes</li>
            <li>"Leverage is evil"</li>
          </ol>
        </div>
        <div class="at-lev-good">
          <div class="at-lev-card-title">${ico('🛡')}How we do it</div>
          <ol class="at-lev-list">
            <li><b>Leverage is sized to match the stop-loss</b> of each strategy — set individually per pair</li>
            <li><b>Formula</b>: <code>leverage = floor(0.7 / (slPct + 0.02))</code> — 30% buffer to liquidation</li>
            <li>Example: BCH with a 3.5% SL → 12× leverage (not 50×). BTC with a 4% SL → 11× leverage</li>
            <li>When price moves against the trade our stop-loss fires first (taking a known loss), <b>the exchange never gets to liquidate</b></li>
            <li>Maximum loss per trade — <b>1.5-2.5%</b> of your deposit</li>
          </ol>
        </div>
      </div>
      <div class="at-lev-example">
        <h3 class="at-lev-example-title">Example: a single BCH trade on the Plus tier</h3>
        <div class="at-lev-example-grid">
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Your deposit</div>
            <div class="at-lev-stat-val">$3,000</div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Margin (locked)</div>
            <div class="at-lev-stat-val">$120 <span class="at-lev-pct">(4%)</span></div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Leverage</div>
            <div class="at-lev-stat-val">12×</div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Position size</div>
            <div class="at-lev-stat-val">$1,440</div>
          </div>
          <div class="at-lev-stat at-lev-stat-bad">
            <div class="at-lev-stat-label">Worst-case loss (SL hit)</div>
            <div class="at-lev-stat-val">$50.40 <span class="at-lev-pct">(1.7%)</span></div>
          </div>
          <div class="at-lev-stat at-lev-stat-ok">
            <div class="at-lev-stat-label">Liquidation</div>
            <div class="at-lev-stat-val">${ico('🚫')}Impossible</div>
          </div>
        </div>
        <p class="at-lev-note">
          The stop-loss fires before liquidation can because we kept a 30% buffer between
          it and the exchange's liquidation price. That's not magic — it's plain risk-management
          math.
        </p>
      </div>
    </section>
  `;
  }
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
            <li>Открывают сделку с плечом 20×-50× «потому что хочется быстро»</li>
            <li>Не ставят защитный стоп «потому что верят в идею»</li>
            <li>Цена идёт на 2-5% против — биржа закрывает позицию принудительно (ликвидация)</li>
            <li>Теряют весь залог за минуты</li>
            <li>«Плечо — это зло»</li>
          </ol>
        </div>
        <div class="at-lev-good">
          <div class="at-lev-card-title">${ico('🛡')}Как у нас</div>
          <ol class="at-lev-list">
            <li><b>Плечо подбирается под стоп</b> каждой стратегии индивидуально</li>
            <li>Формула простая: оставляем 30% запас до ликвидационной цены биржи</li>
            <li>Например BCH со стопом 3.5% → плечо 12× (а не 50×). BTC со стопом 4% → плечо 11×</li>
            <li>Если цена идёт против — сначала срабатывает наш защитный стоп (фиксируем известный убыток), <b>биржа не успевает ликвидировать</b></li>
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
            <div class="at-lev-stat-label">Залог (заморозка)</div>
            <div class="at-lev-stat-val">$120 <span class="at-lev-pct">(4%)</span></div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Плечо</div>
            <div class="at-lev-stat-val">12×</div>
          </div>
          <div class="at-lev-stat">
            <div class="at-lev-stat-label">Размер сделки</div>
            <div class="at-lev-stat-val">$1 440</div>
          </div>
          <div class="at-lev-stat at-lev-stat-bad">
            <div class="at-lev-stat-label">Потеря при срабатывании стопа</div>
            <div class="at-lev-stat-val">$50.40 <span class="at-lev-pct">(1.7%)</span></div>
          </div>
          <div class="at-lev-stat at-lev-stat-ok">
            <div class="at-lev-stat-label">Ликвидация</div>
            <div class="at-lev-stat-val">${ico('🚫')}Невозможна</div>
          </div>
        </div>
        <p class="at-lev-note">
          Защитный стоп срабатывает раньше ликвидации, потому что мы оставили 30% запас
          между ним и ликвидационной ценой биржи. Это не магия — это математика
          управления риском.
        </p>
      </div>
    </section>
  `;
}

/**
 * Strategy pipeline — explains how we test new strategies on shadow account
 * before promoting them to user tiers, and how the safety SL works.
 * Two pieces of trust-building information that don't fit the FAQ format.
 */
function renderStrategyPipeline(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-pipeline">
      <h2 class="at-section-title">${ico('🧪')}How we work with strategies</h2>
      <p class="at-section-sub">
        Only strategies that have passed months of validation on our shadow account ever make
        it into a paid tier. We continuously test new candidates in parallel — the best ones
        are added to the portfolios, the weak ones are dropped.
      </p>
      <div class="at-pipeline-grid">
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">1</div>
          <div class="at-pipeline-title">${ico('🔬')}200+ day backtest</div>
          <div class="at-pipeline-body">
            Every new LuxAlgo Strategy Builder candidate is tested against historical data.
            The filter is simple: <b>win-rate ≥ 55%</b>, <b>profit factor ≥ 2</b>,
            <b>drawdown ≤ 30%</b>, at least 100 trades in the sample. Only ~5%
            of candidates pass this gate.
          </div>
        </div>
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">2</div>
          <div class="at-pipeline-title">${ico('👁')}Shadow mode on real money</div>
          <div class="at-pipeline-body">
            Strategies that pass the filter are launched on our own Bybit account.
            <b>This is real money, not a simulator</b> — fees, slippage and overnight funding
            are all included. Every trade is published in our Telegram channel and on the site,
            and each one can be cross-checked by trade ID.
          </div>
        </div>
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">3</div>
          <div class="at-pipeline-title">${ico('🏆')}Only the best make it into a tier</div>
          <div class="at-pipeline-body">
            After 1-3 months of shadow trading we check: does the live PnL match the backtest?
            Are losses staying inside the expected band? If yes — the strategy is added to a
            tier (Starter / Standard / Plus depending on its risk profile). If not — it's
            turned off.
          </div>
        </div>
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">4</div>
          <div class="at-pipeline-title">${ico('🛡')}The safety stop-loss is an insurance line</div>
          <div class="at-pipeline-body">
            Each strategy decides when to exit on its own — that's its internal logic.
            <b>Our safety stop only fires in a failure mode</b> (lost signal, exchange hang).
            It sits <b>above every historical loss the strategy has taken</b>, plus a
            15-30% buffer, so it never interferes with normal operation. Ordinary losses are
            closed by the strategy itself in the 0.5-2% range.
          </div>
        </div>
      </div>
      <div class="at-pipeline-foot">
        <b>What this means for you:</b> the lineup of strategies inside each tier evolves over time.
        When a good new strategy is added it shows up in your portfolio automatically, as long as
        your tier supports it. Pruning weak ones is our job, not yours.
        You can watch the lineup change in the <a href="/strategies">Strategies</a> section.
      </div>
    </section>
  `;
  }
  return `
    <section class="at-section at-pipeline">
      <h2 class="at-section-title">${ico('🧪')}Как мы работаем со стратегиями</h2>
      <p class="at-section-sub">
        В тарифы попадают только те стратегии, которые предварительно прошли
        многомесячную проверку на нашем демо-аккаунте. Параллельно мы постоянно
        тестируем новые — лучшие добавляем в портфели, слабые отбрасываем.
      </p>
      <div class="at-pipeline-grid">
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">1</div>
          <div class="at-pipeline-title">${ico('🔬')}Проверка на 200+ дней истории</div>
          <div class="at-pipeline-body">
            Каждая новая стратегия из LuxAlgo Strategy Builder тестируется на исторических
            данных. Отсев по простым правилам: <b>прибыльных сделок ≥ 55%</b>,
            <b>отношение прибыли к убыткам ≥ 2</b>, <b>просадка не больше 30%</b>,
            минимум 100 сделок в выборке. Только ~5% кандидатов проходят этот фильтр.
          </div>
        </div>
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">2</div>
          <div class="at-pipeline-title">${ico('👁')}Боевая проверка на наших деньгах</div>
          <div class="at-pipeline-body">
            Прошедшие фильтр стратегии запускаются на нашем собственном Bybit-аккаунте.
            <b>Это реальные деньги, не симулятор</b> — комиссия, проскальзывание,
            ночной фондинг учтены. Сделки публичны в Telegram-канале и на сайте,
            каждую можно перепроверить по номеру.
          </div>
        </div>
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">3</div>
          <div class="at-pipeline-title">${ico('🏆')}Только лучшие — в тарифы</div>
          <div class="at-pipeline-body">
            После 1-3 месяцев реальной торговли смотрим: соответствует ли живая доходность
            расчётной? Стабильны ли убытки в допустимом коридоре? Если да —
            стратегия добавляется в тариф (Starter / Standard / Plus в зависимости
            от риск-профиля). Слабые — отключаются.
          </div>
        </div>
        <div class="at-pipeline-step">
          <div class="at-pipeline-num">4</div>
          <div class="at-pipeline-title">${ico('🛡')}Защитный стоп — это страховка</div>
          <div class="at-pipeline-body">
            Каждая стратегия сама знает, когда выходить — это её внутренняя логика.
            <b>Наш защитный стоп срабатывает только в случае сбоя</b> (потеря сигнала,
            зависание биржи). Он выставлен <b>выше всех исторических убытков
            стратегии</b> + запас 15-30%, поэтому в нормальной работе не мешает.
            Обычные убытки стратегия закрывает сама в районе 0.5-2%.
          </div>
        </div>
      </div>
      <div class="at-pipeline-foot">
        <b>Что это значит для вас:</b> состав стратегий в каждом тарифе меняется со временем.
        Когда добавится новая хорошая стратегия — она автоматически появится в вашем портфеле,
        если ваш тариф её поддерживает. Удалить плохую — наша работа, не ваша.
        За изменениями состава можно следить в <a href="/strategies">разделе «Стратегии»</a>.
      </div>
    </section>
  `;
}

function renderPricing(lang: Lang): string {
  const tiers = listTiers();
  const starterPrice = tiers[0]?.monthlyPriceUsd ?? 12;

  const t = lang === 'en'
    ? {
        bonus: 'Bonus',
        freeName: '🆓 Free',
        freeDepo: '$300+ Bybit deposit',
        perMonthDays: `/mo × ${BYBIT_REF_BONUS_DAYS} days`,
        freePitch: `Bonus for new users who sign up to Bybit via our link — ${BYBIT_REF_BONUS_DAYS} days of Starter free, on top of the standard 14-day trial.`,
        feat3Strats: '3 strategies:',
        featConcurrent: 'Concurrent trades:',
        upTo: 'up to',
        featFree: 'Free:',
        featFreeBreakdown: `14-day trial + ${BYBIT_REF_BONUS_DAYS} bonus days = ${14 + BYBIT_REF_BONUS_DAYS} days`,
        featCondition: 'Requirement:',
        featConditionVal: 'new Bybit account via',
        ourLink: 'our link',
        afterBonus: `After that — switch to paid Starter at $${starterPrice}/mo, or cancel in one click.`,
        popular: 'Popular',
        deposit: 'Deposit',
        perMonth: '/mo',
        featProfit: 'Profit:',
        featStrats: 'strategies:',
        featTrial: 'Free:',
        featTrialVal: '14-day trial',
        sectionTitle: 'Pricing and expected returns',
        intro: `Pick the tier yourself based on the deposit you want to allocate to auto-trading. The larger the deposit, the more strategies run in parallel and the higher the expected profit. Subscription cost stays under 18-20% of the expected monthly return. <b>Scroll right</b> to see all tiers →`,
        carouselAria: 'Pricing',
        scrollHint: 'Swipe or scroll sideways to flip through tiers',
        cta: 'Sign up',
        ctaSub: 'After registration — pick a tier, connect Bybit, start trading.',
        disclaimer: `⚠ Return figures are derived from historical backtests. <b>Past results do not guarantee future returns</b>. Crypto trading carries the risk of total capital loss. Robot Claude is a trade-automation service, not a financial advisor. All decisions about deposit size and risk are yours alone.`,
        approx: '~$',
        perMonthShort: '/mo',
        slash: '–',
      }
    : {
        bonus: 'Бонус',
        freeName: '🆓 Free',
        freeDepo: '$300+ депозит на Bybit',
        perMonthDays: `/мес × ${BYBIT_REF_BONUS_DAYS} дней`,
        freePitch: `Бонус для тех, кто регистрирует Bybit по нашей ссылке — ${BYBIT_REF_BONUS_DAYS} дней Starter бесплатно сверх стандартного 14-дневного теста.`,
        feat3Strats: '3 стратегии:',
        featConcurrent: 'Сделок одновременно:',
        upTo: 'до',
        featFree: 'Бесплатно:',
        featFreeBreakdown: `14 дней теста + ${BYBIT_REF_BONUS_DAYS} дней бонуса = ${14 + BYBIT_REF_BONUS_DAYS} дней`,
        featCondition: 'Условие:',
        featConditionVal: 'новый аккаунт Bybit по',
        ourLink: 'нашей ссылке',
        afterBonus: `После — переход на платный Starter $${starterPrice}/мес или отключение в один клик.`,
        popular: 'Популярный',
        deposit: 'Депозит',
        perMonth: '/мес',
        featProfit: 'Заработок:',
        featStrats: 'стратегий:',
        featTrial: 'Бесплатно:',
        featTrialVal: '14 дней теста',
        sectionTitle: 'Тарифы и доходность',
        intro: `Тариф вы выбираете сами по размеру депозита, который готовы выделить под автотрейдинг. Чем больше депозит — тем больше стратегий в работе и тем выше ожидаемая прибыль. Подписка покрывает не больше 18-20% потенциального месячного дохода. <b>Прокрутите вправо</b>, чтобы увидеть все тарифы →`,
        carouselAria: 'Тарифы',
        scrollHint: 'Свайпните или прокрутите вбок чтобы листать тарифы',
        cta: 'Зарегистрироваться',
        ctaSub: 'После регистрации — выберете тариф, подключите Bybit, начнёте торговать.',
        disclaimer: `⚠ Цифры доходности рассчитаны по историческим данным бэктестов. <b>Прошлые результаты не гарантируют будущих</b>. Криптотрейдинг сопряжён с риском полной потери капитала. Robot Claude — сервис автоматизации сделок, не финансовый консультант. Все решения о размере депозита и риске вы принимаете самостоятельно.`,
        approx: '~$',
        perMonthShort: '/мес',
        slash: '–',
      };

  // Virtual Free card — not in TIER_CONFIGS. Conditional on Bybit referral signup.
  const freeCard = `
    <div class="at-tier-card at-tier-free">
      <div class="at-tier-badge">${ico('🎁')}${t.bonus}</div>
      <div class="at-tier-name">${t.freeName}</div>
      <div class="at-tier-depo">${t.freeDepo}</div>
      <div class="at-tier-price">
        <span class="at-tier-price-num">$0</span>
        <span class="at-tier-price-period">${t.perMonthDays}</span>
      </div>
      <p class="at-tier-pitch-top">${t.freePitch}</p>
      <ul class="at-tier-features">
        <li><span class="at-tier-feat-icon">🎯</span><span class="at-tier-feat-label">${t.feat3Strats}</span> BTC, BNB, BCH</li>
        <li><span class="at-tier-feat-icon">⚡</span><span class="at-tier-feat-label">${t.featConcurrent}</span> ${t.upTo} 2</li>
        <li><span class="at-tier-feat-icon">💎</span><span class="at-tier-feat-label">${t.featFree}</span> ${t.featFreeBreakdown}</li>
        <li><span class="at-tier-feat-icon">🎁</span><span class="at-tier-feat-label">${t.featCondition}</span> ${t.featConditionVal} <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">${t.ourLink}</a></li>
      </ul>
      <div class="at-tier-after-bonus">${t.afterBonus}</div>
    </div>
  `;

  const cards = tiers
    .map((tier, i) => {
      const isPopular = tier.id === 'standard';
      const maxStr = tier.maxBalanceUsdt === Number.POSITIVE_INFINITY ? '∞' : `$${tier.maxBalanceUsdt.toLocaleString()}`;
      // Phase N — marketing numbers derived from backtests; auto-updates
      // whenever a strategy is added/removed/re-backtested without manual
      // edits to tier-config.ts (with fallback to hardcoded ranges).
      const mkt = getTierMarketingNumbers(tier.id);
      const sub = { low: mkt.rangeLow, high: mkt.rangeHigh };
      const coins = tierCoinTickers(tier.id);
      const coinsStr = coins.length > 0 ? coins.join(', ') : '—';
      const badge = isPopular ? `<div class="at-tier-badge at-tier-badge-popular">${ico('⭐')}${t.popular}</div>` : '';
      // Tier `pitch` is RU-only in tier-config; for EN we still render it (untranslated)
      // because most tier pitches are coin names + numbers anyway and translation would
      // be its own task. For now we keep the source string.
      return `
        <div class="at-tier-card ${isPopular ? 'at-tier-popular' : ''}" data-tier-index="${i + 1}">
          ${badge}
          <div class="at-tier-name">${tierEmoji(tier.id)} ${escapeHtml(tier.name)}</div>
          <div class="at-tier-depo">${t.deposit} $${tier.minBalanceUsdt.toLocaleString()}${t.slash}${maxStr}</div>
          <div class="at-tier-price">
            <span class="at-tier-price-num">$${tier.monthlyPriceUsd}</span>
            <span class="at-tier-price-period">${t.perMonth}</span>
          </div>
          <p class="at-tier-pitch-top">${escapeHtml(tier.pitch)}</p>
          <ul class="at-tier-features">
            <li><span class="at-tier-feat-icon">💰</span><span class="at-tier-feat-label">${t.featProfit}</span> ${t.approx}${sub.low}${t.slash}$${sub.high}${t.perMonthShort}</li>
            <li><span class="at-tier-feat-icon">🎯</span><span class="at-tier-feat-label">${tier.strategyIds.length} ${t.featStrats}</span> ${escapeHtml(coinsStr)}</li>
            <li><span class="at-tier-feat-icon">⚡</span><span class="at-tier-feat-label">${t.featConcurrent}</span> ${t.upTo} ${tier.maxConcurrentPositions}</li>
            <li><span class="at-tier-feat-icon">💎</span><span class="at-tier-feat-label">${t.featTrial}</span> ${t.featTrialVal}</li>
          </ul>
        </div>
      `;
    })
    .join('');

  return `
    <section class="at-section at-pricing" id="pricing">
      <h2 class="at-section-title">${ico('💳')}${t.sectionTitle}</h2>
      <p class="at-pricing-intro">${t.intro}</p>
      <div class="at-tier-carousel-wrap" data-carousel="focus">
        <button class="rc-carousel-arrow rc-carousel-arrow-prev" data-rc-prev aria-label="prev">‹</button>
        <div class="at-tier-carousel rc-carousel-track" role="region" aria-label="${t.carouselAria}">
          ${freeCard}
          ${cards}
        </div>
        <button class="rc-carousel-arrow rc-carousel-arrow-next" data-rc-next aria-label="next">›</button>
      </div>
      <div class="at-tier-scroll-hint">
        ${ico('👆')}${t.scrollHint}
      </div>
      <div class="at-pricing-cta">
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}${t.cta}</a>
        <div class="at-pricing-cta-sub">${t.ctaSub}</div>
      </div>
      <div class="at-price-disclaimer">${t.disclaimer}</div>
    </section>
  `;
}

function tierEmoji(id: 'starter' | 'standard' | 'plus' | 'pro' | 'vip' | 'prof'): string {
  switch (id) {
    case 'starter': return '🥉';
    case 'standard': return '🥈';
    case 'plus': return '🥇';
    case 'pro': return '🏆';
    case 'vip': return '👑';
    case 'prof': return '💼';
  }
}

/** FAQ items — exposed at module scope so SEO can emit a FAQPage JSON-LD
 *  graph mirroring exactly what appears in the visible accordion. */
const FAQ_ITEMS_RU: Array<{ q: string; a: string }> = [
    {
      q: 'Чем вы отличаетесь от копитрейдинг-пирамид и «волшебных» сервисов?',
      a: 'Главное: ваши деньги остаются на вашем Bybit-аккаунте. Мы их не принимаем, не управляем фондом, не обещаем фиксированную доходность. Наш сервис — это софт, который выставляет торговые ордера на вашем счёте по проверенным стратегиям. Технически невозможно вывести что-то с вашего счёта в нашу сторону: ключ создаётся без права на вывод и переводы.',
    },
    {
      q: 'Как назначается тариф? Я могу выбрать сам?',
      a: 'Тариф выбираете вы сами при подключении Bybit-аккаунта. Мы только проверяем, что ваш баланс достаточен для выбранного тарифа: $300+ для Starter, $800+ для Standard, $2 500+ для Plus и т.д. Если выбрали Plus, а на счёте $500 — попросим пополнить или выбрать тариф попроще. Если депозит вырастет — подскажем перейти на тариф выше с пересчётом подписки. Если депозит сильно упадёт — автоматически переключим на меньший тариф через 72 часа, открытые позиции не трогаются.',
    },
    {
      q: 'Сколько дней автотрейдинга бесплатно?',
      a: `Каждый новый пользователь получает <b>14 дней тестового периода</b> на любом тарифе — подключаете Bybit, торговля идёт как обычно, подписка не списывается. Это позволяет посмотреть на реальный результат до оплаты. <br/><br/><b>+${BYBIT_REF_BONUS_DAYS} дней бонусом</b>, если зарегистрируете новый аккаунт на Bybit по нашей ссылке (кнопка «Открыть Bybit» на этой странице). Итого до <b>${14 + BYBIT_REF_BONUS_DAYS} дней</b> автотрейдинга без оплаты. После — стандартная подписка по выбранному тарифу или отключение в один клик.`,
    },
    {
      q: 'Сколько денег нужно для начала?',
      a: 'Минимум $300 USDT на единый торговый счёт Bybit. Ниже этой суммы автотрейдинг не запускается — это экономически невыгодно ни вам, ни нам (даже подписка съест значимую часть ожидаемой прибыли).',
    },
    {
      q: 'Что такое плечо и не опасно ли это?',
      a: 'Плечо — это инструмент, который позволяет открыть сделку больше, чем у вас заморожено в залоге. Опасно его использовать БЕЗ управления риском. У нас плечо подобрано автоматически под защитный стоп каждой стратегии так, чтобы СНАЧАЛА срабатывал наш стоп (фиксированный убыток 1-3% депозита), а не ликвидация биржи. Ваш максимальный убыток на одной сделке известен заранее. Подробнее в секциях «Безопасное плечо» и «Почему ликвидация исключена» выше.',
    },
    {
      q: 'Зачем тогда плечо если оно опасно?',
      a: 'Без плеча торговать криптофьючерсами в режиме автотрейдинга экономически бессмысленно: на депозите $1 000 при размере сделки $200 ожидаемая прибыль ~$2.7/мес — меньше подписки. С плечом 12× (безопасно подобранным под наш стоп) тот же депозит торгует размером $2 400, и ожидаемая прибыль становится ~$32/мес. Главное — защитный стоп срабатывает раньше ликвидации, поэтому максимальный убыток в сделке известен заранее. Это математика, а не казино.',
    },
    {
      q: 'Какие биржи поддерживаются? Будут ли другие?',
      a: 'Сейчас только Bybit (бессрочные фьючерсы за USDT) — выбрали потому что хорошая ликвидность, низкие комиссии (0.055% за сделку) и удобный программный интерфейс. На очереди: <b>BingX</b> (для рынков где Bybit недоступен по гео — Q3 2026), затем <b>Hyperliquid</b> (для пользователей которые предпочитают торговлю без верификации личности — Q4 2026). Когда добавим — вы сможете в кабинете переключить биржу для автотрейдинга без перерегистрации.',
    },
    {
      q: 'Что если стратегия в минусе?',
      a: 'Каждая стратегия имеет защитный стоп. Просадки бывают — это нормально для любой торговой системы. У тарифа есть обещание максимальной просадки (Starter ≤8%, Standard ≤15%, Plus/Pro/VIP ≤18%). Если просадка превышает обещанное — мы пересматриваем тариф или исключаем стратегию.',
    },
    {
      q: 'Можно ли вручную закрыть позицию или поторговать самому?',
      a: 'Да, в любой момент через интерфейс Bybit. Наша система не противодействует — она увидит закрытие при следующей сверке (раз в минуту) и пометит сделку завершённой в вашей истории. Можете торговать параллельно на том же аккаунте — мы трогаем только позиции которые открывала наша система.',
    },
    {
      q: 'Как остановить торговлю?',
      a: 'В личном кабинете внизу страницы — большая красная кнопка <b>«🛑 Остановить и закрыть сделки»</b>. По нажатию мы немедленно закрываем все ваши открытые сделки на Bybit по рыночной цене и больше не открываем новые. Депозит остаётся на вашем счёте — мы его не трогаем. В любой момент можно нажать «▶ Возобновить торговлю» и автотрейдинг продолжится по выбранному тарифу. Для полного отключения от системы — отзовите API-ключ в /account/api-key.',
    },
    {
      q: 'Прошлая доходность гарантирует будущую?',
      a: 'Нет. Все цифры на сайте — это историческая проверка на прошлых данных и реальная статистика наших стратегий. Рынок меняется, любая стратегия может перестать работать. Криптотрейдинг сопряжён с риском полной потери капитала. Не торгуйте больше, чем готовы потерять.',
    },
  {
    q: 'Как происходит оплата?',
    a: `Первые <b>14 дней</b> — тестовый период на любом тарифе, подписка не списывается. Если вы зарегистрировали Bybit по нашей ссылке — добавляются ещё <b>${BYBIT_REF_BONUS_DAYS} дней</b> бонуса (итого до ${14 + BYBIT_REF_BONUS_DAYS} дней без оплаты). После окончания бесплатного периода связываемся с вами в Telegram для оплаты подписки. Никаких автосписаний с карты — оплата ручная через оператора, вы сами решаете продлевать или нет.`,
  },
];

const FAQ_ITEMS_EN: Array<{ q: string; a: string }> = [
  {
    q: 'How are you different from copy-trading pyramids and "magic" services?',
    a: 'The key point: your money stays in your own Bybit account. We don\'t accept deposits, we don\'t run a fund, we don\'t promise a fixed return. Our service is software that places trading orders on your account using vetted strategies. Pulling anything from your account to ours is technically impossible — the API key is created without withdraw or transfer permission.',
  },
  {
    q: 'How is my tier assigned? Can I pick it myself?',
    a: 'You pick the tier yourself when you connect your Bybit account. All we do is check that your balance is enough for the selected tier: $300+ for Starter, $800+ for Standard, $2,500+ for Plus and so on. If you picked Plus with only $500 on the account, we\'ll ask you to top up or choose a smaller tier. If your deposit grows we\'ll suggest moving up with a pro-rated subscription. If the deposit drops significantly we\'ll switch you down to a smaller tier automatically after 72 hours — open positions are not touched.',
  },
  {
    q: 'How many days of auto-trading do I get for free?',
    a: `Every new user gets a <b>14-day trial</b> on any tier — connect Bybit, trading runs as usual, no subscription is charged. That lets you see real results before paying. <br/><br/><b>+${BYBIT_REF_BONUS_DAYS} bonus days</b> if you sign up to Bybit via our link (the "Open Bybit" button on this page). Up to <b>${14 + BYBIT_REF_BONUS_DAYS} days</b> of auto-trading with no payment. After that — standard subscription on your chosen tier, or cancel in one click.`,
  },
  {
    q: 'How much money do I need to start?',
    a: 'A minimum of $300 USDT on the Bybit Unified Trading Account (UTA). Below that we won\'t start auto-trading — it doesn\'t make economic sense for you or for us (even the subscription would eat a meaningful share of the expected profit).',
  },
  {
    q: 'What is leverage and isn\'t it dangerous?',
    a: 'Leverage is a tool that lets you open a position larger than the margin you have locked. It IS dangerous to use without risk management. On our side leverage is matched to each strategy\'s stop-loss so that OUR stop fires first (a known 1-3% deposit loss) — never the exchange\'s liquidation. Your maximum loss per trade is known in advance. See the "Safe leverage" and "Why liquidation is off the table" sections above for the details.',
  },
  {
    q: 'Then why use leverage at all if it\'s dangerous?',
    a: 'Auto-trading crypto futures without leverage is economically pointless: on a $1,000 deposit with a $200 position the expected profit is ~$2.7/mo — less than the subscription. With 12× leverage (safely sized to our SL) the same deposit trades $2,400 of size, and the expected profit becomes ~$32/mo. The key is that the stop-loss fires before liquidation, so the worst-case per-trade loss is known in advance. This is math, not a casino.',
  },
  {
    q: 'Which exchanges are supported? Will there be more?',
    a: 'Today only Bybit USDT-perp futures — picked for its strong liquidity, low fees (0.055% taker), and a clean API. Next up: <b>BingX</b> (CEX, for markets where Bybit isn\'t available by geo — Q3 2026), then <b>Hyperliquid</b> (DEX-perp, for users who want to skip KYC and stay on-chain — Q4 2026). When they\'re added you\'ll be able to switch the "auto-trading exchange" right from your account, no re-registration.',
  },
  {
    q: 'What if a strategy goes into the red?',
    a: 'Every strategy has a protective stop-loss. Drawdowns happen — that\'s normal for any trading system. Each tier comes with a max-drawdown commitment (Starter ≤8%, Standard ≤15%, Plus/Pro/VIP ≤18%). If the drawdown exceeds what we promised, we revisit the tier or remove the strategy.',
  },
  {
    q: 'Can I close a position manually or trade on my own?',
    a: 'Yes, at any time through Bybit\'s interface. Our system doesn\'t fight back — it sees the close on the next reconciliation (once a minute) and marks the trade as completed in your history. You can trade in parallel on the same account — we only touch the positions our system opened.',
  },
  {
    q: 'How do I stop trading?',
    a: 'In your account, at the bottom of the page, there\'s a big red <b>"🛑 Stop and close trades"</b> button. Press it and we immediately close all your open trades on Bybit at market price and stop opening new ones. Your deposit stays on your account — we don\'t touch it. You can press "▶ Resume trading" any time and auto-trading continues on your chosen tier. To disconnect from the system entirely, revoke the API key at /account/api-key.',
  },
  {
    q: 'Do past returns guarantee future ones?',
    a: 'No. Every number on the site comes from historical backtests and the live statistics of our strategies. Markets change, any strategy can stop working. Crypto trading carries the risk of total capital loss. Never trade more than you are prepared to lose.',
  },
  {
    q: 'How does payment work?',
    a: `The first <b>14 days</b> are a trial on any tier — no subscription charge. If you signed up to Bybit via our link, another <b>${BYBIT_REF_BONUS_DAYS} bonus days</b> are added (up to ${14 + BYBIT_REF_BONUS_DAYS} days free in total). Once the free period ends we reach out on Telegram to take the subscription payment. No automatic card charges — payments are processed manually by the operator, and you decide whether to renew.`,
  },
];

function renderFaq(lang: Lang): string {
  const items = lang === 'en' ? FAQ_ITEMS_EN : FAQ_ITEMS_RU;
  const title = lang === 'en' ? 'Frequently asked questions' : 'Частые вопросы';
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
      <h2 class="at-section-title">${ico('❓')}${title}</h2>
      <div class="at-faq-list">${html}</div>
    </section>
  `;
}

function renderFinalCta(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-cta-final">
      <h2 class="at-cta-title">Ready to switch on passive income?</h2>
      <p class="at-cta-sub">
        Registration takes 30 seconds. No card required. Cancel in one click.
        Your capital stays on Bybit, under your control.
        14-day trial free on any tier + another ${BYBIT_REF_BONUS_DAYS} bonus days if you sign up to Bybit via <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">our link</a>.
      </p>
      <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">Sign up</a>
      <p class="at-cta-login">
        Already registered? <a href="/strategies?login=1">Sign in →</a>
      </p>
      <p class="at-cta-help">
        Questions? Message the operator: <a href="${SUPPORT_TG}" target="_blank" rel="noopener">@dboykod</a>
      </p>
    </section>
  `;
  }
  return `
    <section class="at-section at-cta-final">
      <h2 class="at-cta-title">Готовы запустить пассивный доход?</h2>
      <p class="at-cta-sub">
        Регистрация — 30 секунд. Без привязки карты. Отмена в один клик.
        Ваш капитал остаётся на Bybit под вашим контролем.
        14 дней теста бесплатно на любом тарифе + ещё ${BYBIT_REF_BONUS_DAYS} дней бонусом если зарегистрируетесь на Bybit по <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">нашей ссылке</a>.
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
  /* Free-trial accent right under the CTA buttons. Soft gold halo so
     it reads as a «bonus / gift» without competing with the green
     primary CTA above. */
  .at-hero-trial {
    display: inline-flex; align-items: center; gap: 4px;
    margin: 14px auto 4px;
    padding: 10px 18px; border-radius: 999px;
    background: linear-gradient(90deg, rgba(243,210,102,0.08), rgba(243,210,102,0.16), rgba(243,210,102,0.08));
    border: 1px solid rgba(243,210,102,0.40);
    color: #f5d970;
    font-size: 14px;
    box-shadow: 0 6px 20px -10px rgba(243, 210, 102, 0.45);
  }
  .at-hero-trial b { color: #fff; font-weight: 700; }
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
    gap: 24px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    /* Side-padding equals (viewport-half − card-half), so first and last
       card can scroll-snap into the centre. Clamped to 20px minimum so
       there's always breathing room from the section edge. */
    padding: 28px max(20px, calc(50% - 200px)) 16px;
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
    border: 1px solid #1f2630; border-radius: 16px;
    padding: 32px 24px 24px;
    display: flex; flex-direction: column;
    position: relative;
    /* Bigger cards now that focus mode shows one at a time. 380px lets
       all features breathe; on mobile we keep 86vw so swipe feels natural. */
    flex: 0 0 380px;
    min-width: 0;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  /* Cards with a badge need extra top padding to clear it. Without this
   * the «🎁 Бонус» / «⭐ Популярный» pill overlaps the tier name below. */
  .at-tier-card.at-tier-popular,
  .at-tier-card.at-tier-free {
    padding-top: 46px;
  }
  /* Active card lifts more, others fade harder in focus mode. */
  [data-carousel="focus"] .at-tier-card.rc-card-active {
    box-shadow: 0 14px 40px rgba(0,0,0,0.45);
  }
  @media (max-width: 640px) {
    .at-tier-card { flex: 0 0 86vw; }
    .at-tier-carousel { padding-left: 7vw; padding-right: 7vw; }
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
    /* Badge sits inside the card padding (top: 10px) so the carousel
     * overflow-x doesn't clip it. Cards with a badge get extra padding-top
     * (.at-tier-popular / .at-tier-free) to reserve room — see above. */
    position: absolute; top: 10px; left: 14px;
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
  .at-tier-pitch-top {
    font-size: 12.5px; color: #cfd6dd; line-height: 1.55;
    margin: 0 0 12px; padding-bottom: 10px;
    border-bottom: 1px dashed #1a1f27;
  }
  .at-tier-features {
    list-style: none; padding: 0; margin: 0 0 12px 0;
    font-size: 12.5px; color: #cfd6dd; line-height: 1.5;
    flex: 1;
  }
  .at-tier-features li {
    padding: 6px 0; display: flex; align-items: flex-start; gap: 6px;
  }
  .at-tier-feat-icon { flex-shrink: 0; font-size: 13px; line-height: 1.5; }
  .at-tier-feat-label { color: #8590a0; }
  .at-tier-features a {
    color: #4ad991; text-decoration: none;
  }
  .at-tier-features a:hover { text-decoration: underline; }
  .at-tier-after-bonus {
    font-size: 11.5px; color: #8590a0; line-height: 1.5;
    margin-top: auto; padding-top: 10px; border-top: 1px solid #1a1f27;
  }
  /* Legacy pitch class kept in case other layouts still use it. */
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
  /* Worked example grid — 6 stat cards. Explicit breakpoints avoid 4+2
   * shuffle around 760px. Desktop=3 columns × 2 rows, tablet=2×3, mobile=1×6. */
  .at-lev-example-grid {
    display: grid; gap: 14px; margin-bottom: 16px;
    grid-template-columns: repeat(3, 1fr);
  }
  @media (max-width: 720px) {
    .at-lev-example-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 480px) {
    .at-lev-example-grid { grid-template-columns: 1fr; }
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

  /* ----- Strategy Pipeline (Phase I) ----- */
  .at-pipeline { margin: 60px auto; }
  .at-pipeline-grid {
    display: grid; gap: 18px;
    grid-template-columns: repeat(2, 1fr);
  }
  @media (max-width: 720px) {
    .at-pipeline-grid { grid-template-columns: 1fr; }
  }
  .at-pipeline-step {
    background: #11161d; border: 1px solid #1f2630; border-radius: 14px;
    padding: 22px 24px; position: relative;
  }
  .at-pipeline-num {
    position: absolute; top: -12px; left: 22px;
    width: 28px; height: 28px; border-radius: 50%;
    background: #4ad991; color: #0b0e13; font-weight: 700; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
  }
  .at-pipeline-title {
    font-size: 15px; font-weight: 600; color: #e8edf2; margin-bottom: 10px; margin-top: 4px;
  }
  .at-pipeline-body {
    font-size: 13px; color: #9aa5b1; line-height: 1.6;
  }
  .at-pipeline-body b { color: #cfd6dd; }
  .at-pipeline-foot {
    margin-top: 18px; padding: 16px 20px;
    background: rgba(74, 217, 145, 0.06);
    border: 1px solid rgba(74, 217, 145, 0.30);
    border-radius: 12px;
    font-size: 13px; color: #cfd6dd; line-height: 1.6;
  }
  .at-pipeline-foot b { color: #4ad991; }
  .at-pipeline-foot a { color: #4ad991; text-decoration: none; }
  .at-pipeline-foot a:hover { text-decoration: underline; }

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

  /* ---------- Deposit breakdown section (Phase O) ---------- */
  .at-bd {}
  .at-bd-steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin: 24px 0 28px;
  }
  .at-bd-step {
    display: flex; gap: 14px; align-items: flex-start;
    background: #11161d; border: 1px solid #1f2630;
    border-radius: 10px; padding: 16px;
  }
  .at-bd-step-num {
    width: 32px; height: 32px;
    background: rgba(74, 217, 145, 0.14);
    color: #4ad991;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px;
    flex-shrink: 0;
  }
  .at-bd-step-title {
    font-size: 13.5px; font-weight: 600; color: #e8edf2;
    margin-bottom: 4px;
  }
  .at-bd-step-body {
    font-size: 12.5px; color: #98a2b3; line-height: 1.5;
  }
  /* Deposit-breakdown carousel — focus mode (one tier centred, others
     dimmed). Padding on the track lets first and last cards reach the
     centre of the viewport on scroll-snap. */
  .at-bd-carousel-wrap {
    position: relative;
    margin: 0 -4px 18px;
    /* Extra vertical room so scale(0.88) on side cards doesn't clip. */
    padding: 8px 0 14px;
  }
  .at-bd-tiers {
    display: flex; gap: 24px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    /* Center-padding equal to half the gap between viewport edge and
       the centred card so first/last snap to centre, not edge. */
    padding: 4px max(20px, calc(50% - 290px)) 14px;
    scrollbar-color: #2a323d transparent;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }
  .at-bd-tiers::-webkit-scrollbar { height: 8px; }
  .at-bd-tiers::-webkit-scrollbar-track { background: transparent; }
  .at-bd-tiers::-webkit-scrollbar-thumb { background: #2a323d; border-radius: 4px; }
  .at-bd-tier {
    background: linear-gradient(180deg, #161c25 0%, #11161d 70%);
    border: 1px solid #1f2630;
    border-radius: 14px;
    padding: 22px 24px;
    /* One card per view + a peek of the next so visitor sees "there
       is more". 560px desktop, 86vw mobile. */
    flex: 0 0 min(560px, 86vw);
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  /* Active card pops harder via the box-shadow + border accent. */
  [data-carousel="focus"] .at-bd-tier.rc-card-active {
    border-color: rgba(74, 217, 145, 0.35);
    box-shadow: 0 12px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(74,217,145,0.18);
  }
  .at-bd-tier-head {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 12px; flex-wrap: wrap; gap: 8px;
  }
  .at-bd-tier-name {
    font-size: 18px; font-weight: 700; color: #fff;
  }
  .at-bd-tier-depo {
    font-size: 12.5px; color: #98a2b3;
  }
  .at-bd-tier-depo b { color: #e8edf2; font-weight: 600; }
  .at-bd-tier-stats {
    display: flex; gap: 24px; margin-bottom: 14px;
    padding: 10px 12px; background: #0e131a;
    border-radius: 8px; flex-wrap: wrap;
  }
  .at-bd-stat-label {
    font-size: 10.5px; color: #6b7480;
    text-transform: uppercase; letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
  .at-bd-stat-value {
    font-size: 14px; color: #e8edf2;
    font-family: ui-monospace, Menlo, monospace;
  }
  .at-bd-stat-value b { color: #fff; font-weight: 600; }
  .at-bd-dim { color: #8590a0; font-weight: 400; }
  .at-bd-tbl-wrap { overflow-x: auto; }
  .at-bd-tbl {
    width: 100%; border-collapse: collapse;
    font-size: 13px; color: #e8edf2;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .at-bd-tbl th {
    text-align: left; padding: 8px 10px;
    font-size: 10.5px; color: #6b7480;
    text-transform: uppercase; letter-spacing: 0.05em;
    font-weight: 600;
    border-bottom: 1px solid #1f2630;
  }
  .at-bd-tbl td {
    padding: 9px 10px; border-bottom: 1px solid #1a1f27;
  }
  .at-bd-tbl tr:last-child td { border-bottom: none; }
  .at-bd-num, .at-bd-num-h {
    text-align: right;
    font-family: ui-monospace, Menlo, monospace;
  }
  .at-bd-strat b { color: #fff; font-weight: 600; font-size: 13.5px; }
  .at-bd-strat-meta {
    display: block; font-size: 10.5px; color: #6b7480;
    margin-top: 2px;
  }
  .at-bd-loss { color: #ff8b8b; font-weight: 600; }
  .at-bd-empty { color: #6b7480; font-style: italic; text-align: center; }
  .at-bd-worst {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 8px;
    margin-top: 14px; padding: 12px 14px;
    background: rgba(255, 188, 70, 0.08);
    border: 1px solid rgba(255, 188, 70, 0.30);
    border-radius: 8px;
  }
  .at-bd-worst-label {
    font-size: 12.5px; color: #ffbc46; font-weight: 600;
  }
  .at-bd-worst-value {
    font-size: 14.5px; color: #ff8b8b; font-weight: 600;
    font-family: ui-monospace, Menlo, monospace;
  }
  .at-bd-worst-value b { color: #ffc16b; font-weight: 700; }
  .at-bd-note {
    font-size: 12px; color: #8590a0; text-align: center;
    margin-top: 18px; line-height: 1.5;
  }

  @media (max-width: 720px) {
    .at-bd-steps { grid-template-columns: 1fr; }
    .at-bd-tier-name { font-size: 16px; }
    .at-bd-tier-stats { gap: 14px; }
  }

  /* ---------- Forecast table (Phase O) — sits right after pricing ---------- */
  .at-forecast {}
  .at-fc-tbl-wrap {
    overflow-x: auto;
    margin: 22px 0 14px;
    border: 1px solid #1f2630;
    border-radius: 14px;
    background: #11161d;
  }
  .at-fc-tbl {
    width: 100%; border-collapse: collapse;
    font-family: ui-sans-serif, system-ui, sans-serif;
    color: #e8edf2;
    min-width: 720px;
  }
  .at-fc-tbl thead { background: #0e131a; }
  .at-fc-tbl th {
    text-align: left; padding: 14px 16px;
    font-size: 11px; color: #6b7480;
    text-transform: uppercase; letter-spacing: 0.06em;
    font-weight: 600;
    border-bottom: 1px solid #1f2630;
  }
  .at-fc-tbl td {
    padding: 16px;
    border-bottom: 1px solid #1a1f27;
    vertical-align: middle;
  }
  .at-fc-tbl tr:last-child td { border-bottom: none; }
  .at-fc-tbl tr.at-fc-popular {
    background: rgba(74, 217, 145, 0.04);
  }
  .at-fc-tbl tr.at-fc-popular td {
    border-bottom-color: rgba(74, 217, 145, 0.18);
  }
  .at-fc-num, .at-fc-num-h {
    text-align: right;
    font-family: ui-monospace, Menlo, monospace;
  }
  .at-fc-tier-cell { white-space: nowrap; }
  .at-fc-tier-name {
    font-size: 16px; font-weight: 700; color: #fff;
  }
  .at-fc-tier-pop {
    margin-top: 4px; font-size: 10.5px;
    color: #4ad991; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .at-fc-profit-mo, .at-fc-pct-mo {
    font-size: 17px; line-height: 1.2;
    color: #4ad991;
  }
  .at-fc-profit-mo b, .at-fc-pct-mo b { font-weight: 700; }
  .at-fc-profit-yr, .at-fc-pct-yr {
    font-size: 11px; color: #8590a0;
    margin-top: 3px;
  }
  .at-fc-trades { font-size: 15px; }
  .at-fc-trades-sub {
    font-size: 10.5px; color: #6b7480;
    margin-top: 2px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    text-transform: lowercase;
  }
  .at-fc-note {
    font-size: 12px; color: #8590a0;
    text-align: center; max-width: 720px;
    margin: 14px auto 0; line-height: 1.55;
  }
  @media (max-width: 720px) {
    .at-fc-profit-mo, .at-fc-pct-mo { font-size: 15px; }
  }

  /* Carousel arrows + edge fade — defined globally in pageShell so every
     page gets them. See src/strategies/landing.ts → CAROUSEL_BLOCK. */
</style>
`;
}

export async function autotradingRoute(app: FastifyInstance): Promise<void> {
  app.get('/autotrading', async (req, reply) => {
    const lang = getLang(req);
    reply.header('content-type', 'text/html; charset=utf-8');
    // Vary on Cookie: the page content differs by `rclang` cookie, and any
    // upstream cache (CDN, browser) must keep one variant per cookie value
    // — otherwise an EN visitor could get an RU-cached page or vice versa.
    reply.header('vary', 'Cookie');
    const u = getAuthedUser(req);
    const authed = u ? { displayName: u.displayName, phone: u.phone } : null;
    return reply.send(renderPage(lang, authed));
  });
}

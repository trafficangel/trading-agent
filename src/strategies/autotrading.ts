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
import {
  listTiers,
  tierCoinTickers,
  getTierMarketingNumbers,
  computeTierTradeSize,
  MIN_AUTOTRADING_DEPOSIT_USDT,
} from './tier-config.js';

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
      ${renderHowItWorks(lang)}
      ${renderWalkthroughVideo(lang)}
      ${renderForecastTable(lang)}
      ${renderSafety(lang)}
      ${renderCalculator(lang)}
      ${renderPricing(lang)}
      ${renderBybitBonus(lang)}
      ${renderComparison(lang)}
      ${renderDepositBreakdown(lang)}
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
      ${renderTelegramCapture(lang)}
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
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}Start free</a>
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
        <a href="/strategies?from=autotrading" class="at-btn-primary at-btn-large">${ico('🚀')}Начать бесплатно</a>
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

/**
 * Comparison section — answers «зачем мне это, если я уже...» (objection
 * handler). Visitors typically arrive comparing us to one of: manual
 * trading, paid signals, copytrading services, or a managed crypto fund.
 * We put all four side-by-side and show why auto-trading on your own
 * account wins on every single dimension.
 *
 * Cognitive trigger: anchoring + loss aversion. By making the visitor
 * notice the explicit downsides of alternatives, the «no card / no
 * deposit / your money / cancel anytime» of our offer reads as obvious.
 */
function renderComparison(lang: Lang): string {
  const t = lang === 'en'
    ? {
        title: 'How does it compare to the alternatives?',
        sub: 'You probably already trade crypto in one of these ways. Here\'s honestly how Robot Claude stacks up.',
        rows: [
          { feat: 'Money stays on your exchange',  manual: 'yes',  signals: 'yes',  copy: 'no',  fund: 'no',  rc: 'yes' },
          { feat: '24/7 — no manual screen time',  manual: 'no',   signals: 'no',   copy: 'yes', fund: 'yes', rc: 'yes' },
          { feat: 'No emotion / FOMO',             manual: 'no',   signals: 'no',   copy: 'yes', fund: 'yes', rc: 'yes' },
          { feat: 'Verifiable historical results', manual: 'no',   signals: 'rare', copy: 'rare',fund: 'rare',rc: 'yes' },
          { feat: 'You see every trade live',      manual: 'yes',  signals: 'yes',  copy: 'no',  fund: 'no',  rc: 'yes' },
          { feat: 'Cancel in one click',           manual: 'yes',  signals: 'yes',  copy: 'partial', fund: 'no', rc: 'yes' },
          { feat: 'No success fee on profits',     manual: 'yes',  signals: 'yes',  copy: 'no',  fund: 'no',  rc: 'yes' },
          { feat: 'Worst-case loss is bounded',    manual: 'no',   signals: 'no',   copy: 'no',  fund: 'partial', rc: 'yes' },
        ],
        colHead: ['Feature', 'Manual trading', 'Signal channels', 'Copytrading', 'Managed fund', 'Robot Claude'] as const,
        footer: 'You get the «hands-off» of a fund without ever sending us your money. Best of both worlds.',
      }
    : {
        title: 'Чем это лучше альтернатив?',
        sub: 'Вы наверняка уже торгуете криптой одним из этих способов. Честно сравним их с Robot Claude.',
        rows: [
          { feat: 'Деньги остаются на бирже',       manual: 'yes',  signals: 'yes',  copy: 'no',  fund: 'no',  rc: 'yes' },
          { feat: 'Работает 24/7 без вашего участия', manual: 'no', signals: 'no',   copy: 'yes', fund: 'yes', rc: 'yes' },
          { feat: 'Без эмоций и FOMO',              manual: 'no',   signals: 'no',   copy: 'yes', fund: 'yes', rc: 'yes' },
          { feat: 'Историю результатов можно проверить', manual: 'no', signals: 'rare', copy: 'rare', fund: 'rare', rc: 'yes' },
          { feat: 'Вы видите каждую сделку в момент', manual: 'yes',signals: 'yes',  copy: 'no',  fund: 'no',  rc: 'yes' },
          { feat: 'Отказ в один клик',              manual: 'yes',  signals: 'yes',  copy: 'partial', fund: 'no', rc: 'yes' },
          { feat: 'Нет комиссии с прибыли',         manual: 'yes',  signals: 'yes',  copy: 'no',  fund: 'no',  rc: 'yes' },
          { feat: 'Худший убыток ограничен заранее',manual: 'no',   signals: 'no',   copy: 'no',  fund: 'partial', rc: 'yes' },
        ],
        colHead: ['Свойство', 'Руками', 'Сигналы', 'Копитрейдинг', 'Управление', 'Robot Claude'] as const,
        footer: 'Получаете «не надо следить за рынком» как у фонда, но никому ничего не переводите. Лучшее из обоих миров.',
      };

  const cell = (v: string): string => {
    if (v === 'yes') return `<span class="at-cmp-yes" title="Да">✓</span>`;
    if (v === 'no') return `<span class="at-cmp-no" title="Нет">✗</span>`;
    if (v === 'partial') return `<span class="at-cmp-partial" title="Частично">~</span>`;
    if (v === 'rare') return `<span class="at-cmp-partial" title="Редко / не у всех">~</span>`;
    return '—';
  };

  const rows = t.rows.map((r) => `
    <tr>
      <td class="at-cmp-feat">${escapeHtml(r.feat)}</td>
      <td class="at-cmp-c">${cell(r.manual)}</td>
      <td class="at-cmp-c">${cell(r.signals)}</td>
      <td class="at-cmp-c">${cell(r.copy)}</td>
      <td class="at-cmp-c">${cell(r.fund)}</td>
      <td class="at-cmp-c at-cmp-us">${cell(r.rc)}</td>
    </tr>
  `).join('');

  return `
    <section class="at-section at-compare">
      <h2 class="at-section-title">${ico('⚖️')}${t.title}</h2>
      <p class="at-section-sub">${t.sub}</p>
      <div class="at-cmp-wrap">
        <table class="at-cmp-tbl">
          <thead>
            <tr>
              <th class="at-cmp-feat">${escapeHtml(t.colHead[0])}</th>
              <th>${escapeHtml(t.colHead[1])}</th>
              <th>${escapeHtml(t.colHead[2])}</th>
              <th>${escapeHtml(t.colHead[3])}</th>
              <th>${escapeHtml(t.colHead[4])}</th>
              <th class="at-cmp-us">${escapeHtml(t.colHead[5])}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="at-cmp-foot">${t.footer}</p>
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

/**
 * Walk-through video — narrated screen-capture of the actual signup +
 * Bybit API-key setup flow. Sits right after the 4-step text guide so
 * the visitor can either read the steps or watch them; the «1 minute»
 * label sets expectations so people don't bounce on «another long
 * tutorial».
 *
 * The video file is served via @fastify/static from public/. We don't
 * autoplay — autoplay-with-sound is blocked by browsers, and silent
 * autoplay distracts from the rest of the page. preload="metadata"
 * fetches only the few-hundred-byte header so the visitor sees the
 * poster and play-button without paying the 17MB download until they
 * click. Native <video controls> handles the rest.
 */
function renderWalkthroughVideo(lang: Lang): string {
  const videoSrc = '/static/setup-walkthrough.mp4?v=1';
  const t = lang === 'en'
    ? {
        title: 'See it in action — 1-minute walk-through',
        sub: 'Same 4 steps you just read, recorded end-to-end: phone-OTP signup, picking a tier, creating the Bybit API key with the correct permissions, and the first balance check. No edits, no skips.',
        cap1: 'Phone-OTP signup',
        cap2: 'Pick a tier',
        cap3: 'Bybit API key',
        cap4: 'First balance check',
      }
    : {
        title: 'Видео-инструкция · 1 минута',
        sub: 'Те же 4 шага, что вы прочитали выше — записано целиком от начала до конца: регистрация по телефону, выбор тарифа, создание ключа на Bybit с правильными правами, первая проверка баланса. Без склейки, без пропусков.',
        cap1: 'Вход по телефону',
        cap2: 'Выбор тарифа',
        cap3: 'Ключ на Bybit',
        cap4: 'Проверка баланса',
      };
  return `
    <section class="at-section at-walkthrough">
      <h2 class="at-section-title">${ico('🎬')}${t.title}</h2>
      <p class="at-section-sub">${t.sub}</p>
      <div class="at-walkthrough-wrap">
        <video class="at-walkthrough-video"
               src="${videoSrc}"
               controls
               preload="metadata"
               playsinline
               muted
               aria-label="${t.title}">
          Your browser does not support the video tag.
        </video>
        <div class="at-walkthrough-chips">
          <span class="at-walkthrough-chip"><b>1</b> ${t.cap1}</span>
          <span class="at-walkthrough-chip"><b>2</b> ${t.cap2}</span>
          <span class="at-walkthrough-chip"><b>3</b> ${t.cap3}</span>
          <span class="at-walkthrough-chip"><b>4</b> ${t.cap4}</span>
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
        featFreeBreakdown: `${14 + BYBIT_REF_BONUS_DAYS} days (14 + ${BYBIT_REF_BONUS_DAYS} bonus)`,
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
        intro: `Pick the tier yourself based on the deposit you want to allocate to auto-trading. The larger the deposit, the more strategies run in parallel and the higher the expected profit. Subscription cost stays under 18-20% of the expected monthly return — Starter is roughly the price of a Netflix subscription. <b>Scroll right</b> to see all tiers →`,
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
        featFreeBreakdown: `${14 + BYBIT_REF_BONUS_DAYS} дней (14 + ${BYBIT_REF_BONUS_DAYS} бонусом)`,
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
        intro: `Тариф вы выбираете сами по размеру депозита, который готовы выделить под автотрейдинг. Чем больше депозит — тем больше стратегий в работе и тем выше ожидаемая прибыль. Подписка покрывает не больше 18-20% потенциального месячного дохода — Starter стоит примерно как подписка Netflix. <b>Прокрутите вправо</b>, чтобы увидеть все тарифы →`,
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
    <div class="at-tier-card at-tier-free" data-tier="free">
      <div class="at-tier-card-glow"></div>
      <div class="at-tier-card-deco" aria-hidden="true">🎁</div>
      <div class="at-tier-badge">${ico('🎁')}${t.bonus}</div>
      <div class="at-tier-name">${t.freeName}</div>
      <div class="at-tier-depo">${t.freeDepo}</div>
      <div class="at-tier-price">
        <span class="at-tier-price-num">$0</span>
        <span class="at-tier-price-period">${t.perMonthDays}</span>
      </div>
      <p class="at-tier-pitch-top">${t.freePitch}</p>
      <ul class="at-tier-features">
        <li><span class="at-tier-feat-icon">🎯</span><span class="at-tier-feat-label">${t.feat3Strats}</span><span class="at-tier-feat-val">BTC, BNB, BCH</span></li>
        <li><span class="at-tier-feat-icon">⚡</span><span class="at-tier-feat-label">${t.featConcurrent}</span><span class="at-tier-feat-val">${t.upTo} 2</span></li>
        <li><span class="at-tier-feat-icon">💎</span><span class="at-tier-feat-label">${t.featFree}</span><span class="at-tier-feat-val">${t.featFreeBreakdown}</span></li>
        <li><span class="at-tier-feat-icon">🎁</span><span class="at-tier-feat-label">${t.featCondition}</span><span class="at-tier-feat-val">${t.featConditionVal} <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">${t.ourLink}</a></span></li>
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
      const emoji = tierEmoji(tier.id);
      return `
        <div class="at-tier-card ${isPopular ? 'at-tier-popular' : ''}" data-tier="${tier.id}" data-tier-index="${i + 1}">
          <div class="at-tier-card-glow"></div>
          <div class="at-tier-card-deco" aria-hidden="true">${emoji}</div>
          ${badge}
          <div class="at-tier-name">${emoji} ${escapeHtml(tier.name)}</div>
          <div class="at-tier-depo">${t.deposit} $${tier.minBalanceUsdt.toLocaleString()}${t.slash}${maxStr}</div>
          <div class="at-tier-price">
            <span class="at-tier-price-num">$${tier.monthlyPriceUsd}</span>
            <span class="at-tier-price-period">${t.perMonth}</span>
          </div>
          <p class="at-tier-pitch-top">${escapeHtml(tier.pitch)}</p>
          <ul class="at-tier-features">
            <li><span class="at-tier-feat-icon">💰</span><span class="at-tier-feat-label">${t.featProfit}</span><span class="at-tier-feat-val">${t.approx}${sub.low}${t.slash}$${sub.high}${t.perMonthShort}</span></li>
            <li><span class="at-tier-feat-icon">🎯</span><span class="at-tier-feat-label">${tier.strategyIds.length} ${t.featStrats}</span><span class="at-tier-feat-val">${escapeHtml(coinsStr)}</span></li>
            <li><span class="at-tier-feat-icon">⚡</span><span class="at-tier-feat-label">${t.featConcurrent}</span><span class="at-tier-feat-val">${t.upTo} ${tier.maxConcurrentPositions}</span></li>
            <li><span class="at-tier-feat-icon">💎</span><span class="at-tier-feat-label">${t.featTrial}</span><span class="at-tier-feat-val">${t.featTrialVal}</span></li>
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

/**
 * Interactive calculator — user enters their planned deposit, sees their
 * specific tier + expected monthly profit + net-after-subscription number.
 *
 * Data flow: tier ranges + price + expected PnL are baked into a JSON
 * blob server-side and injected into a `<script>` tag, then a tiny
 * vanilla-JS handler reads it on every input change. No external libs,
 * works without any framework.
 *
 * Placed between Safety and Pricing — by this point the visitor trusts
 * us; the calculator turns abstract numbers («Plus tier $X-Y/mo») into
 * THEIR exact number, anchoring desire right before they see the price.
 */
function renderCalculator(lang: Lang): string {
  const tiers = listTiers().filter((t) => t.id !== 'prof');
  // Trim tier data to only what JS needs — keeps the inline blob small.
  // Each tier carries its name, emoji, min/max balance, monthly price,
  // and the freshly-computed marketing PnL range (so if a strategy is
  // added to a tier later, the calculator updates with no code change).
  const tierData = tiers.map((tier) => {
    const m = getTierMarketingNumbers(tier.id);
    return {
      id: tier.id,
      name: tier.name,
      emoji: tierEmoji(tier.id),
      minBalance: tier.minBalanceUsdt,
      maxBalance: tier.maxBalanceUsdt === Infinity ? 999_999_999 : tier.maxBalanceUsdt,
      priceUsd: tier.monthlyPriceUsd,
      monthlyLow: m.rangeLow,
      monthlyHigh: m.rangeHigh,
    };
  });

  const t = lang === 'en'
    ? {
        title: 'Calculate your specific number',
        sub: 'Enter the deposit you plan to allocate — we\'ll tell you which plan fits you and roughly how much you should expect to make. The exact same math we use internally to size your trades.',
        inputLabel: 'Your planned deposit, USDT',
        belowMin: `Below $${MIN_AUTOTRADING_DEPOSIT_USDT} — auto-trading is not available. Minimum to qualify for any plan: $${MIN_AUTOTRADING_DEPOSIT_USDT}.`,
        outTier: 'Your plan',
        outProfitMo: 'Expected profit',
        outProfitYr: 'Per year (×12)',
        outNet: 'Net after subscription',
        outSubscription: 'Subscription cost',
        perMo: '/mo',
        ofDepo: 'of deposit',
        ratio: 'paid subscription : expected profit',
        cta: 'Sign up',
        disclaimer: 'Past results do not guarantee future returns. Live PnL may fluctuate ±30% around the forecast in any given month.',
      }
    : {
        title: 'Посчитайте свою цифру',
        sub: 'Введите депозит, который планируете выделить — мы покажем подходящий тариф и сколько примерно будете зарабатывать. Та же математика, по которой система рассчитывает ваши сделки.',
        inputLabel: 'Ваш планируемый депозит, USDT',
        belowMin: `Ниже $${MIN_AUTOTRADING_DEPOSIT_USDT} — автотрейдинг недоступен. Минимум для любого тарифа — $${MIN_AUTOTRADING_DEPOSIT_USDT}.`,
        outTier: 'Ваш тариф',
        outProfitMo: 'Ожидаемая прибыль',
        outProfitYr: 'За год (×12)',
        outNet: 'Чистыми после подписки',
        outSubscription: 'Стоимость подписки',
        perMo: '/мес',
        ofDepo: 'от депозита',
        ratio: 'подписка к ожидаемой прибыли',
        cta: 'Зарегистрироваться',
        disclaimer: 'Прошлые результаты не гарантируют будущих. Реальная доходность может отклоняться ±30% от прогноза в любой отдельный месяц.',
      };

  // Default to Standard mid-range so the calculator is never empty on
  // first render — it shows a realistic starting state before the user
  // touches anything.
  const defaultDeposit = 1500;
  // JSON-stringify tier data for the embedded JS. JSON.stringify is safe
  // inside a <script> because we never put a literal "</" in the values.
  const tierDataJson = JSON.stringify(tierData);

  return `
    <section class="at-section at-calc" id="calc">
      <h2 class="at-section-title">${ico('🧮')}${t.title}</h2>
      <p class="at-section-sub">${t.sub}</p>
      <div class="at-calc-wrap">
        <div class="at-calc-input-row">
          <label for="at-calc-input" class="at-calc-label">${t.inputLabel}</label>
          <div class="at-calc-input-box">
            <span class="at-calc-input-prefix">$</span>
            <input id="at-calc-input" type="number" inputmode="numeric" min="0" step="100"
                   value="${defaultDeposit}" class="at-calc-input"/>
          </div>
        </div>
        <div id="at-calc-output" class="at-calc-output">
          <!-- populated by inline script below -->
        </div>
        <div id="at-calc-toolow" class="at-calc-toolow" style="display:none;">
          ${ico('⚠')}${t.belowMin}
        </div>
        <p class="at-calc-disclaimer">${t.disclaimer}</p>
      </div>
    </section>
    <script>
      (function() {
        const TIERS = ${tierDataJson};
        const T = ${JSON.stringify(t)};
        const fmtUsd = (n) => '$' + Math.round(n).toLocaleString('en-US');
        const input = document.getElementById('at-calc-input');
        const out = document.getElementById('at-calc-output');
        const low = document.getElementById('at-calc-toolow');
        if (!input || !out || !low) return;
        function pickTier(depo) {
          for (const tier of TIERS) {
            if (depo >= tier.minBalance && depo <= tier.maxBalance) return tier;
          }
          return TIERS[TIERS.length - 1] || null;
        }
        function render() {
          const depo = Number(input.value) || 0;
          if (depo < ${MIN_AUTOTRADING_DEPOSIT_USDT}) {
            out.style.display = 'none';
            low.style.display = 'block';
            return;
          }
          const tier = pickTier(depo);
          if (!tier) { out.style.display = 'none'; return; }
          low.style.display = 'none';
          out.style.display = 'grid';
          // Use the band midpoint as the «typical» expected number, but
          // also surface the full range so users see both the floor and
          // the ceiling. Past-performance disclaimer below the table.
          const monthlyMid = Math.round((tier.monthlyLow + tier.monthlyHigh) / 2);
          const yearMid = monthlyMid * 12;
          const net = monthlyMid - tier.priceUsd;
          const yearNet = net * 12;
          const pctMo = depo > 0 ? (monthlyMid / depo * 100) : 0;
          // Guard against divide-by-zero AND infinite ratio: if monthlyMid
          // is 0 (e.g. a tier whose backtests collapse to zero forecast)
          // we can\\'t express the ratio meaningfully — show 0%.
          const ratio = tier.priceUsd > 0 && monthlyMid > 0
            ? (tier.priceUsd / monthlyMid * 100)
            : 0;
          // Suffix («/мес», « от депозита», « ×12») rendered as a separate
          // <span class="at-calc-card-suffix"> so it can wrap to a new line
          // OR sit beside the value with smaller font. Keeps the headline
          // number on one line at small widths.
          out.innerHTML =
            '<div class="at-calc-card at-calc-card-tier">' +
              '<div class="at-calc-card-label">' + T.outTier + '</div>' +
              '<div class="at-calc-card-value">' + tier.emoji + ' ' + tier.name + '</div>' +
              '<div class="at-calc-card-sub">$' + tier.priceUsd + T.perMo + ' · ' + T.outSubscription.toLowerCase() + '</div>' +
            '</div>' +
            '<div class="at-calc-card at-calc-card-profit">' +
              '<div class="at-calc-card-label">' + T.outProfitMo + '</div>' +
              '<div class="at-calc-card-value">+' + fmtUsd(tier.monthlyLow) + '–' + fmtUsd(tier.monthlyHigh) +
                '<span class="at-calc-card-suffix">' + T.perMo + '</span></div>' +
              '<div class="at-calc-card-sub">≈ ' + pctMo.toFixed(1) + '% ' + T.ofDepo + '</div>' +
            '</div>' +
            '<div class="at-calc-card at-calc-card-year">' +
              '<div class="at-calc-card-label">' + T.outProfitYr + '</div>' +
              '<div class="at-calc-card-value">≈ +' + fmtUsd(yearMid) + '</div>' +
              '<div class="at-calc-card-sub">' + T.outNet + ': +' + fmtUsd(yearNet) + '</div>' +
            '</div>' +
            '<div class="at-calc-card at-calc-card-ratio">' +
              '<div class="at-calc-card-label">' + T.ratio + '</div>' +
              '<div class="at-calc-card-value">' + ratio.toFixed(0) + '%</div>' +
              '<div class="at-calc-card-sub">' + T.outNet + ': ' + (net >= 0 ? '+' : '') + fmtUsd(net) +
                '<span class="at-calc-card-suffix"> ' + T.perMo + '</span></div>' +
            '</div>';
        }
        input.addEventListener('input', render);
        render();
      })();
    </script>
  `;
}

/**
 * Telegram-channel capture block — placed AFTER the final CTA. For
 * visitors who scrolled all the way down but aren't ready to sign up,
 * we offer a low-commitment way to stay in touch: follow the public
 * signals channel. They get value (live trade alerts) without payment,
 * and we stay top-of-mind for when they're ready.
 */
function renderTelegramCapture(lang: Lang): string {
  if (lang === 'en') {
    return `
    <section class="at-section at-tg-capture">
      <div class="at-tg-capture-card">
        <div class="at-tg-capture-icon">${ico('📡')}</div>
        <div class="at-tg-capture-body">
          <div class="at-tg-capture-title">Not ready yet? Stay in the loop.</div>
          <div class="at-tg-capture-sub">
            Every trade Robot Claude opens is also broadcast in our public Telegram channel — live, no edits.
            Follow for free and see for yourself before you commit.
          </div>
        </div>
        <a href="https://t.me/luxalgosignal" target="_blank" rel="noopener" class="at-btn-secondary">
          ${ico('📣')}Open the channel
        </a>
      </div>
    </section>
  `;
  }
  return `
    <section class="at-section at-tg-capture">
      <div class="at-tg-capture-card">
        <div class="at-tg-capture-icon">${ico('📡')}</div>
        <div class="at-tg-capture-body">
          <div class="at-tg-capture-title">Не готовы сейчас? Останьтесь рядом.</div>
          <div class="at-tg-capture-sub">
            Каждая сделка Robot Claude транслируется в публичный Telegram-канал — в режиме реального времени, без правок постфактум.
            Подписывайтесь бесплатно и понаблюдайте, прежде чем решаться.
          </div>
        </div>
        <a href="https://t.me/luxalgosignal" target="_blank" rel="noopener" class="at-btn-secondary">
          ${ico('📣')}Открыть канал
        </a>
      </div>
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
    /* Mobile: let the carousel handle horizontal swipes but always allow
       vertical page scroll. Without touch-action the browser sometimes
       hijacks vertical drags after a horizontal one starts. */
    touch-action: pan-x pan-y;
    /* Keep the page's swipe-back gesture from triggering when scrolling
       past the carousel edges. */
    overscroll-behavior-x: contain;
  }
  .at-tier-carousel::-webkit-scrollbar { height: 8px; }
  .at-tier-carousel::-webkit-scrollbar-track { background: transparent; }
  .at-tier-carousel::-webkit-scrollbar-thumb { background: #2a323d; border-radius: 4px; }
  .at-tier-scroll-hint {
    text-align: center; font-size: 11.5px; color: #6b7480;
    margin: 6px 0 18px; letter-spacing: 0.02em;
  }
  /* =============================================================
   *  TIER CARDS — visual identity per tier
   *
   *  Each card carries data-tier="<id>" and inherits two CSS vars
   *  from the matching selector below:
   *     --tier-accent     primary colour (used by glow, border-hover, price)
   *     --tier-accent-soft same colour at low alpha (subtle background)
   *  The base .at-tier-card rule reads both vars; per-tier overrides
   *  redefine them without touching layout. New tiers added later just
   *  need a [data-tier="X"] block here — no markup changes needed. */
  .at-tier-card {
    --tier-accent: #4ad991;
    --tier-accent-soft: rgba(74,217,145,0.10);
    background: linear-gradient(180deg, #161c25 0%, #11161d 70%);
    border: 1px solid #1f2630; border-radius: 18px;
    padding: 32px 26px 26px;
    display: flex; flex-direction: column;
    position: relative; overflow: hidden;
    /* Bigger cards now that focus mode shows one at a time. 380px lets
       all features breathe; on mobile we keep 86vw so swipe feels natural. */
    flex: 0 0 380px;
    min-width: 0;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    transition: transform 220ms cubic-bezier(0.2, 0, 0, 1),
                box-shadow 220ms, border-color 220ms;
  }
  /* Per-tier accent palette. */
  [data-tier="free"]     { --tier-accent: #f3d266; --tier-accent-soft: rgba(243,210,102,0.10); }
  [data-tier="starter"]  { --tier-accent: #5db5ff; --tier-accent-soft: rgba(93,181,255,0.10); }
  [data-tier="standard"] { --tier-accent: #4ad991; --tier-accent-soft: rgba(74,217,145,0.10); }
  [data-tier="plus"]     { --tier-accent: #b08cff; --tier-accent-soft: rgba(176,140,255,0.10); }
  [data-tier="pro"]      { --tier-accent: #ff9c54; --tier-accent-soft: rgba(255,156,84,0.10); }
  [data-tier="vip"]      { --tier-accent: #ff77c4; --tier-accent-soft: rgba(255,119,196,0.10); }
  [data-tier="prof"]     { --tier-accent: #ff6363; --tier-accent-soft: rgba(255,99,99,0.10); }

  /* Soft glow strip pinned to the top edge — tier-coloured. Cheap visual
     identity that doesn't compete with the card content. Sized small so
     it doesn't create a wide horizontal «pill» feel behind the badge. */
  .at-tier-card-glow {
    position: absolute; top: 0; left: 0; right: 0; height: 70px;
    pointer-events: none;
    background: radial-gradient(ellipse 60% 100% at 50% 0%, var(--tier-accent-soft) 0%, transparent 75%);
    opacity: 0.55;
  }
  /* Dimmed tier emoji in the upper-right corner — fully inside the card
     so it isn't clipped by the card's overflow:hidden. */
  .at-tier-card-deco {
    position: absolute; top: 8px; right: 8px;
    font-size: 120px; line-height: 1;
    opacity: 0.07; pointer-events: none;
    filter: grayscale(0.3);
    transition: opacity 320ms, transform 320ms;
  }
  /* Content elements sit above the deco emoji and glow. */
  .at-tier-card > :not(.at-tier-card-glow):not(.at-tier-card-deco) {
    position: relative; z-index: 1;
  }

  /* Hover on non-active card: subtle lift + tier-coloured ring. */
  .at-tier-card:hover {
    transform: translateY(-4px);
    border-color: color-mix(in srgb, var(--tier-accent) 45%, #1f2630);
    box-shadow: 0 16px 40px rgba(0,0,0,0.40),
                0 0 0 1px color-mix(in srgb, var(--tier-accent) 25%, transparent);
  }
  .at-tier-card:hover .at-tier-card-deco {
    opacity: 0.12; transform: scale(1.04) rotate(-3deg);
  }

  /* Badge is now an INLINE chip in the card flow (sits above the tier
   * name as a regular element). No padding-top reservation needed. */
  /* Active card lifts more + accent border + soft tier-coloured shadow. */
  [data-carousel="focus"] .at-tier-card.rc-card-active {
    border-color: color-mix(in srgb, var(--tier-accent) 60%, #1f2630);
    box-shadow: 0 18px 48px rgba(0,0,0,0.50),
                0 0 0 1px color-mix(in srgb, var(--tier-accent) 40%, transparent),
                0 0 36px -6px color-mix(in srgb, var(--tier-accent) 35%, transparent);
  }
  [data-carousel="focus"] .at-tier-card.rc-card-active .at-tier-card-glow {
    opacity: 1;
  }
  [data-carousel="focus"] .at-tier-card.rc-card-active .at-tier-card-deco {
    opacity: 0.12;
  }

  @media (max-width: 640px) {
    .at-tier-card {
      flex: 0 0 86vw; padding: 28px 20px 22px;
      border-radius: 16px;
      /* Lighter drop shadow on mobile — the desktop 0 18px 48px was
         strong enough to visually compete with the active-card border,
         making the outline read as «only top is gold». */
      box-shadow: 0 4px 16px rgba(0,0,0,0.30);
    }
    /* Active card on mobile: tier-accent ring drawn as INSET box-shadow
       so it sits inside the card's visible bounds and can't be clipped
       by parent overflow / scroll containers. Keeps the regular 1px
       border layout intact (no width jump → no layout shift). */
    [data-carousel="focus"] .at-tier-card.rc-card-active {
      box-shadow: inset 0 0 0 2px var(--tier-accent),
                  0 6px 20px rgba(0,0,0,0.40);
    }
    .at-tier-carousel { padding-left: 7vw; padding-right: 7vw; gap: 16px; }
    /* Smaller deco + glow on mobile so they don't dominate the smaller card. */
    .at-tier-card-deco { font-size: 92px; top: 6px; right: 6px; }
    .at-tier-card-glow { height: 80px; }
    .at-tier-badge { font-size: 9.5px; padding: 3px 9px; margin-bottom: 12px; }
    .at-tier-name { font-size: 17px; }
    .at-tier-price-num { font-size: 32px; }
    .at-tier-features { font-size: 12.5px; }
    .at-tier-features li { gap: 8px; padding: 7px 0; }
    .at-tier-feat-icon { width: 24px; height: 24px; font-size: 12px; }
  }

  /* Popular & Free retain extra top-glow tinting for instant
     recognisability even before hover. */
  .at-tier-card.at-tier-popular {
    background: linear-gradient(180deg, rgba(74,217,145,0.06) 0%, #11161d 70%);
  }
  .at-tier-card.at-tier-free {
    background: linear-gradient(180deg, rgba(243,210,102,0.05) 0%, #11161d 70%);
  }

  /* Inline chip at the very top of the card (above the tier name).
   * No absolute positioning — sits in the normal flow with a fixed
   * width so it can never extend across the card width visually. */
  .at-tier-badge {
    display: inline-flex; align-items: center;
    width: fit-content;
    background: rgba(243, 210, 102, 0.20);
    color: #f3d266;
    padding: 4px 10px; border-radius: 999px;
    font-size: 10.5px; font-weight: 700;
    border: 1px solid rgba(243, 210, 102, 0.50);
    letter-spacing: 0.05em; text-transform: uppercase;
    line-height: 1.2;
    margin-bottom: 14px;
  }
  .at-tier-badge-popular {
    background: rgba(74, 217, 145, 0.20);
    color: #4ad991;
    border-color: rgba(74, 217, 145, 0.55);
  }
  .at-tier-name {
    font-size: 18px; font-weight: 700; color: #e8edf2;
    margin-bottom: 4px; letter-spacing: -0.01em;
  }
  .at-tier-depo {
    font-size: 11.5px; color: #8590a0; margin-bottom: 14px;
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;
  }
  .at-tier-price {
    display: flex; align-items: baseline; gap: 6px; margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .at-tier-price-num {
    font-size: 36px; font-weight: 800;
    color: var(--tier-accent);
    background: linear-gradient(135deg,
      var(--tier-accent) 0%,
      color-mix(in srgb, var(--tier-accent) 70%, #fff) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.02em; line-height: 1;
  }
  /* Fallback for browsers without color-mix — solid colour stays readable. */
  @supports not (color: color-mix(in srgb, red, blue)) {
    .at-tier-price-num { -webkit-text-fill-color: var(--tier-accent); }
  }
  .at-tier-price-period { font-size: 13px; color: #8590a0; }
  .at-tier-pitch-top {
    font-size: 13px; color: #cfd6dd; line-height: 1.6;
    margin: 0 0 14px;
  }
  .at-tier-features {
    list-style: none; padding: 0; margin: 0 0 12px 0;
    font-size: 13px; color: #cfd6dd; line-height: 1.5;
    flex: 1;
  }
  .at-tier-features li {
    padding: 8px 0; display: flex; align-items: flex-start; gap: 10px;
    border-top: 1px dashed rgba(255,255,255,0.04);
  }
  .at-tier-features li:first-child { border-top: none; padding-top: 4px; }
  /* Feature icon in a soft circular badge — gives the row a clear visual
     anchor and lets the per-tier accent peek through subtly. */
  .at-tier-feat-icon {
    flex-shrink: 0; font-size: 13px; line-height: 1;
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%;
    background: var(--tier-accent-soft);
    border: 1px solid color-mix(in srgb, var(--tier-accent) 25%, transparent);
  }
  @supports not (color: color-mix(in srgb, red, blue)) {
    .at-tier-feat-icon { border-color: rgba(255,255,255,0.06); }
  }
  .at-tier-feat-label { color: #8590a0; white-space: nowrap; flex-shrink: 0; font-weight: 500; }
  /* Value column takes remaining width and wraps inside its own box so
     multi-word values (coin lists, link rows) don't fragment across flex
     items. Without this, an inline <a> next to plain text turns the row
     into separate flex children with their own gaps. */
  .at-tier-feat-val {
    flex: 1; min-width: 0; color: #cfd6dd;
    word-wrap: break-word; overflow-wrap: anywhere;
  }
  .at-tier-features a {
    color: var(--tier-accent); text-decoration: none; font-weight: 600;
  }
  .at-tier-features a:hover { text-decoration: underline; }
  .at-tier-after-bonus {
    font-size: 11.5px; color: #8590a0; line-height: 1.5;
    margin-top: auto; padding-top: 12px;
    border-top: 1px solid rgba(255,255,255,0.05);
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
    touch-action: pan-x pan-y;
    overscroll-behavior-x: contain;
  }
  .at-bd-tiers::-webkit-scrollbar { height: 8px; }
  .at-bd-tiers::-webkit-scrollbar-track { background: transparent; }
  .at-bd-tiers::-webkit-scrollbar-thumb { background: #2a323d; border-radius: 4px; }
  .at-bd-tier {
    background: linear-gradient(180deg, #161c25 0%, #11161d 70%);
    border: 1px solid #1f2630;
    border-radius: 14px;
    padding: 22px 24px;
    min-width: 0;
    box-sizing: border-box;
    /* One card per view + a peek of the next so visitor sees "there
       is more". 560px desktop, 92vw mobile. */
    flex: 0 0 min(560px, 92vw);
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

  /* Mobile: card sits inside a 86vw flex item, so the inner table can't
     be 6 columns wide without overflowing. Compresses padding, font and
     column widths so the table fits, AND drops the duplicated SL% column
     (the % of deposit column at the right communicates the same risk
     in user-relevant units). */
  @media (max-width: 640px) {
    .at-bd-tier {
      padding: 16px 12px;
      flex: 0 0 92vw;
    }
    .at-bd-tier-head { margin-bottom: 10px; }
    .at-bd-tier-depo { font-size: 11.5px; }
    .at-bd-tier-stats {
      padding: 8px 10px; gap: 10px;
      font-size: 11.5px;
    }
    .at-bd-stat-value { font-size: 12.5px; }
    .at-bd-stat-label { font-size: 9.5px; }
    .at-bd-tbl {
      font-size: 11.5px; table-layout: fixed; width: 100%;
    }
    .at-bd-tbl th {
      font-size: 9px; padding: 6px 4px;
      letter-spacing: 0.03em;
    }
    .at-bd-tbl td { padding: 8px 4px; }
    .at-bd-tbl th:first-child, .at-bd-tbl td:first-child { padding-left: 2px; }
    .at-bd-tbl th:last-child, .at-bd-tbl td:last-child { padding-right: 2px; }
    /* Hide leverage and SL% columns on mobile — the size + max-loss
       + %-of-deposit columns already tell the full story. */
    .at-bd-tbl th:nth-child(2), .at-bd-tbl td:nth-child(2),
    .at-bd-tbl th:nth-child(4), .at-bd-tbl td:nth-child(4) { display: none; }
    .at-bd-strat b { font-size: 12px; }
    .at-bd-strat-meta { font-size: 9.5px; }
    .at-bd-worst {
      padding: 10px 12px; gap: 6px;
      flex-direction: column; align-items: flex-start;
    }
    .at-bd-worst-label { font-size: 11.5px; }
    .at-bd-worst-value { font-size: 13px; }
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

  /* ----- Comparison table — «vs alternatives» ----- */
  .at-compare { margin-top: 50px; }
  .at-cmp-wrap {
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    background: #11161d; border: 1px solid #1f2630; border-radius: 12px;
    margin: 0 auto; max-width: 980px;
  }
  .at-cmp-tbl {
    width: 100%; border-collapse: collapse;
    font-size: 13.5px; color: #cfd6dd;
    min-width: 640px;
  }
  .at-cmp-tbl thead { background: #0e131a; }
  .at-cmp-tbl th {
    padding: 14px 14px; text-align: center; font-weight: 600;
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
    color: #8590a0; border-bottom: 1px solid #1f2630;
  }
  .at-cmp-tbl th.at-cmp-feat { text-align: left; }
  .at-cmp-tbl th.at-cmp-us {
    color: #4ad991;
    background: rgba(74, 217, 145, 0.06);
  }
  .at-cmp-tbl td {
    padding: 12px 14px; border-bottom: 1px solid #1a1f27;
    text-align: center; font-size: 18px; line-height: 1.2;
  }
  .at-cmp-tbl td.at-cmp-feat {
    text-align: left; font-size: 13.5px; color: #e8edf2; font-weight: 500;
  }
  .at-cmp-tbl td.at-cmp-us {
    background: rgba(74, 217, 145, 0.04);
  }
  .at-cmp-tbl tr:last-child td { border-bottom: none; }
  .at-cmp-yes { color: #4ad991; font-weight: 700; }
  .at-cmp-no { color: #ff6363; font-weight: 700; }
  .at-cmp-partial { color: #f5b14d; font-weight: 700; }
  .at-cmp-foot {
    margin: 18px auto 0; max-width: 720px;
    text-align: center; font-size: 13.5px;
    color: #b6c1cf; line-height: 1.6;
  }
  @media (max-width: 640px) {
    .at-cmp-tbl { font-size: 12.5px; }
    .at-cmp-tbl td.at-cmp-feat { font-size: 12px; }
    .at-cmp-tbl td { font-size: 16px; padding: 10px 8px; }
    .at-cmp-tbl th { font-size: 10.5px; padding: 10px 6px; }
  }

  /* ----- Calculator ----- */
  .at-calc { margin-top: 50px; }
  .at-calc-wrap {
    max-width: 860px; margin: 0 auto;
    background: #11161d; border: 1px solid #1f2630;
    border-radius: 14px; padding: 28px 28px 22px;
  }
  .at-calc-input-row { margin-bottom: 22px; }
  .at-calc-label {
    display: block; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.08em; color: #8590a0;
    margin-bottom: 10px; font-weight: 600;
  }
  .at-calc-input-box {
    display: flex; align-items: stretch;
    background: #0b0e13; border: 1px solid #2a323d;
    border-radius: 9px; overflow: hidden;
    transition: border-color 0.15s;
  }
  .at-calc-input-box:focus-within { border-color: #4ad991; }
  .at-calc-input-prefix {
    display: flex; align-items: center; padding: 0 14px 0 16px;
    font-size: 22px; color: #4ad991; font-weight: 600;
  }
  .at-calc-input {
    flex: 1; background: transparent; border: none; outline: none;
    color: #e8edf2; font-size: 22px; font-weight: 600;
    font-family: 'SF Mono', Menlo, monospace;
    padding: 14px 16px 14px 0;
  }
  .at-calc-input::-webkit-outer-spin-button,
  .at-calc-input::-webkit-inner-spin-button {
    -webkit-appearance: none; margin: 0;
  }
  .at-calc-output {
    display: grid; gap: 12px;
    /* Wider min-column (200px) + responsive scaling: 2-col on tablet,
     * 1-col on phone. Avoids the squeezed-2nd-column where /мес got
     * pushed onto a new line. */
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  @media (max-width: 880px) {
    .at-calc-output { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 480px) {
    .at-calc-output { grid-template-columns: 1fr; }
  }
  .at-calc-card {
    padding: 16px 18px;
    background: #0e131a; border: 1px solid #1f2630;
    border-radius: 10px; min-height: 110px;
    display: flex; flex-direction: column; gap: 4px;
    min-width: 0; /* allow flex/grid item to shrink with long content */
  }
  .at-calc-card-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #8590a0; font-weight: 600;
    line-height: 1.35; min-height: 30px;
  }
  .at-calc-card-value {
    font-size: 20px; font-weight: 700; color: #e8edf2;
    line-height: 1.15;
    /* Force numeric values like «+$337–$626» onto a single line. The
     * en-dash is a default break opportunity for the browser, so
     * without nowrap «$337–» and «$626» land on separate lines. */
    white-space: nowrap;
    /* Hide overflow at extreme narrow widths instead of breaking — the
     * mobile media query drops the font enough that this shouldn't
     * trigger in practice. */
    overflow: hidden; text-overflow: ellipsis;
  }
  /* Period suffix («/мес», «×12»). Smaller font + dimmed colour. The
   * leading space character keeps the suffix from glueing to the value. */
  .at-calc-card-suffix {
    font-size: 13px; font-weight: 600; color: #8590a0;
    margin-left: 2px; letter-spacing: 0;
    white-space: nowrap;
  }
  .at-calc-card-sub {
    font-size: 12px; color: #8590a0; margin-top: auto;
    line-height: 1.4;
  }
  .at-calc-card-tier .at-calc-card-value { color: #e8edf2; }
  .at-calc-card-profit .at-calc-card-value { color: #4ad991; }
  .at-calc-card-year .at-calc-card-value { color: #4ad991; }
  .at-calc-card-ratio .at-calc-card-value { color: #f5b14d; }
  /* Font scales down as columns get narrower so the nowrap value
     always fits without ellipsis. Card columns go 4 → 2 → 1 across
     the breakpoints above. */
  @media (max-width: 1080px) {
    .at-calc-card-value { font-size: 18px; }
    .at-calc-card-suffix { font-size: 12px; }
  }
  @media (max-width: 880px) {
    /* 2 columns = wider cards again. */
    .at-calc-card-value { font-size: 20px; }
    .at-calc-card-suffix { font-size: 13px; }
  }
  @media (max-width: 480px) {
    /* Single column, full width. */
    .at-calc-card-value { font-size: 22px; }
  }
  .at-calc-toolow {
    padding: 14px 16px; border-radius: 9px;
    background: rgba(245, 177, 77, 0.08);
    border: 1px solid rgba(245, 177, 77, 0.30);
    color: #f5b14d; font-size: 13.5px; line-height: 1.55;
  }
  .at-calc-disclaimer {
    margin: 18px 0 0; font-size: 12px; color: #8590a0;
    line-height: 1.55; text-align: center;
  }

  /* ----- Telegram capture ----- */
  .at-tg-capture { margin-top: 32px; }
  .at-tg-capture-card {
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
    max-width: 860px; margin: 0 auto;
    background: rgba(0, 136, 204, 0.06);
    border: 1px solid rgba(0, 136, 204, 0.30);
    border-radius: 12px; padding: 22px 26px;
  }
  .at-tg-capture-icon { font-size: 28px; flex-shrink: 0; }
  .at-tg-capture-body { flex: 1; min-width: 240px; }
  .at-tg-capture-title {
    font-size: 16px; font-weight: 600; color: #e8edf2;
    margin-bottom: 4px;
  }
  .at-tg-capture-sub {
    font-size: 13px; color: #9aa5b1; line-height: 1.55;
  }
  @media (max-width: 480px) {
    .at-tg-capture-card { padding: 18px 20px; gap: 14px; }
  }

  /* ----- Walk-through video ----- */
  .at-walkthrough { margin-top: 30px; }
  .at-walkthrough-wrap {
    max-width: 880px; margin: 0 auto;
    background: #11161d; border: 1px solid #1f2630;
    border-radius: 14px; padding: 18px;
    box-shadow: 0 12px 36px -16px rgba(0, 0, 0, 0.55);
  }
  .at-walkthrough-video {
    display: block; width: 100%; height: auto;
    border-radius: 10px;
    background: #000;
    aspect-ratio: 16 / 9;
    object-fit: contain;
  }
  .at-walkthrough-chips {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 8px; margin-top: 14px;
  }
  .at-walkthrough-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 999px;
    background: #0e131a; border: 1px solid #1f2630;
    color: #9aa5b1; font-size: 12px;
  }
  .at-walkthrough-chip b {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; border-radius: 50%;
    font-size: 11px; font-weight: 700;
    background: rgba(74, 217, 145, 0.15); color: #4ad991;
  }
  @media (max-width: 560px) {
    .at-walkthrough-wrap { padding: 12px; border-radius: 12px; }
    .at-walkthrough-chip { font-size: 11px; padding: 5px 10px; }
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

import type { FastifyInstance } from 'fastify';
import { STRATEGY_CONFIGS, TRACK_C_NOTIONAL_USD } from './track-c-config.js';
import { getStrategyLiveStats } from './live-stats.js';
import { pageShell } from './landing.js';

/**
 * Marketing-facing home page (robotclaude.biz/).
 *
 * Honest, technical/engineering tone. Built as a funnel for future
 * copy-trading on Bybit and Hyperliquid:
 *   /        — RU (default)
 *   /en      — English
 *
 * All content lives in `CONTENT[lang]` constants so the operator can
 * edit copy with a git diff (no DB, no CMS). Live portfolio numbers
 * come from the same getStrategyLiveStats() the strategy index uses,
 * so they're always in sync with reality.
 *
 * Page is intentionally cacheable for 60s to weather scrape storms;
 * landing-page consumers (Telegram link unfurl, OG preview) hit it once.
 */

const PAGE_CACHE_SECONDS = 60;

type Lang = 'ru' | 'en';

type Content = {
  htmlTitle: string;
  hero: {
    eyebrow: string;
    title1: string;
    titleAccent: string;
    title2: string;
    subtitle: string;
    ctaPrimary: string;
    ctaSecondary: string;
  };
  liveStrip: {
    strategies: string;
    livePnl: string;
    liveTrades: string;
    bestWr: string;
  };
  how: {
    title: string;
    subtitle: string;
    steps: Array<{ step: string; title: string; body: string }>;
  };
  strategiesPreview: {
    title: string;
    subtitle: string;
    seeAll: string;
  };
  roadmap: {
    title: string;
    items: Array<{ when: string; done: boolean; title: string }>;
  };
  faq: {
    title: string;
    items: Array<{ q: string; a: string }>;
  };
  ctaSection: {
    title: string;
    subtitle: string;
    telegram: string;
    strategies: string;
  };
  telegramUrl: string;
};

const CONTENT: Record<Lang, Content> = {
  ru: {
    htmlTitle: 'Robot Claude — проверенные торговые стратегии LuxAlgo',
    hero: {
      eyebrow: 'POWERED BY LUXALGO AI · BYBIT PERPETUALS',
      title1: 'Проверенные стратегии от ',
      titleAccent: 'LuxAlgo AI',
      title2: '',
      subtitle:
        'Каждая стратегия проходит независимый бектест 200+ дней, подбирается по profit factor и win rate, исполняется автоматически через webhook'
        + ' и логируется публично в реальном времени. Никаких чёрных ящиков — каждый трейд можно проверить.',
      ctaPrimary: 'Активные стратегии →',
      ctaSecondary: 'Telegram канал ↗',
    },
    liveStrip: {
      strategies: 'Стратегий',
      livePnl: 'Live P&L',
      liveTrades: 'Live сделок',
      bestWr: 'Лучший WR backtest',
    },
    how: {
      title: 'Как это работает',
      subtitle: 'Технический пайплайн от сигнала до сделки и до публичного отчёта.',
      steps: [
        {
          step: 'STEP 01',
          title: 'LuxAlgo AI Strategy Builder',
          body: 'Каждая стратегия собирается в признанной платформе LuxAlgo Premium — multi-condition логика (Contrarian / Trend Tracer / Money Flow и др.) с встроенным бектестом и динамическими выходами. Принимаем только стратегии с PF ≥ 2 и WR ≥ 55% на 200+ днях истории.',
        },
        {
          step: 'STEP 02',
          title: 'Webhook → наша система',
          body: 'TradingView Alert по сигналу стратегии отправляет JSON в наш сервер. Дедупликация, валидация, маршрутизация в исполнитель за <100ms. Если webhook не доставлен — safety SL страхует позицию.',
        },
        {
          step: 'STEP 03',
          title: 'Bybit / Hyperliquid execution',
          body: 'Market entry с safety stop-loss. Выходы — либо по обратному сигналу стратегии (Builtin Exits), либо по safety SL как страховке. Никакого ручного вмешательства — система работает 24/7.',
        },
        {
          step: 'STEP 04',
          title: 'Публичный учёт',
          body: 'Каждая сделка летит в БД и отображается на лендинге стратегии: equity curve, полный trades log, exit reasons, P&L в реальном времени. Подписчик может проверить каждую сделку до тика.',
        },
      ],
    },
    strategiesPreview: {
      title: 'Активные стратегии',
      subtitle:
        'Каждая стратегия со своим лендингом — equity curve, полный лог сделок и live результаты. Числа пересчитаны на нашу позицию $1000 с учётом комиссии Bybit.',
      seeAll: 'Все стратегии →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'СЕЙЧАС',
          done: true,
          title: '🚀 Расширение портфеля проверенных LuxAlgo стратегий. Каждая со своим лендингом и live статистикой.',
        },
        {
          when: 'ИЮЛЬ 2026',
          done: false,
          title: 'Подключение Bybit live на лучшие стратегии. Малый размер для отработки исполнения.',
        },
        {
          when: 'АВГУСТ 2026',
          done: false,
          title: 'Hyperliquid Vault — параллельный канал для on-chain copy traders.',
        },
        {
          when: 'Q4 2026',
          done: false,
          title: 'Bybit Copy Trading — открытый набор followers после 90 дней live истории.',
        },
      ],
    },
    faq: {
      title: 'FAQ',
      items: [
        {
          q: 'Откуда берутся стратегии?',
          a: 'Все стратегии собираются в LuxAlgo AI Strategy Builder — на признанной платформе для multi-condition стратегий с автоматическим бектестом. Каждая стратегия имеет ссылку на оригинальный chat в LuxAlgo на детальном лендинге для верификации.',
        },
        {
          q: 'Какой риск-менеджмент?',
          a: 'Каждая стратегия имеет safety stop-loss (обычно 2-3% от entry) как страховку на случай задержки webhook. Размер позиции фиксированный $1000 на сделку. Max 1 позиция на (символ × стратегия). Выходы полностью на стратегии — никакого ручного вмешательства.',
        },
        {
          q: 'Как смотреть live результаты?',
          a: 'Главный дашборд на /strategies с группировкой по таймфреймам. На /strategies/<code> — детальная страница каждой стратегии с equity curve, полным trades log, breakdown long/short. Обновляется автоматически каждые 60 секунд.',
        },
        {
          q: 'Что если стратегия в просадке?',
          a: 'Сначала разбираемся: рыночная аномалия или сломанный edge. Если 10+ убыточных сделок подряд → автоматический pause. Followers могут отключиться в любой момент (Bybit Copy) или выйти из Vault.',
        },
        {
          q: 'Какие комиссии учитываются?',
          a: 'Bybit perp taker: 0.055% × 2 (открытие+закрытие) = 0.11% круговая. Hyperliquid: 0.025% × 2 = 0.05%. В наших бектестах эти комиссии вычитаются на каждой сделке — числа на лендингах honest.',
        },
        {
          q: 'Безопасны ли мои деньги?',
          a: 'Copy Trading на Bybit использует ваш собственный аккаунт — мы не имеем доступа к вашим средствам. Hyperliquid Vault работает на смарт-контракте, депозит/вывод по запросу. Мы получаем процент только с прибыли.',
        },
      ],
    },
    ctaSection: {
      title: 'Следить за прогрессом',
      subtitle:
        'Каждая открытая и закрытая сделка постится в Telegram канал в реальном времени с T# ID и ссылкой на детальный лендинг.',
      telegram: 'Telegram канал',
      strategies: 'Все стратегии',
    },
    telegramUrl: 'https://t.me/luxalgosignal',
  },
  en: {
    htmlTitle: 'Robot Claude — verified LuxAlgo trading strategies',
    hero: {
      eyebrow: 'POWERED BY LUXALGO AI · BYBIT PERPETUALS',
      title1: 'Verified strategies from ',
      titleAccent: 'LuxAlgo AI',
      title2: '',
      subtitle:
        'Each strategy goes through 200+ days of independent backtesting, is selected by profit factor and win rate,'
        + ' executes automatically via webhook, and is logged publicly in real-time. No black boxes — every trade is verifiable.',
      ctaPrimary: 'View strategies →',
      ctaSecondary: 'Telegram channel ↗',
    },
    liveStrip: {
      strategies: 'Strategies',
      livePnl: 'Live P&L',
      liveTrades: 'Live trades',
      bestWr: 'Best backtest WR',
    },
    how: {
      title: 'How it works',
      subtitle: 'Technical pipeline from signal to execution to public audit trail.',
      steps: [
        {
          step: 'STEP 01',
          title: 'LuxAlgo AI Strategy Builder',
          body: 'Every strategy is built in the LuxAlgo Premium platform — multi-condition logic (Contrarian / Trend Tracer / Money Flow etc.) with embedded backtest and dynamic exits. We accept only strategies with PF ≥ 2 and WR ≥ 55% over 200+ days.',
        },
        {
          step: 'STEP 02',
          title: 'Webhook → our system',
          body: 'TradingView Alert posts JSON to our server on every signal. Dedup, validate, route to handler in <100ms. If webhook is lost — safety SL protects the position.',
        },
        {
          step: 'STEP 03',
          title: 'Bybit / Hyperliquid execution',
          body: 'Market entry with safety stop-loss. Exits triggered by reverse strategy signal (Builtin Exits) or safety SL as backup. No manual intervention — system runs 24/7.',
        },
        {
          step: 'STEP 04',
          title: 'Public audit trail',
          body: 'Every trade lands in DB and renders on the strategy landing page: equity curve, full trades log, exit reasons, real-time P&L. Subscribers can verify every trade down to the tick.',
        },
      ],
    },
    strategiesPreview: {
      title: 'Active strategies',
      subtitle:
        'Each strategy has its own landing page — equity curve, full trade log, live results. Numbers are recomputed for our $1000 position size with Bybit commission included.',
      seeAll: 'All strategies →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'NOW',
          done: true,
          title: '🚀 Growing the portfolio of verified LuxAlgo strategies. Each gets its own landing page and live stats.',
        },
        {
          when: 'JULY 2026',
          done: false,
          title: 'Bybit live for top-performing strategies. Small size to validate execution.',
        },
        {
          when: 'AUGUST 2026',
          done: false,
          title: 'Hyperliquid Vault — parallel channel for on-chain copy traders.',
        },
        {
          when: 'Q4 2026',
          done: false,
          title: 'Bybit Copy Trading — open follower onboarding after 90 days of live history.',
        },
      ],
    },
    faq: {
      title: 'FAQ',
      items: [
        {
          q: 'Where do the strategies come from?',
          a: 'All strategies are built in LuxAlgo AI Strategy Builder — a recognized platform for multi-condition strategies with automated backtesting. Each strategy includes a link to its original LuxAlgo chat on its detail page for verification.',
        },
        {
          q: 'What is the risk management?',
          a: 'Every strategy has a safety stop-loss (typically 2-3% from entry) as backup in case webhooks are delayed. Position size fixed at $1000 per trade. Max 1 position per (symbol × strategy). Exits are entirely strategy-driven — no manual intervention.',
        },
        {
          q: 'Where can I see live results?',
          a: 'Main dashboard at /strategies grouped by timeframe. At /strategies/<code> — per-strategy detail with equity curve, full trades log, long/short breakdown. Auto-refreshes every 60 seconds.',
        },
        {
          q: 'What if a strategy is in drawdown?',
          a: 'First we assess — market anomaly vs broken edge. After 10+ losses in a row → automatic pause. Followers can disconnect anytime (Bybit Copy) or exit the Vault.',
        },
        {
          q: 'What fees are factored in?',
          a: 'Bybit perp taker: 0.055% × 2 (open + close) = 0.11% round-trip. Hyperliquid: 0.025% × 2 = 0.05%. These fees are deducted on every trade in our backtests — landing page numbers are honest.',
        },
        {
          q: 'Are my funds safe?',
          a: 'Bybit Copy Trading uses your own account — we never have access to your funds. Hyperliquid Vault runs on smart contracts with deposit/withdraw on demand. We only earn a percentage of profits.',
        },
      ],
    },
    ctaSection: {
      title: 'Follow progress',
      subtitle:
        'Every open and close lands in the Telegram channel in real-time with a T# ID and a direct link to the detail page.',
      telegram: 'Telegram channel',
      strategies: 'All strategies',
    },
    telegramUrl: 'https://t.me/luxalgosignal',
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

function fmtUsd(n: number, withSign = false): string {
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function classForValue(n: number): 'pos' | 'neg' | 'neu' {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return 'neu';
}

function renderHome(lang: Lang): string {
  const c = CONTENT[lang];
  const otherLang: Lang = lang === 'ru' ? 'en' : 'ru';
  const otherLangPath = otherLang === 'ru' ? '/' : '/en';

  // ---------- Live portfolio stats ----------
  let totalClosed = 0;
  let totalPnlUsd = 0;
  let bestBacktestWr = 0;
  const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
  for (const s of enabled) {
    const live = getStrategyLiveStats(s.id);
    totalClosed += live.closed;
    totalPnlUsd += live.netPnlUsd;
    if (s.backtest && s.backtest.winRate > bestBacktestWr) {
      bestBacktestWr = s.backtest.winRate;
    }
  }
  const pnlCls = classForValue(totalPnlUsd);

  // ---------- Top 5 strategy preview ----------
  const previewItems = enabled
    .map((s) => {
      const live = getStrategyLiveStats(s.id);
      const bt = s.backtest;
      const btLabel = bt
        ? `BT: ${(bt.winRate * 100).toFixed(1)}% WR · ${bt.netPnlPct >= 0 ? '+' : ''}${bt.netPnlPct.toFixed(1)}%`
        : '';
      const liveCls = classForValue(live.netPnlUsd);
      const liveLabel =
        live.closed > 0
          ? `<span class="${liveCls}">${fmtUsd(live.netPnlUsd, true)}</span>`
          : `<span style="color: var(--text-faint)">${lang === 'en' ? 'waiting' : 'ждём сигнал'}</span>`;
      return `
        <a href="/strategies/${escapeHtml(s.code)}" class="strategy-preview-link">
          <div>
            <div class="strategy-preview-name">[STRAT-${escapeHtml(s.code)}] ${escapeHtml(s.symbol ?? 'ANY')} ${escapeHtml(s.timeframe)}m</div>
            <div class="strategy-preview-meta">${btLabel}</div>
          </div>
          <div class="strategy-preview-right">
            <div>${liveLabel}</div>
            <div class="strategy-preview-meta">${live.closed} ${lang === 'en' ? 'closed' : 'закрытых'}</div>
          </div>
        </a>`;
    })
    .slice(0, 5)
    .join('');

  // ---------- Hero with animated SVG equity curve as background ----------
  // The squiggly line is a hand-crafted SVG path mimicking a real equity
  // curve. stroke-dasharray animation makes it "draw itself" on page load.
  // Plus two gradient blobs that drift slowly for ambient depth.
  const heroHtml = `
    <div class="hero">
      <div class="hero-bg" aria-hidden="true">
        <div class="blob blob-1"></div>
        <div class="blob blob-2"></div>
        <svg class="hero-equity" viewBox="0 0 1200 300" preserveAspectRatio="none">
          <defs>
            <linearGradient id="hero-line-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.1"/>
              <stop offset="50%" stop-color="var(--accent)" stop-opacity="0.65"/>
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="1"/>
            </linearGradient>
          </defs>
          <path class="hero-equity-line"
                d="M0,250 C80,240 130,260 180,235 C230,210 280,250 340,200 C400,160 460,210 520,180 C580,150 640,170 700,130 C760,90 820,140 880,110 C940,80 990,100 1050,70 C1110,40 1170,55 1200,30"
                fill="none"
                stroke="url(#hero-line-grad)"
                stroke-width="2.5"
                stroke-linecap="round"/>
        </svg>
      </div>
      <div class="hero-content">
        <span class="hero-eyebrow">${escapeHtml(c.hero.eyebrow)}</span>
        <h1 class="hero-title">
          ${escapeHtml(c.hero.title1)}<span class="accent">${escapeHtml(c.hero.titleAccent)}</span>${escapeHtml(c.hero.title2)}
        </h1>
        <p class="hero-subtitle">${escapeHtml(c.hero.subtitle)}</p>
        <div class="hero-cta">
          <a class="btn btn-primary" href="/strategies">${escapeHtml(c.hero.ctaPrimary)}</a>
          <a class="btn btn-ghost" href="${escapeHtml(c.telegramUrl)}" target="_blank" rel="noopener">
            ${escapeHtml(c.hero.ctaSecondary)}
          </a>
          <a class="btn btn-link-out" href="https://www.luxalgo.com/" target="_blank" rel="noopener">
            ⚡ ${lang === 'en' ? 'Powered by LuxAlgo' : 'Powered by LuxAlgo'} ↗
          </a>
        </div>
      </div>
    </div>
  `;
  // Live strip intentionally removed per operator request (May 2026):
  // numbers belonged on /strategies, not on the marketing front page.
  // Local refs preserved to avoid touching the lambda below.
  void enabled; void totalClosed; void totalPnlUsd; void bestBacktestWr; void pnlCls;

  // ---------- How it works ----------
  const howHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(c.how.title)}</h2>
      <p class="home-section-sub">${escapeHtml(c.how.subtitle)}</p>
      <div class="how-grid">
        ${c.how.steps
          .map(
            (s) => `
          <div class="how-card">
            <div class="how-step">${escapeHtml(s.step)}</div>
            <h3 class="how-title">${escapeHtml(s.title)}</h3>
            <p class="how-body">${escapeHtml(s.body)}</p>
          </div>
        `,
          )
          .join('')}
      </div>
    </div>
  `;

  // ---------- Strategies preview ----------
  const strategiesPreviewHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(c.strategiesPreview.title)}</h2>
      <p class="home-section-sub">${escapeHtml(c.strategiesPreview.subtitle)}</p>
      <div class="strategy-preview-list">
        ${previewItems || `<div class="empty-state">${lang === 'en' ? 'No active strategies yet.' : 'Активных стратегий пока нет.'}</div>`}
      </div>
      <div style="margin-top: 14px;">
        <a class="btn btn-ghost" href="/strategies">${escapeHtml(c.strategiesPreview.seeAll)}</a>
      </div>
    </div>
  `;

  // ---------- Roadmap ----------
  const roadmapHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(c.roadmap.title)}</h2>
      <ul class="roadmap-list">
        ${c.roadmap.items
          .map(
            (r) => `
          <li class="roadmap-item">
            <span class="roadmap-status ${r.done ? 'done' : 'todo'}">${r.done ? '✓' : '○'}</span>
            <div class="roadmap-meta">
              <span class="roadmap-when">${escapeHtml(r.when)}</span>
              <span class="roadmap-title">${escapeHtml(r.title)}</span>
            </div>
          </li>
        `,
          )
          .join('')}
      </ul>
    </div>
  `;

  // ---------- FAQ ----------
  const faqHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(c.faq.title)}</h2>
      <div class="faq-list">
        ${c.faq.items
          .map(
            (f) => `
          <details class="faq-item">
            <summary>${escapeHtml(f.q)}</summary>
            <div class="faq-answer">${escapeHtml(f.a)}</div>
          </details>
        `,
          )
          .join('')}
      </div>
    </div>
  `;

  // ---------- CTA section ----------
  const ctaHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(c.ctaSection.title)}</h2>
      <p class="home-section-sub">${escapeHtml(c.ctaSection.subtitle)}</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="${escapeHtml(c.telegramUrl)}" target="_blank" rel="noopener">
          ${escapeHtml(c.ctaSection.telegram)} ↗
        </a>
        <a class="btn btn-ghost" href="/strategies">${escapeHtml(c.ctaSection.strategies)}</a>
      </div>
    </div>
  `;

  // ---------- Top-right nav (Support + RU/EN toggle) ----------
  const supportLabel = lang === 'en' ? '💬 Support' : '💬 Поддержка';
  const topRight = `
    <a href="https://t.me/dboykod" class="nav-link" target="_blank" rel="noopener" title="${supportLabel}">${supportLabel}</a>
    <a href="/" class="${lang === 'ru' ? 'active' : ''}">RU</a>
    <a href="/en" class="${lang === 'en' ? 'active' : ''}">EN</a>
  `;

  const body = `
    ${heroHtml}
    ${howHtml}
    ${strategiesPreviewHtml}
    ${roadmapHtml}
    ${faqHtml}
    ${ctaHtml}
  `;

  // Use _ for the unused param suppression
  void otherLangPath;
  void TRACK_C_NOTIONAL_USD;

  return pageShell(c.htmlTitle, body, lang, topRight);
}

export async function homeRoute(app: FastifyInstance): Promise<void> {
  // Russian (default) home
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    return renderHome('ru');
  });

  // English variant
  app.get('/en', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    return renderHome('en');
  });
}

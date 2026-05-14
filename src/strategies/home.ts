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
    htmlTitle: 'Robot Claude — автоматизированные торговые стратегии',
    hero: {
      eyebrow: 'SHADOW MODE · BYBIT USDT-PERP',
      title1: 'Автоматизированные ',
      titleAccent: 'торговые стратегии',
      title2: ' на крипто-фьючерсах',
      subtitle:
        'Сигналы из LuxAlgo AI Strategy Builder исполняются в нашей системе автоматически и логируются в реальном времени. Каждая сделка публична и проверяема.',
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
      subtitle: 'Технический пайплайн от сигнала до сделки и до отчёта.',
      steps: [
        {
          step: 'STEP 01',
          title: 'LuxAlgo AI Strategy Builder',
          body: 'Стратегии собираются в признанной платформе LuxAlgo Premium. Multi-condition (Contrarian + Trend Tracer + Money Flow и др.) с встроенным бектестом и динамическими выходами.',
        },
        {
          step: 'STEP 02',
          title: 'Webhook → наша система',
          body: 'TradingView Alert по сигналу стратегии отправляет JSON в наш Fastify-сервер. Дедупликация, валидация, маршрутизация в обработчик за <100ms.',
        },
        {
          step: 'STEP 03',
          title: 'Bybit / Hyperliquid execution',
          body: 'Market entry с safety stop-loss. Выходы — либо по обратному сигналу стратегии (Builtin Exits), либо по 24-часовому time-guard, либо по safety SL.',
        },
        {
          step: 'STEP 04',
          title: 'Публичный учёт',
          body: 'Каждая сделка летит в SQLite и рендерится на лендинге стратегии: equity curve, trades log, exit reasons. Никаких чёрных ящиков.',
        },
      ],
    },
    strategiesPreview: {
      title: 'Активные стратегии',
      subtitle:
        'Все стратегии работают в shadow mode — собирают live статистику до перехода на реальное исполнение. Лучшие переедут на Bybit live в первую очередь.',
      seeAll: 'Все стратегии →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'МАЙ 2026',
          done: true,
          title: 'Shadow trading запущен. Первая стратегия BNB 15m работает.',
        },
        {
          when: 'ИЮНЬ 2026',
          done: false,
          title: 'Расширение портфеля до 5-10 стратегий разных TF и символов.',
        },
        {
          when: 'ИЮЛЬ 2026',
          done: false,
          title: 'Bybit live — малый размер ($200-500), одна-две лучшие стратегии.',
        },
        {
          when: 'АВГУСТ 2026',
          done: false,
          title: 'Hyperliquid Vault — параллельный канал для copy traders.',
        },
        {
          when: 'ОСЕНЬ 2026',
          done: false,
          title: 'Bybit Copy Trading — после 90 дней live истории. Открытый набор followers.',
        },
      ],
    },
    faq: {
      title: 'FAQ',
      items: [
        {
          q: 'Когда можно будет подключиться к копи-трейдингу?',
          a: 'После 90 дней live истории на Bybit mainnet. По плану — осень 2026. Hyperliquid Vault может стартовать раньше (август 2026) — там barrier ниже.',
        },
        {
          q: 'Какой риск-менеджмент?',
          a: 'Каждая стратегия имеет safety stop-loss (обычно 2-3% от entry). Размер позиции фиксированный $1000 notional на сделку. Max 1 позиция на (символ × стратегия). 24-часовой time-guard принудительно закрывает зависшие позиции.',
        },
        {
          q: 'Где смотреть live результаты?',
          a: 'На /strategies — общий dashboard. На /strategies/<code> — детальная страница каждой стратегии с equity curve, trades log, breakdown по long/short. Обновляется автоматически из БД.',
        },
        {
          q: 'Что если стратегия в просадке?',
          a: 'Сначала пытаемся понять — рыночная аномалия или сломанный edge. Если 10+ убыточных сделок подряд → автоматический pause через kill-switch. Followers могут отключиться в любой момент (Bybit Copy) или выйти из Vault.',
        },
        {
          q: 'Какие комиссии?',
          a: 'Bybit perp taker: 0.055% × 2 (открытие+закрытие) = 0.11% круговая. Hyperliquid: 0.025% × 2 = 0.05%. В наших бектестах эти комиссии уже учтены — числа на лендингах реалистичные.',
        },
        {
          q: 'Какие максимальные открытые позиции?',
          a: 'Текущий проект — Track C (LuxAlgo strategies). Каждая стратегия открывает максимум 1 позицию на символ. С 10 активными стратегиями и 5 уникальными символами — максимум 10 позиций одновременно (capped на уровне риск-менеджмента).',
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
    htmlTitle: 'Robot Claude — automated trading strategies',
    hero: {
      eyebrow: 'SHADOW MODE · BYBIT USDT-PERP',
      title1: 'Automated ',
      titleAccent: 'trading strategies',
      title2: ' on crypto perpetuals',
      subtitle:
        'Signals from LuxAlgo AI Strategy Builder execute in our system automatically and log in real-time. Every trade is public and auditable.',
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
      subtitle: 'Technical pipeline from signal to execution to public report.',
      steps: [
        {
          step: 'STEP 01',
          title: 'LuxAlgo AI Strategy Builder',
          body: 'Strategies are assembled in the LuxAlgo Premium platform. Multi-condition logic (Contrarian + Trend Tracer + Money Flow, etc.) with embedded backtest and dynamic exits.',
        },
        {
          step: 'STEP 02',
          title: 'Webhook → our system',
          body: 'TradingView Alert from the strategy posts JSON to our Fastify server. Dedup, validate, route to handler within <100ms.',
        },
        {
          step: 'STEP 03',
          title: 'Bybit / Hyperliquid execution',
          body: 'Market entry with safety stop-loss. Exits triggered by reverse strategy signal (built-in exits), 24-hour time-guard, or safety SL.',
        },
        {
          step: 'STEP 04',
          title: 'Public audit trail',
          body: 'Every trade lands in SQLite and renders on the strategy landing page: equity curve, trades log, exit reasons. No black boxes.',
        },
      ],
    },
    strategiesPreview: {
      title: 'Active strategies',
      subtitle:
        'All strategies run in shadow mode — collecting live stats before promotion to real execution. The best performers migrate to Bybit live first.',
      seeAll: 'All strategies →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'MAY 2026',
          done: true,
          title: 'Shadow trading deployed. First strategy BNB 15m is running.',
        },
        {
          when: 'JUNE 2026',
          done: false,
          title: 'Portfolio expansion to 5-10 strategies across timeframes and symbols.',
        },
        {
          when: 'JULY 2026',
          done: false,
          title: 'Bybit live — small size ($200-500), top one or two strategies.',
        },
        {
          when: 'AUGUST 2026',
          done: false,
          title: 'Hyperliquid Vault — parallel channel for copy traders.',
        },
        {
          when: 'FALL 2026',
          done: false,
          title: 'Bybit Copy Trading — after 90 days of live history. Open follower onboarding.',
        },
      ],
    },
    faq: {
      title: 'FAQ',
      items: [
        {
          q: 'When can I copy-trade?',
          a: 'After 90 days of live Bybit mainnet history. Planned for fall 2026. Hyperliquid Vault can start earlier (August 2026) — lower platform barrier.',
        },
        {
          q: 'What is the risk management?',
          a: 'Every strategy has a safety stop-loss (typically 2-3% from entry). Position size fixed at $1000 notional per trade. Max 1 position per (symbol × strategy). 24-hour time-guard force-closes stuck positions.',
        },
        {
          q: 'Where can I see live results?',
          a: 'At /strategies — overall dashboard. At /strategies/<code> — per-strategy detail with equity curve, trades log, long/short breakdown. Auto-refreshed from DB.',
        },
        {
          q: 'What if a strategy is in drawdown?',
          a: 'First we assess — market anomaly vs broken edge. After 10+ losses in a row → automatic pause via kill-switch. Followers can disconnect anytime (Bybit Copy) or exit the Vault.',
        },
        {
          q: 'What are the fees?',
          a: 'Bybit perp taker: 0.055% × 2 (open + close) = 0.11% round-trip. Hyperliquid: 0.025% × 2 = 0.05%. These fees are already factored into our backtests — landing page numbers are realistic.',
        },
        {
          q: 'How many concurrent positions?',
          a: 'Current project — Track C (LuxAlgo strategies). Each strategy opens max 1 position per symbol. With 10 active strategies and 5 unique symbols — max 10 concurrent positions (capped at the risk-management layer).',
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

  // ---------- Hero ----------
  const heroHtml = `
    <div class="hero">
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
      </div>
    </div>
  `;

  // ---------- Live strip ----------
  const liveStripHtml = `
    <div class="live-strip">
      <div class="live-strip-item">
        <span class="live-strip-label">${escapeHtml(c.liveStrip.strategies)}</span>
        <span class="live-strip-value">${enabled.length}</span>
      </div>
      <span class="live-strip-sep">·</span>
      <div class="live-strip-item">
        <span class="live-strip-label">${escapeHtml(c.liveStrip.livePnl)}</span>
        <span class="live-strip-value ${pnlCls}">${fmtUsd(totalPnlUsd, true)}</span>
      </div>
      <span class="live-strip-sep">·</span>
      <div class="live-strip-item">
        <span class="live-strip-label">${escapeHtml(c.liveStrip.liveTrades)}</span>
        <span class="live-strip-value">${totalClosed}</span>
      </div>
      <span class="live-strip-sep">·</span>
      <div class="live-strip-item">
        <span class="live-strip-label">${escapeHtml(c.liveStrip.bestWr)}</span>
        <span class="live-strip-value">${bestBacktestWr > 0 ? (bestBacktestWr * 100).toFixed(1) + '%' : '—'}</span>
      </div>
    </div>
  `;

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

  // ---------- Top-right language toggle ----------
  const topRight = `
    <a href="/" class="${lang === 'ru' ? 'active' : ''}">RU</a>
    <a href="/en" class="${lang === 'en' ? 'active' : ''}">EN</a>
  `;

  const body = `
    ${heroHtml}
    ${liveStripHtml}
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

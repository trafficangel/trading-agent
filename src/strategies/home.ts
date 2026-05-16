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
  whatYouGet: {
    title: string;
    items: string[];
  };
  signalPreview: {
    title: string;
    subtitle: string;
    entryLabel: string;
    closeLabel: string;
    timeBetween: string;
    cta: string;
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
    htmlTitle: 'Robot Claude — проверенные стратегии и сигналы 24/7',
    hero: {
      eyebrow: '🆓 БЕСПЛАТНО · АВТОМАТИЧЕСКАЯ ТОРГОВЛЯ 24/7',
      title1: 'Проверенные ',
      titleAccent: 'стратегии и сигналы',
      title2: ' для криптотрейдинга',
      subtitle:
        'Каждая стратегия проходит тщательный отбор по результатам тестирования за 200+ дней. '
        + 'Наша система автоматически открывает и закрывает позиции на бирже круглосуточно, '
        + 'а все сигналы дублируются в Telegram канале — можете торговать вместе с нами или сами. '
        + 'Все сделки публичны в реальном времени. Без подписок и платных уровней.',
      ctaPrimary: 'Активные стратегии →',
      ctaSecondary: 'Telegram канал ↗',
    },
    liveStrip: {
      strategies: 'Стратегий',
      livePnl: 'Live P&L',
      liveTrades: 'Live сделок',
      bestWr: 'Лучший WR backtest',
    },
    whatYouGet: {
      title: 'Что вы получаете — бесплатно',
      items: [
        '🆓 Полный доступ ко всем стратегиям и их статистике',
        '📊 Live результаты каждой сделки в реальном времени',
        '📡 Сигналы в Telegram канале — вход, выход, стоп',
        '🤖 Автоматическое исполнение на бирже (для подписчиков копитрейдинга)',
        '🔓 Никаких подписок, премиум-уровней или скрытых платежей',
        '💼 Прозрачный учёт — каждая сделка публична и проверяема',
      ],
    },
    signalPreview: {
      title: 'Как выглядят сигналы в Telegram',
      subtitle: 'Каждое открытие и закрытие сделки приходит в канал автоматически — с ценой, размером и причиной выхода. Можете повторять за нами вручную или ждать запуска копитрейдинга.',
      entryLabel: 'Вход в позицию',
      closeLabel: 'Закрытие позиции',
      timeBetween: '↓ через 2 часа',
      cta: 'Подписаться на канал ↗',
    },
    how: {
      title: 'Как это работает',
      subtitle: 'Простой путь от сигнала до сделки — и публичный отчёт о каждом результате.',
      steps: [
        {
          step: 'ШАГ 01',
          title: 'Двухэтапный отбор',
          body:
            'Сначала собираем стратегию в [LuxAlgo Premium Ultimate](https://www.luxalgo.com/pricing/) с тестом на 200+ дней. ' +
            'Если winrate ≥55% и прибыль превышает убытки в 2 раза — переходим ко второму этапу: проверяем в [TradingView Premium](https://ru.tradingview.com/pricing/) с реальной комиссией Bybit и защитным стопом. ' +
            'Только стратегии прошедшие обе проверки попадают на сайт.',
        },
        {
          step: 'ШАГ 02',
          title: 'Сигнал → автоматическая сделка',
          body: 'Когда стратегия выдаёт сигнал, наша система мгновенно открывает позицию на бирже с защитным стопом. Сделка ведётся автоматически до выхода — без вашего участия. Работаем круглосуточно, 7 дней в неделю.',
        },
        {
          step: 'ШАГ 03',
          title: 'Дублирование в Telegram',
          body: 'Каждый сигнал — вход, выход, стоп — публикуется в нашем Telegram-канале. Если хотите торговать вручную на своём счёте — просто повторяйте за нами. Если хотите присоединиться к копитрейдингу — оставляйте номер на сайте.',
        },
        {
          step: 'ШАГ 04',
          title: 'Полный публичный учёт',
          body: 'Каждая сделка отображается на странице стратегии: время входа, цена выхода, прибыль или убыток. Никаких чёрных ящиков и закрытой статистики — можете проверить каждый результат сами.',
        },
      ],
    },
    strategiesPreview: {
      title: 'Активные стратегии',
      subtitle:
        'Для каждой стратегии — отдельная страница: график доходности, полный список сделок и результаты в реальном времени. Числа пересчитаны на нашу позицию $1000 с учётом комиссии Bybit.',
      seeAll: 'Все стратегии →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'СЕЙЧАС',
          done: true,
          title: '🚀 Расширение портфеля проверенных LuxAlgo стратегий. Каждая со своей отдельной страницей и статистикой в реальном времени.',
        },
        {
          when: 'ИЮЛЬ 2026',
          done: false,
          title: 'Подключение реальной торговли на Bybit для лучших стратегий. Начнём с малого размера — обкатать исполнение.',
        },
        {
          when: 'АВГУСТ 2026',
          done: false,
          title: 'Hyperliquid Vault — параллельный канал для тех кто хочет копировать через смарт-контракт.',
        },
        {
          when: 'Q4 2026',
          done: false,
          title: 'Bybit Copy Trading — открытый набор подписчиков после 90 дней реальной торговли.',
        },
      ],
    },
    faq: {
      title: 'Частые вопросы',
      items: [
        {
          q: 'Это правда бесплатно? Почему?',
          a:
            'Да, полностью. Сайт, статистика, Telegram-канал — бесплатно для всех.\n\n' +
            'А нам содержание системы обходится примерно в $230 в месяц:\n' +
            '- [LuxAlgo Premium Ultimate](https://www.luxalgo.com/pricing/) — ~$60/мес, сборка стратегий в AI Builder\n' +
            '- [TradingView Premium](https://ru.tradingview.com/pricing/) — ~$60/мес, контрольные бэктесты с реальной комиссией Bybit\n' +
            '- [Claude Code](https://claude.com/product/claude-code) — ~$100/мес, AI для разработки системы и анализа результатов сделок\n' +
            '- Сервер, домен и инфраструктура — ~$10/мес\n\n' +
            'Зачем тогда отдаём бесплатно? В ближайшее время запустим копитрейдинг на Bybit — там наш доход будет только процентом от вашей прибыли. ' +
            'Если стратегии действительно работают, через 3-6 месяцев у нас будет публичная статистика и подписчики которые ХОТЯТ копировать наши сделки. ' +
            'Это честнее чем продавать «курсы по трейдингу» — мы зарабатываем только когда вы зарабатываете.',
        },
        {
          q: 'Откуда берутся стратегии?',
          a: 'Все стратегии собираются в LuxAlgo AI Strategy Builder — это признанная платформа для тестирования торговых идей. Каждая стратегия имеет публичную ссылку на оригинал на странице стратегии — вы можете проверить её сами.',
        },
        {
          q: 'Как контролируется риск?',
          a: 'Каждая стратегия имеет защитный стоп-лосс (обычно 2-3% от цены входа) — это страховка на случай резкого движения. Размер позиции фиксированный — 1000 долларов на сделку. На один символ и одну стратегию открыта максимум одна позиция одновременно.',
        },
        {
          q: 'Где смотреть результаты?',
          a: 'На странице «Активные стратегии» — общий список со статистикой по каждой. На странице конкретной стратегии — график доходности, полный список всех сделок, разбивка лонг/шорт. Данные обновляются автоматически каждые 60 секунд.',
        },
        {
          q: 'Сигналы в Telegram-канале платные?',
          a: 'Нет. Все сигналы публикуются в нашем канале @luxalgosignal — это бесплатно и доступно всем. Каждое открытие и закрытие сделки приходит в канал с указанием цены, размера и причины выхода. Можете повторять за нами вручную или дождаться запуска копитрейдинга.',
        },
        {
          q: 'Что если стратегия в просадке?',
          a: 'Сначала разбираемся — рыночная аномалия или стратегия сломалась. Если 10 убыточных сделок подряд — стратегия автоматически ставится на паузу. В копитрейдинге вы сможете отключиться в любой момент.',
        },
        {
          q: 'Безопасны ли мои деньги в копитрейдинге?',
          a: 'Когда мы запустим копитрейдинг на Bybit — он работает на вашем собственном аккаунте. Мы не имеем доступа к вашим средствам, только к функции копирования сделок. На Hyperliquid Vault — работает на смарт-контракте, депозит и вывод по запросу.',
        },
        {
          q: 'Какие комиссии биржи учитываются?',
          a: 'В наших расчётах уже вычтена комиссия Bybit — 0.055% × 2 стороны = 0.11% за круг сделки. Цифры на сайте — реалистичные, такие же получите и вы при торговле.',
        },
      ],
    },
    ctaSection: {
      title: 'Следить за прогрессом',
      subtitle:
        'Каждая открытая и закрытая сделка публикуется в Telegram канал в реальном времени с номером T# и ссылкой на страницу стратегии.',
      telegram: 'Telegram канал',
      strategies: 'Все стратегии',
    },
    telegramUrl: 'https://t.me/luxalgosignal',
  },
  en: {
    htmlTitle: 'Robot Claude — verified trading strategies & signals 24/7',
    hero: {
      eyebrow: '🆓 FREE · AUTOMATED TRADING 24/7',
      title1: 'Verified ',
      titleAccent: 'strategies & signals',
      title2: ' for crypto trading',
      subtitle:
        'Each strategy is rigorously vetted against 200+ days of historical data. '
        + 'Our system opens and closes positions on the exchange automatically around the clock, '
        + 'and every signal is duplicated to our Telegram channel — trade alongside us or follow manually. '
        + 'All trades are public in real-time. No subscriptions, no paid tiers.',
      ctaPrimary: 'View strategies →',
      ctaSecondary: 'Telegram channel ↗',
    },
    liveStrip: {
      strategies: 'Strategies',
      livePnl: 'Live P&L',
      liveTrades: 'Live trades',
      bestWr: 'Best backtest WR',
    },
    whatYouGet: {
      title: 'What you get — free',
      items: [
        '🆓 Full access to all strategies and their stats',
        '📊 Live results from every trade in real-time',
        '📡 Signals in our Telegram channel — entry, exit, stop',
        '🤖 Automatic execution on the exchange (for copy traders)',
        '🔓 No subscriptions, no premium tiers, no hidden charges',
        '💼 Transparent accounting — every trade public and verifiable',
      ],
    },
    signalPreview: {
      title: 'What signals look like in Telegram',
      subtitle: 'Every entry and close arrives in the channel automatically — with price, size, and exit reason. Follow manually or wait for copy trading to launch.',
      entryLabel: 'Position opened',
      closeLabel: 'Position closed',
      timeBetween: '↓ 2 hours later',
      cta: 'Subscribe to channel ↗',
    },
    how: {
      title: 'How it works',
      subtitle: 'Simple path from signal to trade — with a public record of every outcome.',
      steps: [
        {
          step: 'STEP 01',
          title: 'Two-stage vetting',
          body:
            'First we build the strategy in [LuxAlgo Premium Ultimate](https://www.luxalgo.com/pricing/) with a 200+ day backtest. ' +
            'If win rate ≥55% and profits are at least 2× larger than losses, we move to stage two: re-test in [TradingView Premium](https://www.tradingview.com/pricing/) with realistic Bybit commission and a safety stop. ' +
            'Only strategies passing both stages make it onto the site.',
        },
        {
          step: 'STEP 02',
          title: 'Signal → automatic trade',
          body: 'When a strategy fires, our system instantly opens a position on the exchange with a protective stop. The trade runs autonomously until exit — no manual touch. Running 24/7, every day.',
        },
        {
          step: 'STEP 03',
          title: 'Mirrored to Telegram',
          body: 'Every signal — entry, exit, stop — is posted to our Telegram channel. Trade manually on your own account by copying us, or join the upcoming copy-trading service.',
        },
        {
          step: 'STEP 04',
          title: 'Full public record',
          body: 'Every trade appears on its strategy page: entry time, exit price, profit or loss. No black boxes, no hidden stats — verify every result yourself.',
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
      title: 'Frequently asked',
      items: [
        {
          q: 'Is it really free? Why?',
          a:
            'Yes, completely. The site, statistics, Telegram channel — free for everyone.\n\n' +
            'Running this system costs us about $230/month:\n' +
            '- [LuxAlgo Premium Ultimate](https://www.luxalgo.com/pricing/) — ~$60/mo, strategy building in AI Builder\n' +
            '- [TradingView Premium](https://www.tradingview.com/pricing/) — ~$60/mo, control backtests with realistic Bybit commission\n' +
            '- [Claude Code](https://claude.com/product/claude-code) — ~$100/mo, AI for system development and trade-result analysis\n' +
            '- Server, domain, infrastructure — ~$10/mo\n\n' +
            'Why give it away free? We\'re launching copy trading on Bybit soon — our revenue will come solely from a percentage of YOUR profits. ' +
            'If the strategies genuinely work, in 3-6 months we\'ll have public statistics and subscribers who WANT to copy our trades. ' +
            'More honest than selling "trading courses" — we only earn when you earn.',
        },
        {
          q: 'Where do the strategies come from?',
          a: 'All strategies are built in LuxAlgo AI Strategy Builder — a recognized platform for testing trading ideas. Each strategy has a public link to its source on its detail page — you can verify it yourself.',
        },
        {
          q: 'How is risk controlled?',
          a: 'Each strategy has a protective stop-loss (typically 2-3% from entry price) as backup against sharp moves. Position size is fixed at $1000 per trade. Max one position per symbol × strategy at any time.',
        },
        {
          q: 'Where can I see results?',
          a: 'On the "Active strategies" page — overall list with stats. On each strategy\'s page — equity curve, full trade log, long/short breakdown. Data refreshes automatically every 60 seconds.',
        },
        {
          q: 'Are signals in the Telegram channel paid?',
          a: 'No. All signals are published to our channel @luxalgosignal — free and accessible to anyone. Every open and close arrives with price, size, and exit reason. Follow us manually, or wait for copy trading launch.',
        },
        {
          q: 'What if a strategy is in drawdown?',
          a: 'First we assess — market anomaly or broken edge. After 10 losing trades in a row, the strategy auto-pauses. In copy trading, you can disconnect anytime.',
        },
        {
          q: 'Are my funds safe in copy trading?',
          a: 'When we launch copy trading on Bybit, it runs on your own account — we never have access to your funds, only to the copying feature. Hyperliquid Vault works via smart contracts with deposit/withdraw on demand.',
        },
        {
          q: 'What exchange fees are included?',
          a: 'Our numbers already deduct Bybit fees — 0.055% × 2 sides = 0.11% round-trip per trade. The figures on the site are realistic — same as what you\'ll get trading along with us.',
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

/** Russian plural selector — same impl as landing.ts. Kept local to
 *  avoid an extra import for a 5-line helper. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// Escapes HTML THEN converts a tiny subset of markdown into HTML for
// content fields where we want safe-by-default text + a few inline
// formatting affordances:
//   - [label](https://...)        → outbound link (rel="noopener nofollow")
//   - lines starting with "- "    → grouped into <ul><li>…</li></ul>
//   - blank line                  → paragraph break (rendered as <br><br>)
// XSS-safe because everything is escaped FIRST, then we re-interpret a
// strict subset of patterns. URLs are http(s)-only.
//
// Callers should render the result inside a <div>, not a <p> — a <ul>
// or <br> in a paragraph is invalid HTML in some validators.
function renderRichText(s: string): string {
  const escaped = escapeHtml(s);
  const withLinks = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener nofollow">${label}</a>`,
  );
  // Group "- ..." lines into a single <ul>. Other lines pass through;
  // blank lines become <br><br> paragraph breaks.
  const lines = withLinks.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^- /.test(trimmed)) {
      if (!inList) { out.push('<ul class="rich-list">'); inList = true; }
      out.push(`<li>${trimmed.slice(2)}</li>`);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      if (trimmed === '') out.push('<br><br>');
      else out.push(line);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
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
  // Sort enabled strategies by launch date ASCENDING (oldest first).
  // The home-page preview block is capped at 5 below — older strategies
  // get the prime real estate; once we have >5 active, the newest ones
  // overflow to the dedicated /strategies index page.
  const enabled = Object.values(STRATEGY_CONFIGS)
    .filter((s) => s.enabled)
    .sort((a, b) => a.launchedAt - b.launchedAt);
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
  // Layout:
  //   Left  → [STRAT-00X] SYMBOL TFm
  //           Human-readable backtest summary (win-rate + return + period)
  //   Right → Live PnL (only when there are closed trades — empty otherwise
  //           to avoid the "ждём сигнал / 0 закрытых" visual noise before
  //           the strategy has produced live data)
  const previewItems = enabled
    .map((s) => {
      const live = getStrategyLiveStats(s.id);
      const bt = s.backtest;
      // Plain-Russian backtest summary. WR / PF / % are jargon for most
      // visitors — spell it out and add the period so the number means
      // something concrete instead of just being "a big positive number".
      const btLabel = bt
        ? lang === 'en'
          ? `${(bt.winRate * 100).toFixed(1)}% wins · ${bt.netPnlPct >= 0 ? '+' : ''}${bt.netPnlPct.toFixed(1)}% return over ${bt.periodDays} days`
          : `${(bt.winRate * 100).toFixed(1)}% прибыльных сделок · доходность ${bt.netPnlPct >= 0 ? '+' : ''}${bt.netPnlPct.toFixed(1)}% за ${bt.periodDays} ${pluralRu(bt.periodDays, 'день', 'дня', 'дней')}`
        : '';
      // Right column appears ONLY once the strategy has closed trades.
      // Before then the row is left-aligned and uncluttered.
      const rightBlock =
        live.closed > 0
          ? `<div class="strategy-preview-right">
              <div><span class="${classForValue(live.netPnlUsd)}">${fmtUsd(live.netPnlUsd, true)}</span></div>
              <div class="strategy-preview-meta">${live.closed} ${lang === 'en' ? 'closed trades' : live.closed === 1 ? 'закрытая сделка' : 'закрытых сделок'}</div>
            </div>`
          : '';
      return `
        <a href="/strategies/${escapeHtml(s.code)}" class="strategy-preview-link">
          <div>
            <div class="strategy-preview-name">[STRAT-${escapeHtml(s.code)}] ${escapeHtml(s.symbol ?? 'ANY')} ${escapeHtml(s.timeframe)}m</div>
            <div class="strategy-preview-meta">${btLabel}</div>
          </div>
          ${rightBlock}
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

  // ---------- What you get (free + Telegram emphasis) ----------
  const whatYouGetHtml = `
    <div class="home-section what-you-get">
      <h2 class="home-section-title">${escapeHtml(c.whatYouGet.title)}</h2>
      <div class="benefit-grid">
        ${c.whatYouGet.items
          .map((item) => `<div class="benefit-item">${escapeHtml(item)}</div>`)
          .join('')}
      </div>
    </div>
  `;

  // ---------- Telegram signal mockups ----------
  // Two stacked styled "Telegram message" cards showing exactly what an
  // entry post and a close post look like in the channel. Visuals match
  // the actual templates verbatim — same icons, same line structure.
  const sp = c.signalPreview;
  const signalPreviewHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(sp.title)}</h2>
      <p class="home-section-sub">${escapeHtml(sp.subtitle)}</p>
      <div class="tg-mockup-grid">
        <div class="tg-mockup">
          <div class="tg-mockup-header">
            <div class="tg-avatar">🟢</div>
            <div class="tg-channel-info">
              <div class="tg-channel-name">LuxAlgo | Claude | Signals</div>
              <div class="tg-channel-sub">@luxalgosignal · ${escapeHtml(sp.entryLabel)}</div>
            </div>
          </div>
          <div class="tg-mockup-body">
            <div class="tg-line"><b>🔴 ШОРТ · BNBUSDT · 15m</b></div>
            <div class="tg-line"></div>
            <div class="tg-line">🤖 <b>STRAT-001</b> · BNB Contrarian</div>
            <div class="tg-line">🆔 <b>T#001</b></div>
            <div class="tg-line"></div>
            <div class="tg-line">📥 Вход:&nbsp;&nbsp;<code>676.28</code>&nbsp;(по рынку)</div>
            <div class="tg-line">🛡 Стоп:&nbsp;&nbsp;<code>693.187</code>&nbsp;(2.50%)</div>
            <div class="tg-line">💵 Размер позиции: $1000</div>
            <div class="tg-line"></div>
            <div class="tg-line tg-italic">Выход — по сигналу стратегии. Без фиксированных TP.</div>
          </div>
        </div>

        <div class="tg-mockup-separator">${escapeHtml(sp.timeBetween)}</div>

        <div class="tg-mockup">
          <div class="tg-mockup-header">
            <div class="tg-avatar">💰</div>
            <div class="tg-channel-info">
              <div class="tg-channel-name">LuxAlgo | Claude | Signals</div>
              <div class="tg-channel-sub">@luxalgosignal · ${escapeHtml(sp.closeLabel)}</div>
            </div>
          </div>
          <div class="tg-mockup-body">
            <div class="tg-line"><b>💰 ПРОФИТ +$17.90</b>&nbsp;&nbsp;🔴 <b>BNBUSDT</b> ШОРТ</div>
            <div class="tg-line"></div>
            <div class="tg-line">🤖 <b>STRAT-001</b> · BNB Contrarian</div>
            <div class="tg-line">🆔 <b>T#001</b></div>
            <div class="tg-line"></div>
            <div class="tg-line">📥 Вход:&nbsp;&nbsp;&nbsp;<code>676.28</code></div>
            <div class="tg-line">📤 Выход:&nbsp;&nbsp;<code>664.20</code>&nbsp;(сигнал стратегии)</div>
            <div class="tg-line">📊 Результат: <b class="tg-pos">+1.79%</b>&nbsp;·&nbsp;<b class="tg-pos">+$17.90</b></div>
            <div class="tg-line">⏱ Длительность: 2ч</div>
            <div class="tg-line"></div>
            <div class="tg-line tg-italic">Дисциплина приносит плоды. +$17.90 на $1000 ставку — в копилку! 💪</div>
          </div>
        </div>
      </div>
      <div style="margin-top: 20px; text-align: center;">
        <a class="btn btn-primary" href="${escapeHtml(c.telegramUrl)}" target="_blank" rel="noopener">
          ${escapeHtml(sp.cta)}
        </a>
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
            <div class="how-body">${renderRichText(s.body)}</div>
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
            <div class="faq-answer">${renderRichText(f.a)}</div>
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

  // Top-right nav is now handled by site-header in pageShell.

  const body = `
    ${heroHtml}
    ${whatYouGetHtml}
    ${howHtml}
    ${signalPreviewHtml}
    ${strategiesPreviewHtml}
    ${roadmapHtml}
    ${faqHtml}
    ${ctaHtml}
  `;

  // Use _ for the unused param suppression
  void otherLangPath;
  void TRACK_C_NOTIONAL_USD;

  return pageShell(c.htmlTitle, body, { lang, showLangToggle: true });
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

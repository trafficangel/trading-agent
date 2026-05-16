import type { FastifyInstance } from 'fastify';
import { STRATEGY_CONFIGS, TRACK_C_NOTIONAL_USD } from './track-c-config.js';
import { getStrategyLiveStats } from './live-stats.js';
import { pageShell, loadBacktestTrades } from './landing.js';
import { enrichTrades } from './backtest-recompute.js';

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
          a:
            '[LuxAlgo](https://www.luxalgo.com/) — это набор индикаторов для TradingView, которыми пользуются больше 200 тысяч трейдеров. В премиум-подписке доступны четыре основных пакета:\n\n' +
            '- **Signals & Overlays** — сигналы разворота тренда (Bullish+ / Bearish+), Smart Trail, Reversal Zones\n' +
            '- **Price Action Concepts** — структура рынка по концепциям ICT/SMC: BOS (break of structure), CHoCH (change of character), Order Blocks, Fair Value Gaps\n' +
            '- **Oscillator Matrix** — Money Flow, Trend Catcher, Contrarian Any, дивергенции и десяток других осцилляторов для подтверждения сигналов\n' +
            '- **AI Strategy Builder** — конструктор стратегий: комбинируем условия из всех индикаторов выше и сразу получаем полный бэктест на 200+ дней истории по символу и таймфрейму\n\n' +
            'Как мы выбираем стратегии. В AI Builder тестируем десятки комбинаций — например «Contrarian Any Bullish + Trend Catcher Bearish + Money Flow > 50». Только те что показывают **winrate ≥55%** и **profit factor ≥2** идут в финальную проверку: пересчитываем результаты в TradingView Premium с реальной комиссией Bybit (0.11% за круг) и нашей фиксированной позицией $1000. Если стратегия сохраняет показатели — добавляем на сайт.\n\n' +
            'Прозрачность. На странице каждой стратегии — прямая ссылка на её оригинальный LuxAlgo chat. Там видны точные условия входа/выхода, бэктест и все 100+ исторических сделок. Никакие числа не подделаны — каждый результат проверяем сами по сделкам, всё открыто.',
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
        'Каждая открытая и закрытая сделка публикуется в Telegram канал в реальном времени с уникальным ID (например BNB#001) и ссылкой на страницу стратегии.',
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
          a:
            '[LuxAlgo](https://www.luxalgo.com/) is a TradingView indicator suite used by 200,000+ traders. The premium subscription bundles four indicator packs:\n\n' +
            '- **Signals & Overlays** — trend-reversal signals (Bullish+ / Bearish+), Smart Trail, Reversal Zones\n' +
            '- **Price Action Concepts** — market structure via ICT/SMC concepts: BOS (break of structure), CHoCH (change of character), Order Blocks, Fair Value Gaps\n' +
            '- **Oscillator Matrix** — Money Flow, Trend Catcher, Contrarian Any, divergences, plus a dozen other confirmation oscillators\n' +
            '- **AI Strategy Builder** — strategy combinator: mix conditions from any of the above and immediately get a full backtest over 200+ days of history on a chosen symbol/timeframe\n\n' +
            'How we pick strategies. We test dozens of combinations in AI Builder — e.g. "Contrarian Any Bullish + Trend Catcher Bearish + Money Flow > 50". Only those with **win rate ≥55%** and **profit factor ≥2** advance to the final check: recompute on TradingView Premium with realistic Bybit commission (0.11% round-trip) and our fixed $1000 position. If the strategy still holds up — onto the site it goes.\n\n' +
            'Transparency. Every strategy page links directly to its original LuxAlgo chat. The exact entry/exit conditions, the backtest, and all 100+ historical trades are visible there. No numbers are doctored — we re-verify each result trade-by-trade, everything is open.',
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
        'Every open and close lands in the Telegram channel in real-time with a unique ID (e.g. BNB#001) and a direct link to the detail page.',
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
//   - **text**                    → <strong>text</strong>
//   - lines starting with "- "    → grouped into <ul><li>…</li></ul>
//   - blank line                  → paragraph break (rendered as <br><br>)
// XSS-safe because everything is escaped FIRST, then we re-interpret a
// strict subset of patterns. URLs are http(s)-only.
//
// Callers should render the result inside a <div>, not a <p> — a <ul>
// or <br> in a paragraph is invalid HTML in some validators.
function renderRichText(s: string): string {
  const escaped = escapeHtml(s);
  // Bold first (cheapest), then links (so a label can contain bold if
  // ever needed — though not used in current copy). Both work on the
  // already-escaped string so they can't introduce XSS.
  const withBold = escaped.replace(
    /\*\*([^*\n]+)\*\*/g,
    (_m, text) => `<strong>${text}</strong>`,
  );
  const withLinks = withBold.replace(
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

/**
 * Tiny inline SVG of the cumulative-PnL line (sparkline). 80x20px,
 * one accent-colour stroke, no axes. Used in the strategy-preview
 * rows so visitors get a one-glance impression of "this strategy
 * went up" without having to click through to the detail page.
 *
 * Input is an array of `cumulativePnlUsd` values from the enriched
 * trades log; output is an SVG element ready to inline in HTML.
 * Returns empty string when fewer than 2 points (need a segment).
 */
function sparklineSvg(cumValues: number[]): string {
  if (cumValues.length < 2) return '';
  const w = 80;
  const h = 20;
  const padY = 2;
  const min = Math.min(...cumValues);
  const max = Math.max(...cumValues);
  const range = max - min || 1;
  const pts = cumValues.map((v, i) => {
    const x = (i / (cumValues.length - 1)) * w;
    const y = h - padY - ((v - min) / range) * (h - 2 * padY);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = cumValues[cumValues.length - 1] ?? 0;
  const cls = last >= 0 ? 'pos' : 'neg';
  return `<svg class="sparkline ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/** Compact age — used by the live-position card and updated client-side
 *  every 10 seconds. Keep formats short so cards stay narrow. */
function formatAge(ms: number, lang: 'ru' | 'en'): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (lang === 'en') {
    if (d > 0) return `${d}d ${h}h ago`;
    if (h > 0) return `${h}h ${m}m ago`;
    return `${m}m ago`;
  }
  if (d > 0) return `${d}д ${h}ч назад`;
  if (h > 0) return `${h}ч ${m}м назад`;
  return `${m}м назад`;
}

/**
 * Inline <script> emitted at the bottom of the home body. Wires up the
 * four "feel alive" effects:
 *   1. Hero cursor spotlight (soft white radial glow follows the cursor
 *      inside the hero, mix-blend-mode: screen).
 *   2. Scroll-reveal — each .home-section fades up as it enters the
 *      viewport via IntersectionObserver.
 *   3. Scroll-progress bar — a thin gradient line at the very top of
 *      the page grows from 0% to 100% as the user scrolls.
 *   4. Magnetic primary CTA — buttons softly translate toward the
 *      cursor on hover, return on leave.
 *
 * All effects bail out automatically on prefers-reduced-motion or when
 * the browser lacks IntersectionObserver (handled gracefully in the
 * fallback paths).
 *
 * Kept inline so there's no extra HTTP request, no bundler, no script
 * tag with a hash to rotate on every deploy. Net cost: ~1.5KB gzipped.
 */
function homeEffectsScript(): string {
  return `<script>
(function() {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- 1. Hero cursor spotlight ----
  var hero = document.querySelector('.hero[data-spotlight]');
  if (hero && !reduce && window.matchMedia('(hover: hover)').matches) {
    hero.addEventListener('mousemove', function(e) {
      var r = hero.getBoundingClientRect();
      hero.style.setProperty('--sx', (e.clientX - r.left) + 'px');
      hero.style.setProperty('--sy', (e.clientY - r.top) + 'px');
      if (!hero.hasAttribute('data-spotlight-armed')) hero.setAttribute('data-spotlight-armed', '');
    });
    hero.addEventListener('mouseleave', function() {
      hero.removeAttribute('data-spotlight-armed');
    });
  }

  // ---- 2. Scroll-reveal ----
  var sections = document.querySelectorAll('.home-section, .hero');
  if ('IntersectionObserver' in window && !reduce) {
    sections.forEach(function(el) { el.classList.add('reveal'); });
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-visible');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    sections.forEach(function(el) { io.observe(el); });
    // Hero is the first thing visible — reveal immediately rather
    // than wait for the observer's intersection event after paint.
    var h = document.querySelector('.hero');
    if (h) h.classList.add('is-visible');
  }

  // ---- 3. Scroll-progress bar ----
  var bar = document.querySelector('.scroll-progress');
  if (bar) {
    var ticking = false;
    function update() {
      var d = document.documentElement;
      var max = d.scrollHeight - d.clientHeight;
      var pct = max > 0 ? (d.scrollTop / max) * 100 : 0;
      bar.style.width = pct + '%';
      ticking = false;
    }
    document.addEventListener('scroll', function() {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  // ---- 4. Magnetic primary CTA ----
  if (!reduce && window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('.btn-primary').forEach(function(btn) {
      btn.addEventListener('mousemove', function(e) {
        var r = btn.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) * 0.18;
        var y = (e.clientY - r.top - r.height / 2) * 0.18;
        btn.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      });
      btn.addEventListener('mouseleave', function() {
        btn.style.transform = '';
      });
    });
  }

  // ---- 5. Live active-positions polling ----
  // Fetches /api/active-positions every 10s and patches the existing
  // cards in-place. New positions get a freshly-built card appended;
  // closed positions get their card removed. Cards "flash" briefly
  // when their PnL changes so the visitor sees movement.
  var POLL_MS = 10000;
  var section = document.getElementById('live-positions');
  var grid = section ? section.querySelector('[data-positions-grid]') : null;
  var countLabel = section ? section.querySelector('[data-count-label]') : null;
  function fmtAge(ms) {
    var totalMin = Math.max(0, Math.floor(ms / 60000));
    var d = Math.floor(totalMin / 1440);
    var h = Math.floor((totalMin % 1440) / 60);
    var m = totalMin % 60;
    var ru = document.documentElement.lang !== 'en';
    if (d > 0) return ru ? (d + 'д ' + h + 'ч назад') : (d + 'd ' + h + 'h ago');
    if (h > 0) return ru ? (h + 'ч ' + m + 'м назад') : (h + 'h ' + m + 'm ago');
    return ru ? (m + 'м назад') : (m + 'm ago');
  }
  function plural(n) {
    var ru = document.documentElement.lang !== 'en';
    if (!ru) return n === 1 ? 'position' : 'positions';
    var mod10 = n % 10, mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return 'позиций';
    if (mod10 === 1) return 'позиция';
    if (mod10 >= 2 && mod10 <= 4) return 'позиции';
    return 'позиций';
  }
  function patchCard(card, p) {
    var ru = document.documentElement.lang !== 'en';
    var sign = p.pnlUsd >= 0 ? '+' : '−';
    var pctSign = p.pnlPct >= 0 ? '+' : '−';
    var rSign = p.pnlR >= 0 ? '+' : '−';
    var pnlBlock = card.querySelector('[data-pnl-block]');
    var oldUsd = card.querySelector('[data-pnl-usd]').textContent;
    var newUsd = sign + '$' + Math.abs(p.pnlUsd).toFixed(2);
    card.querySelector('[data-pnl-usd]').textContent = newUsd;
    card.querySelector('[data-pnl-pct]').textContent = pctSign + Math.abs(p.pnlPct).toFixed(2) + '%';
    card.querySelector('[data-pnl-r]').textContent = rSign + Math.abs(p.pnlR).toFixed(2) + 'R';
    card.querySelector('[data-current-price]').textContent = '$' + p.currentPrice.toFixed(4);
    var arrowEl = card.querySelector('[data-arrow]');
    var goodMove = (p.side === 'long' && p.currentPrice >= p.entry) || (p.side === 'short' && p.currentPrice <= p.entry);
    arrowEl.textContent = (p.side === 'long' ? (p.currentPrice >= p.entry ? '↑' : '↓') : (p.currentPrice <= p.entry ? '↓' : '↑'));
    arrowEl.className = 'live-pos-arrow ' + (goodMove ? 'pos' : 'neg');
    pnlBlock.classList.remove('pos', 'neg');
    pnlBlock.classList.add(p.pnlUsd >= 0 ? 'pos' : 'neg');
    if (oldUsd !== newUsd) {
      pnlBlock.classList.remove('is-flashing');
      // Force reflow then re-add for restart
      void pnlBlock.offsetWidth;
      pnlBlock.classList.add('is-flashing');
    }
    var ageEl = card.querySelector('[data-age]');
    var openedAt = parseInt(ageEl.getAttribute('data-opened-at') || '0', 10);
    ageEl.textContent = fmtAge(Date.now() - openedAt);
    void ru;
  }
  function poll() {
    if (!section || !grid) return;
    fetch('/api/active-positions', { headers: { 'accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        var positions = (j && j.positions) || [];
        if (countLabel) {
          var ru = document.documentElement.lang !== 'en';
          countLabel.textContent = positions.length === 0
            ? (ru ? 'нет открытых позиций' : 'no open positions')
            : (positions.length + ' ' + plural(positions.length));
        }
        section.setAttribute('data-empty', positions.length === 0 ? 'true' : 'false');
        // Patch existing cards by trade ID; remove cards no longer present.
        var seen = {};
        positions.forEach(function(p) { seen[p.tradeId] = true; });
        Array.prototype.forEach.call(grid.querySelectorAll('.live-pos-card'), function(card) {
          var tid = card.getAttribute('data-trade-id');
          if (!seen[tid]) card.remove();
        });
        // Patch / no insert here — for a brand-new position we want
        // a full page reload so the SSR template is the source of
        // truth (avoids JS templating duplication). Trigger reload
        // when we detect new IDs.
        var existing = {};
        Array.prototype.forEach.call(grid.querySelectorAll('.live-pos-card'), function(card) {
          existing[card.getAttribute('data-trade-id')] = card;
        });
        var hasNew = false;
        positions.forEach(function(p) {
          if (existing[p.tradeId]) {
            patchCard(existing[p.tradeId], p);
          } else {
            hasNew = true;
          }
        });
        if (hasNew) {
          // Soft reload — preserves scroll position via History API
          var y = window.scrollY;
          window.sessionStorage.setItem('scrollY', String(y));
          window.location.reload();
        }
      })
      .catch(function() { /* swallow — try again next tick */ });
  }
  if (section) {
    // Restore scroll if we reloaded for a new position
    var savedY = window.sessionStorage.getItem('scrollY');
    if (savedY) {
      window.sessionStorage.removeItem('scrollY');
      window.scrollTo(0, parseInt(savedY, 10));
    }
    setInterval(poll, POLL_MS);
    // Also tick age display every 60s so "X min ago" stays fresh
    // even when the polling response is identical.
    setInterval(function() {
      Array.prototype.forEach.call(grid.querySelectorAll('[data-age]'), function(el) {
        var openedAt = parseInt(el.getAttribute('data-opened-at') || '0', 10);
        if (openedAt > 0) el.textContent = fmtAge(Date.now() - openedAt);
      });
    }, 60000);
  }
})();
</script>`;
}

function renderHome(lang: Lang, activePositions: import('../api/active-positions.js').ActivePositionView[]): string {
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

  // ---------- Live "working right now" card(s) ----------
  // Server renders initial state from getActivePositionsCached().
  // Client polls /api/active-positions every 10s and patches the DOM
  // in-place — numbers (price / PnL / age) update without a reload.
  // Each card has data-* hooks the script reads/writes.
  const renderPositionCard = (p: import('../api/active-positions.js').ActivePositionView): string => {
    const sideEmoji = p.side === 'long' ? '🟢' : '🔴';
    const sideLabel = lang === 'en' ? (p.side === 'long' ? 'LONG' : 'SHORT') : (p.side === 'long' ? 'ЛОНГ' : 'ШОРТ');
    const pnlSign = p.pnlUsd >= 0 ? '+' : '−';
    const pnlPctSign = p.pnlPct >= 0 ? '+' : '−';
    const pnlRSign = p.pnlR >= 0 ? '+' : '−';
    const pnlCls2 = p.pnlUsd >= 0 ? 'pos' : 'neg';
    const arrow = p.side === 'long'
      ? (p.currentPrice >= p.entry ? '↑' : '↓')
      : (p.currentPrice <= p.entry ? '↓' : '↑');
    const arrowCls = p.side === 'long'
      ? (p.currentPrice >= p.entry ? 'pos' : 'neg')
      : (p.currentPrice <= p.entry ? 'pos' : 'neg');
    return `
      <div class="live-pos-card" data-strategy="${escapeHtml(p.strategyCode)}" data-trade-id="${escapeHtml(p.tradeId)}">
        <div class="live-pos-head">
          <div class="live-pos-id">${sideEmoji} <b>${escapeHtml(p.tradeId)}</b> · STRAT-${escapeHtml(p.strategyCode)}</div>
          <div class="live-pos-side"><span class="side-${p.side}">${sideLabel}</span> · ${escapeHtml(p.symbol)}</div>
        </div>
        <div class="live-pos-prices">
          <div class="live-pos-price-row">
            <span class="live-pos-label">${lang === 'en' ? 'Entry' : 'Вход'}</span>
            <span class="live-pos-val mono">$${p.entry.toFixed(4)}</span>
          </div>
          <div class="live-pos-price-row">
            <span class="live-pos-label">${lang === 'en' ? 'Now' : 'Сейчас'}</span>
            <span class="live-pos-val mono" data-current-price>$${p.currentPrice.toFixed(4)}</span>
            <span class="live-pos-arrow ${arrowCls}" data-arrow>${arrow}</span>
          </div>
          <div class="live-pos-price-row">
            <span class="live-pos-label">${lang === 'en' ? 'Safety SL' : 'Стоп'}</span>
            <span class="live-pos-val mono">$${p.sl.toFixed(4)}</span>
            <span class="live-pos-meta">(${p.slPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="live-pos-pnl ${pnlCls2}" data-pnl-block>
          <span class="live-pos-pnl-usd" data-pnl-usd>${pnlSign}$${Math.abs(p.pnlUsd).toFixed(2)}</span>
          <span class="live-pos-pnl-pct" data-pnl-pct>${pnlPctSign}${Math.abs(p.pnlPct).toFixed(2)}%</span>
          <span class="live-pos-pnl-r" data-pnl-r>${pnlRSign}${Math.abs(p.pnlR).toFixed(2)}R</span>
        </div>
        <div class="live-pos-foot">
          <span class="live-pos-age" data-age data-opened-at="${p.openedAt}">${formatAge(p.ageMs, lang)}</span>
          <a class="live-pos-link" href="/strategies/${escapeHtml(p.strategyCode)}">${lang === 'en' ? 'Details →' : 'Подробнее →'}</a>
        </div>
      </div>
    `;
  };
  const livePositionsHtml = `
    <div class="home-section live-pos-section" id="live-positions" data-empty="${activePositions.length === 0 ? 'true' : 'false'}">
      <div class="live-pos-header">
        <span class="live-pos-pulse" aria-hidden="true"></span>
        <h2 class="live-pos-title">${lang === 'en' ? 'Working right now' : 'В работе прямо сейчас'}</h2>
        <span class="live-pos-count" data-count-label>${activePositions.length === 0 ? (lang === 'en' ? 'no open positions' : 'нет открытых позиций') : `${activePositions.length} ${pluralRu(activePositions.length, 'позиция', 'позиции', 'позиций')}`}</span>
      </div>
      <div class="live-pos-grid" data-positions-grid>
        ${activePositions.map(renderPositionCard).join('')}
      </div>
    </div>
  `;

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
      // Inline sparkline of cumulative-pnl over the backtest trades.
      // One-glance signal: green-up = the strategy made money.
      const bundle = loadBacktestTrades(s.id);
      const sparkline = bundle && bundle.trades.length > 1
        ? sparklineSvg(enrichTrades(bundle.trades).map((t) => t.cumulativePnlUsd))
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
          <div class="strategy-preview-left">
            <div class="strategy-preview-name">[STRAT-${escapeHtml(s.code)}] ${escapeHtml(s.symbol ?? 'ANY')} ${escapeHtml(s.timeframe)}m</div>
            <div class="strategy-preview-meta">${btLabel}</div>
          </div>
          ${sparkline ? `<div class="strategy-preview-spark">${sparkline}</div>` : ''}
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
    <div class="hero" data-spotlight>
      <div class="hero-bg" aria-hidden="true">
        <div class="blob blob-1"></div>
        <div class="blob blob-2"></div>
        <div class="blob blob-3"></div>
        <div class="hero-spotlight"></div>
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
            <div class="tg-line">🆔 <b>BNB#001</b></div>
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
            <div class="tg-line">🆔 <b>BNB#001</b></div>
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
    <div class="scroll-progress" aria-hidden="true"></div>
    ${heroHtml}
    ${livePositionsHtml}
    ${whatYouGetHtml}
    ${howHtml}
    ${signalPreviewHtml}
    ${strategiesPreviewHtml}
    ${roadmapHtml}
    ${faqHtml}
    ${ctaHtml}
    ${homeEffectsScript()}
  `;

  // Use _ for the unused param suppression
  void otherLangPath;
  void TRACK_C_NOTIONAL_USD;

  return pageShell(c.htmlTitle, body, { lang, showLangToggle: true });
}

export async function homeRoute(app: FastifyInstance): Promise<void> {
  const { getActivePositionsCached } = await import('../api/active-positions.js');

  // Russian (default) home
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    // Server-render with whatever's in the 8s cache. Client polls the
    // /api/active-positions endpoint every 10s to keep numbers fresh.
    const positions = await getActivePositionsCached().catch(() => []);
    return renderHome('ru', positions);
  });

  // English variant
  app.get('/en', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    const positions = await getActivePositionsCached().catch(() => []);
    return renderHome('en', positions);
  });
}

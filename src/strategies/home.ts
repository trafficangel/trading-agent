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
    htmlTitle: 'Robot Claude — проверенные стратегии для криптотрейдинга',
    hero: {
      eyebrow: '📊 ОТКРЫТАЯ СТАТИСТИКА · 📡 TELEGRAM-СИГНАЛЫ · 🤖 АВТОТРЕЙДИНГ',
      title1: 'Проверенные ',
      titleAccent: 'стратегии и сигналы',
      title2: ' для криптотрейдинга',
      subtitle:
        'Каждая стратегия отобрана по бэктестам на 200+ дней и пересчитана на реальную комиссию Bybit. '
        + 'Смотрите live-сделки на сайте, ловите сигналы в Telegram бесплатно — '
        + 'или подключите автотрейдинг, и наши стратегии будут торговать на вашем счёте Bybit автоматически.',
      ctaPrimary: 'Посмотреть стратегии →',
      ctaSecondary: 'Telegram канал ↗',
    },
    liveStrip: {
      strategies: 'Стратегий',
      livePnl: 'Live P&L',
      liveTrades: 'Live сделок',
      bestWr: 'Лучший WR backtest',
    },
    whatYouGet: {
      title: 'Что доступно',
      items: [
        '📊 Полная статистика по каждой стратегии — бэктест, live-сделки, графики (открыто всем)',
        '📡 Сигналы в Telegram канале @luxalgosignal — вход, выход, стоп (бесплатно)',
        '💼 Прозрачный учёт — каждая сделка публична с уникальным ID и проверяема',
        '🤖 Автотрейдинг по подписке — наши стратегии торгуют автоматически на вашем счёте Bybit',
        '🔑 Ваши деньги остаются у вас — API-ключ без права на вывод, мы только исполняем сделки',
        '⚙ Гибкая настройка — сами выбираете стратегии, размер позиции и плечо',
      ],
    },
    signalPreview: {
      title: 'Как выглядят сигналы в Telegram',
      subtitle: 'Каждое открытие и закрытие сделки приходит в канал автоматически — с ценой, размером и причиной выхода. Можно повторять вручную на своём счёте, а можно подключить автотрейдинг и не отвлекаться.',
      entryLabel: 'Вход в позицию',
      closeLabel: 'Закрытие позиции',
      timeBetween: '↓ через 2 часа',
      cta: 'Подписаться на канал ↗',
    },
    how: {
      title: 'Как это работает',
      subtitle: 'Сначала посмотрите как мы торгуем. Если результат нравится — подключите автотрейдинг.',
      steps: [
        {
          step: 'ШАГ 01',
          title: 'Двухэтапный отбор стратегий',
          body:
            'Сначала собираем стратегию в [LuxAlgo Premium Ultimate](https://www.luxalgo.com/pricing/) с тестом на 200+ дней. ' +
            'Если winrate ≥55% и прибыль превышает убытки в 2 раза — переходим ко второму этапу: проверяем в [TradingView Premium](https://ru.tradingview.com/pricing/) с реальной комиссией Bybit и защитным стопом. ' +
            'Только стратегии прошедшие обе проверки попадают на сайт.',
        },
        {
          step: 'ШАГ 02',
          title: 'Смотрите live-результаты',
          body:
            'Каждая стратегия торгует на нашем shadow-счёте 24/7 — это публичный трек-рекорд. ' +
            'На странице стратегии видны все сделки в реальном времени: время входа, цена выхода, ' +
            'прибыль/убыток с уникальным ID. Проверяемо до копейки.',
        },
        {
          step: 'ШАГ 03',
          title: 'Бесплатные сигналы в Telegram',
          body:
            'Каждый сигнал — вход, выход, стоп — публикуется в [@luxalgosignal](https://t.me/luxalgosignal) сразу как срабатывает. ' +
            'Можете повторять вручную на своём счёте, или просто следить за результатами. Никакой оплаты за сигналы.',
        },
        {
          step: 'ШАГ 04',
          title: 'Хотите автоматически? Подключите автотрейдинг',
          body:
            'Когда убедились что результаты реальные — подключите свой Bybit-аккаунт через API-ключ ' +
            '(без права на вывод). Выберите стратегии, размер позиции и плечо — система начнёт торговать ' +
            'за вас автоматически. 14 дней бесплатного триала, потом $50/мес.',
        },
      ],
    },
    strategiesPreview: {
      title: 'TOP-3 по live-доходности',
      subtitle:
        'Три лучшие стратегии по реальной прибыли на нашем shadow-счёте. Полная статистика, бэктесты, сделки и графики по каждой — на странице стратегии. Числа пересчитаны на позицию $1000 с реальной комиссией Bybit.',
      seeAll: 'Все 8 стратегий →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'АПРЕЛЬ 2026',
          done: true,
          title: '✅ Запущен сайт с публичной статистикой по стратегиям + Telegram-канал @luxalgosignal с сигналами в реальном времени.',
        },
        {
          when: 'МАЙ 2026',
          done: true,
          title: '✅ Расширен портфель до 8 проверенных стратегий (BNB, XRP, UNI, TRX, TON, HBAR, BCH, BTC). Каждая со своей страницей, бэктестом и live-сделками.',
        },
        {
          when: 'СЕЙЧАС',
          done: true,
          title: '🚀 Запущен автотрейдинг — клиенты подключают свой Bybit-аккаунт через API-ключ и наши стратегии торгуют автоматически за них. Бета-тестирование с первыми пользователями.',
        },
        {
          when: 'ИЮНЬ 2026',
          done: false,
          title: 'Открытие подписки для всех желающих после успешного завершения beta. Автоматическая оплата через Stripe / ЮKassa.',
        },
        {
          when: 'ЛЕТО 2026',
          done: false,
          title: 'Hyperliquid Vault — параллельный канал для тех кто хочет копировать через смарт-контракт без выдачи API-ключа.',
        },
        {
          when: 'Q4 2026',
          done: false,
          title: 'Расширение списка бирж: Binance, OKX. Пользователь сможет выбрать на какой бирже торговать.',
        },
      ],
    },
    faq: {
      title: 'Частые вопросы',
      items: [
        {
          q: 'Что бесплатно, а что платно?',
          a:
            '**Бесплатно:**\n' +
            '- Сайт и вся статистика по стратегиям — открыто для всех\n' +
            '- Telegram-канал [@luxalgosignal](https://t.me/luxalgosignal) с сигналами в реальном времени\n' +
            '- Личный кабинет, бэктесты, история сделок shadow-аккаунта\n\n' +
            '**Платно — только автотрейдинг:**\n' +
            '- $50/мес за автоматическое исполнение сигналов на вашем счёте Bybit\n' +
            '- 14 дней бесплатного триала чтобы попробовать без обязательств\n' +
            '- 🎁 **+30 дней бонусом** если регистрируетесь на Bybit по нашей [реферальной ссылке](https://www.bybit.com/invite?ref=MY6W8R) — итого 44 дня бесплатно\n\n' +
            'Идея простая: смотрите как мы торгуем сколько хотите — а если результат нравится и не хочется каждый раз руками открывать сделку, подключите автотрейдинг. Деньги остаются у вас, мы только исполняем сделки через API.',
        },
        {
          q: 'Как это всё работает простыми словами?',
          a:
            'Очень коротко — система делает три вещи:\n\n' +
            '**1.** Мы собираем торговые стратегии в специальном инструменте от LuxAlgo (см. вопрос ниже), отбираем те что показывают хорошие результаты на истории, и публикуем их на сайте.\n\n' +
            '**2.** Каждая стратегия торгует круглосуточно на нашем «теневом» счёте — это и есть публичный трек-рекорд. Когда стратегия открывает или закрывает сделку, информация о ней появляется и на сайте, и в [Telegram-канале](https://t.me/luxalgosignal). Это бесплатно и видно всем.\n\n' +
            '**3.** Если вы хотите чтобы те же самые сделки выполнялись на вашем счёте — подключаете свой Bybit-аккаунт через API-ключ. Наша система делает на вашем счёте те же сделки что и на нашем — автоматически, без вашего участия. Это уже платно: $50/мес (+30 дней бонусом если регистрируетесь на Bybit через нас).\n\n' +
            'Никакой магии: всё что вы видите в Telegram-канале — это именно то, что система сделает на вашем счёте. Деньги остаются у вас, мы не имеем права на вывод.',
        },
        {
          q: 'Кто такие LuxAlgo?',
          a:
            '[LuxAlgo](https://www.luxalgo.com/) — крупный коммерческий продукт для TradingView (~$60/мес). Это **не наша разработка**, мы их лицензированный пользователь.\n\n' +
            'Они делают набор торговых индикаторов и инструмент **AI Strategy Builder** — это конструктор, в котором можно комбинировать условия из их индикаторов и сразу получать полный бэктест за 200+ дней истории по любому символу и таймфрейму.\n\n' +
            '**Почему мы их используем:**\n' +
            '- 200 000+ трейдеров по всему миру — продукт проверенный, не «свежий стартап»\n' +
            '- Бэктесты делаются на их сервере с открытыми условиями входа/выхода — на странице каждой стратегии у нас есть **прямая ссылка на её LuxAlgo chat**, где можно перепроверить наши цифры самостоятельно\n' +
            '- Их сигналы — это математика на ценах и объёмах (а не «угадайка», как у большинства сигнальщиков в Telegram)\n\n' +
            '**Что важно понять:** LuxAlgo даёт «сырьё» — индикаторы и бэктестер. Превращение этого в работающую систему (отбор стратегий, исполнение на бирже, мониторинг, безопасность ключей) — это уже наша часть.',
        },
        {
          q: 'Как именно вы отбираете стратегии?',
          a:
            'Двухэтапная проверка перед публикацией:\n\n' +
            '**Этап 1 — LuxAlgo AI Builder.** Тестируем комбинации индикаторов в режиме конструктора. Например: «Contrarian Any Bullish + Trend Catcher Bearish + Money Flow > 50» на BTCUSDT 5m. Только если стратегия показывает **winrate ≥ 55%** и **profit factor ≥ 2** (выигрыши в 2 раза больше убытков) на 200+ дней истории — переходим к этапу 2.\n\n' +
            '**Этап 2 — пересчёт на реальные условия.** Скачиваем все сделки из LuxAlgo, пересчитываем их на нашу фиксированную позицию $1000 с **реальной комиссией Bybit** (0.055% × 2 стороны = 0.11% за круг). Это критически важно: на тонких 5m-стратегиях комиссия может «съесть» половину прибыли — мы это честно показываем (см. например страницу BCH или BTC — там видна разница между «LuxAlgo unit-size» и «наш $1000 nominal»).\n\n' +
            '**Что НЕ проходит:**\n' +
            '- Стратегии с слишком высоким winrate (90%+) — обычно это значит что в бэктесте мало сделок или есть curve-fitting\n' +
            '- Стратегии где profit factor падает ниже 1.5 после учёта комиссии\n' +
            '- Стратегии с просадкой больше 30% — слишком жёсткие хвостовые риски\n\n' +
            '**Прозрачность.** На странице каждой стратегии есть прямая ссылка на её LuxAlgo chat — кликаете и видите оригинальные условия, оригинальный бэктест и все исторические сделки на стороне LuxAlgo. Сравниваете с нашими цифрами — ничего не скрыто.',
        },
        {
          q: 'Чем вы отличаетесь от обычных Telegram-каналов с сигналами?',
          a:
            'Три отличия, которые легко проверить:\n\n' +
            '**1. Открытая статистика, не маркетинговые скриншоты.** На странице каждой стратегии — все 100+ исторических сделок с датами, ценами входа/выхода и PnL. Можно ткнуть в любую конкретную сделку и проверить — пересчитываем заново на ваших данных, цифры сойдутся. Большинство Telegram-каналов показывают только успешные сделки скриншотами.\n\n' +
            '**2. Реальное исполнение, не «вот сигнал — торгуй сам».** У нас работает робот, который реально открывает и закрывает позиции на нашем shadow-счёте 24/7. То что вы видите в канале — это то что *действительно* произошло, а не то что мы *планировали* сделать.\n\n' +
            '**3. Автотрейдинг на ВАШЕМ счёте, не «зачисляйте деньги нам».** Когда вам понравится результат — подключаете свой Bybit через API-ключ без права на вывод. Деньги остаются на вашей бирже, мы только посылаем туда ордера. Ни одного канала-сигнальщика которым мы видели нет такой связки.\n\n' +
            'И главное: $50/мес платится **после** того как вы посмотрели результаты в течение 14 дней триала — мы не берём деньги авансом.',
        },
        {
          q: 'Откуда берутся стратегии? (технические детали)',
          a:
            '[LuxAlgo](https://www.luxalgo.com/) даёт нам четыре основных пакета индикаторов:\n\n' +
            '- **Signals & Overlays** — сигналы разворота тренда (Bullish+ / Bearish+), Smart Trail, Reversal Zones\n' +
            '- **Price Action Concepts** — структура рынка по концепциям ICT/SMC: BOS (break of structure), CHoCH (change of character), Order Blocks, Fair Value Gaps\n' +
            '- **Oscillator Matrix** — Money Flow, Trend Catcher, Contrarian Any, дивергенции и десяток других осцилляторов\n' +
            '- **AI Strategy Builder** — конструктор стратегий с инстант-бэктестом на 200+ дней\n\n' +
            'В Builder мы тестируем десятки комбинаций — например «Contrarian Any Bullish + Trend Catcher Bearish + Money Flow > 50». Только те что проходят оба этапа отбора (см. вопрос «Как именно вы отбираете стратегии?») попадают на сайт.\n\n' +
            'Имя стратегии в нашей системе кодирует её условия. Например, **STRAT-001 «BNB Contrarian»** = LuxAlgo Contrarian Any + Trend Tracer + Money Flow на BNBUSDT 15m. На странице STRAT-001 будет прямая ссылка на её LuxAlgo chat для полной проверки.',
        },
        {
          q: 'Как контролируется риск?',
          a: 'Каждая стратегия имеет индивидуальный защитный стоп-лосс (обычно от 4% до 30% от цены входа в зависимости от типа стратегии и таймфрейма). Это страховка от потери сигнала на закрытие — основной выход стратегия делает сама. Размер позиции фиксированный — 1000 долларов на сделку. На один символ и одну стратегию открыта максимум одна позиция одновременно.',
        },
        {
          q: 'Где смотреть результаты?',
          a: 'На странице «Активные стратегии» — общий список со статистикой по каждой. На странице конкретной стратегии — график доходности, полный список всех сделок, разбивка лонг/шорт. Данные обновляются автоматически каждые 60 секунд.',
        },
        {
          q: 'Сигналы в Telegram-канале платные?',
          a: 'Нет. Канал [@luxalgosignal](https://t.me/luxalgosignal) бесплатный, каждое открытие и закрытие сделки приходит автоматически с ценой, размером и причиной выхода. Можете повторять за нами вручную или подключить автотрейдинг, чтобы не отвлекаться.',
        },
        {
          q: 'Что если стратегия в просадке?',
          a: 'Просадка — это нормально, любая торговая система проходит через периоды убытков. У каждой стратегии есть Safety SL (защитный стоп выше исторических убытков), который ограничивает максимальную потерю. В автотрейдинге можете в любой момент отключить конкретную стратегию или весь автотрейдинг — открытые позиции продолжат жить до естественного выхода.',
        },
        {
          q: 'Безопасны ли мои деньги в автотрейдинге?',
          a: 'Да. Автотрейдинг работает на вашем собственном Bybit-аккаунте через API-ключ. Создавая ключ, вы НЕ даёте права на вывод средств — Bybit отклонит любую попытку вывести с нашей стороны. Мы можем только открывать и закрывать позиции на ваших USDT-фьючерсах. Ключ шифруется AES-256-GCM при сохранении и работает только с нашего сервера (IP-whitelist). Подробная инструкция по созданию ключа — на странице [Автотрейдинг](/autotrading).',
        },
        {
          q: 'Какие комиссии биржи учитываются?',
          a: 'В наших расчётах уже вычтена комиссия Bybit — 0.055% × 2 стороны = 0.11% за круг сделки. Цифры на сайте — реалистичные, такие же получите и вы при торговле.',
        },
      ],
    },
    ctaSection: {
      title: 'С чего начать',
      subtitle:
        'Сначала посмотрите статистику и подпишитесь на канал — ловите live-сделки в реальном времени. Когда убедитесь что результаты вам нравятся — подключите автотрейдинг и пусть стратегии торгуют за вас.',
      telegram: 'Telegram канал',
      strategies: 'Все стратегии',
    },
    telegramUrl: 'https://t.me/luxalgosignal',
  },
  en: {
    htmlTitle: 'Robot Claude — verified strategies for crypto trading',
    hero: {
      eyebrow: '📊 OPEN STATS · 📡 TELEGRAM SIGNALS · 🤖 AUTO-TRADING',
      title1: 'Verified ',
      titleAccent: 'strategies & signals',
      title2: ' for crypto trading',
      subtitle:
        'Each strategy is rigorously vetted against 200+ days of historical data and recomputed for real Bybit commissions. '
        + 'Watch live trades on the site, catch signals in Telegram for free — '
        + 'or enable auto-trading and let our strategies trade your Bybit account automatically.',
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
      title: 'What\'s available',
      items: [
        '📊 Full stats on every strategy — backtest, live trades, charts (open to all)',
        '📡 Signals in our Telegram channel @luxalgosignal — entry, exit, stop (free)',
        '💼 Transparent accounting — every trade public with a unique ID and verifiable',
        '🤖 Auto-trading by subscription — our strategies trade automatically on your Bybit account',
        '🔑 Your funds stay with you — API key without withdrawal rights, we only execute trades',
        '⚙ Flexible setup — pick your own strategies, position size and leverage',
      ],
    },
    signalPreview: {
      title: 'What signals look like in Telegram',
      subtitle: 'Every entry and close arrives in the channel automatically — with price, size, and exit reason. Copy manually on your own account, or enable auto-trading and stay hands-off.',
      entryLabel: 'Position opened',
      closeLabel: 'Position closed',
      timeBetween: '↓ 2 hours later',
      cta: 'Subscribe to channel ↗',
    },
    how: {
      title: 'How it works',
      subtitle: 'First watch how we trade. If you like the result — enable auto-trading.',
      steps: [
        {
          step: 'STEP 01',
          title: 'Two-stage strategy vetting',
          body:
            'First we build the strategy in [LuxAlgo Premium Ultimate](https://www.luxalgo.com/pricing/) with a 200+ day backtest. ' +
            'If win rate ≥55% and profits are at least 2× larger than losses, we move to stage two: re-test in [TradingView Premium](https://www.tradingview.com/pricing/) with realistic Bybit commission and a safety stop. ' +
            'Only strategies passing both stages make it onto the site.',
        },
        {
          step: 'STEP 02',
          title: 'Watch live results',
          body:
            'Every strategy trades on our shadow account 24/7 — that\'s the public track record. ' +
            'The strategy page shows every trade in real-time: entry time, exit price, profit/loss with a unique ID. ' +
            'Verifiable to the cent.',
        },
        {
          step: 'STEP 03',
          title: 'Free Telegram signals',
          body:
            'Every signal — entry, exit, stop — is posted to [@luxalgosignal](https://t.me/luxalgosignal) the moment it fires. ' +
            'Copy manually on your own account, or just observe the results. No fee for signals.',
        },
        {
          step: 'STEP 04',
          title: 'Want automation? Enable auto-trading',
          body:
            'Once you\'re convinced the results are real — connect your Bybit account via an API key ' +
            '(no withdraw rights). Pick strategies, position size and leverage — the system starts trading ' +
            'for you automatically. 14-day free trial, then $50/mo.',
        },
      ],
    },
    strategiesPreview: {
      title: 'TOP-3 by live profit',
      subtitle:
        'Three best strategies by real PnL on our shadow account. Full stats, backtests, trades and charts for every strategy — on its individual page. Numbers are recomputed for our $1000 position size with real Bybit commission.',
      seeAll: 'All 8 strategies →',
    },
    roadmap: {
      title: 'Roadmap',
      items: [
        {
          when: 'APR 2026',
          done: true,
          title: '✅ Site with public per-strategy stats + @luxalgosignal Telegram channel with real-time signals.',
        },
        {
          when: 'MAY 2026',
          done: true,
          title: '✅ Portfolio expanded to 8 verified strategies (BNB, XRP, UNI, TRX, TON, HBAR, BCH, BTC). Each with its own page, backtest and live trades.',
        },
        {
          when: 'NOW',
          done: true,
          title: '🚀 Auto-trading launched — clients connect their Bybit account via API key and our strategies trade automatically on their behalf. Beta-testing with first users.',
        },
        {
          when: 'JUNE 2026',
          done: false,
          title: 'Public subscription open after beta completes. Automated payments via Stripe.',
        },
        {
          when: 'SUMMER 2026',
          done: false,
          title: 'Hyperliquid Vault — on-chain channel for those who prefer smart-contract copy trading over API keys.',
        },
        {
          when: 'Q4 2026',
          done: false,
          title: 'Multi-exchange: Binance, OKX. Users choose where to run their strategies.',
        },
      ],
    },
    faq: {
      title: 'Frequently asked',
      items: [
        {
          q: 'What\'s free and what costs money?',
          a:
            '**Free:**\n' +
            '- The site and all per-strategy stats — open to everyone\n' +
            '- [@luxalgosignal](https://t.me/luxalgosignal) Telegram channel with real-time signals\n' +
            '- Account dashboard, backtests, shadow-account trade history\n\n' +
            '**Paid — only auto-trading:**\n' +
            '- $50/mo for automatic signal execution on your Bybit account\n' +
            '- 14-day free trial to try without commitment\n' +
            '- 🎁 **+30 bonus days** if you register on Bybit via our [referral link](https://www.bybit.com/invite?ref=MY6W8R) — 44 days free total\n\n' +
            'Simple idea: watch how we trade for as long as you want — and if you like the results and don\'t want to open every trade manually, enable auto-trading. Your funds stay with you; we only execute trades via the API.',
        },
        {
          q: 'How does it all work in plain English?',
          a:
            'The system does three things:\n\n' +
            '**1.** We build trading strategies in a LuxAlgo tool (see the next FAQ), pick the ones with solid historical results, and publish them on the site.\n\n' +
            '**2.** Each strategy trades 24/7 on our shadow account — that\'s the public track record. Every open/close is mirrored to the site AND to the [Telegram channel](https://t.me/luxalgosignal). Free and visible to anyone.\n\n' +
            '**3.** If you want those same trades on your account — connect your Bybit via an API key. Our system places identical orders on your account automatically. This is the paid part: $50/mo (+30 bonus days if you sign up Bybit via our referral).\n\n' +
            'No magic: what you see in the channel is exactly what the system does on your account. Your funds stay with you; we have no withdraw rights.',
        },
        {
          q: 'Who is LuxAlgo?',
          a:
            '[LuxAlgo](https://www.luxalgo.com/) is a commercial TradingView add-on (~$60/mo). **Not our product** — we\'re a licensed user.\n\n' +
            'They make trading indicators and an **AI Strategy Builder** — a combinator where you mix conditions from their indicators and instantly get a full backtest over 200+ days on any symbol/timeframe.\n\n' +
            '**Why we use them:**\n' +
            '- 200,000+ traders globally — proven product, not a fresh startup\n' +
            '- Backtests run on LuxAlgo servers with open entry/exit conditions — every strategy page on our site has a **direct link to its LuxAlgo chat** so you can verify our numbers yourself\n' +
            '- Their signals are math on price + volume (not "vibes", unlike most signal channels)\n\n' +
            '**Important:** LuxAlgo gives us the raw materials — indicators + backtester. Turning that into a working production system (strategy selection, exchange execution, monitoring, key security) is the part we add.',
        },
        {
          q: 'How exactly do you select strategies?',
          a:
            'Two-stage vetting before anything goes live:\n\n' +
            '**Stage 1 — LuxAlgo AI Builder.** Test indicator combinations in the builder. E.g. "Contrarian Any Bullish + Trend Catcher Bearish + Money Flow > 50" on BTCUSDT 5m. Only if the strategy hits **win rate ≥ 55%** AND **profit factor ≥ 2** (wins 2× larger than losses) on 200+ days of history — does it move to stage 2.\n\n' +
            '**Stage 2 — recompute on realistic conditions.** Pull all trades from LuxAlgo, recompute on our fixed $1000 position with **real Bybit commission** (0.055% × 2 sides = 0.11% round-trip). Critical: on tight 5m strategies commission can eat half the profit — we surface this honestly (see BCH or BTC pages, where "LuxAlgo unit-size" vs "our $1000 nominal" is shown side by side).\n\n' +
            '**What gets rejected:**\n' +
            '- Win rates over 90% — usually too few trades or curve-fitting\n' +
            '- Profit factor below 1.5 after commission\n' +
            '- Drawdowns over 30% — tail risk too high\n\n' +
            '**Transparency.** Every strategy page links directly to its LuxAlgo chat — click it and see the original conditions, original backtest, all historical trades on LuxAlgo\'s side. Compare to our numbers — nothing hidden.',
        },
        {
          q: 'How are you different from regular Telegram signal channels?',
          a:
            'Three differences, easy to verify:\n\n' +
            '**1. Open stats, not marketing screenshots.** Every strategy page shows all 100+ historical trades with dates, entry/exit prices, PnL. Pick any trade and verify — recompute on your data and the numbers match. Most signal channels only post winning trades as screenshots.\n\n' +
            '**2. Real execution, not "here\'s the signal, trade it yourself".** A robot runs 24/7 actually opening and closing positions on our shadow account. What you see in the channel is what *actually happened*, not what we *intended* to do.\n\n' +
            '**3. Auto-trading on YOUR account, not "deposit funds with us".** When you\'re happy with the results, connect your Bybit via an API key with no withdraw rights. Funds stay on your exchange; we just send orders. No signal channel we\'ve seen offers this kind of integration.\n\n' +
            'And key: $50/mo is paid **after** you\'ve watched results for 14 days of trial — no upfront capture.',
        },
        {
          q: 'Where do the strategies come from? (technical details)',
          a:
            '[LuxAlgo](https://www.luxalgo.com/) gives us four indicator packs:\n\n' +
            '- **Signals & Overlays** — trend-reversal signals (Bullish+ / Bearish+), Smart Trail, Reversal Zones\n' +
            '- **Price Action Concepts** — ICT/SMC market structure: BOS, CHoCH, Order Blocks, Fair Value Gaps\n' +
            '- **Oscillator Matrix** — Money Flow, Trend Catcher, Contrarian Any, divergences, dozen+ confirmation oscillators\n' +
            '- **AI Strategy Builder** — strategy combinator with instant 200+ day backtest\n\n' +
            'We test dozens of combinations in Builder — e.g. "Contrarian Any Bullish + Trend Catcher Bearish + Money Flow > 50". Only those passing both selection stages (see "How exactly do you select strategies?") make it onto the site.\n\n' +
            'Strategy names encode their conditions. E.g. **STRAT-001 "BNB Contrarian"** = LuxAlgo Contrarian Any + Trend Tracer + Money Flow on BNBUSDT 15m. The STRAT-001 page has a direct LuxAlgo-chat link for full verification.',
        },
        {
          q: 'How is risk controlled?',
          a: 'Each strategy has a protective stop-loss (typically 4-30% from entry price depending on strategy type and timeframe). It\'s an insurance against losing the exit signal — the strategy itself does the main exit. In auto-trading you set position size and leverage per strategy. Max one position per symbol × strategy at any time.',
        },
        {
          q: 'Where can I see results?',
          a: 'On the "Active strategies" page — overall list with stats. On each strategy\'s page — equity curve, full trade log, long/short breakdown. Data refreshes automatically every 60 seconds.',
        },
        {
          q: 'Are signals in the Telegram channel paid?',
          a: 'No. The [@luxalgosignal](https://t.me/luxalgosignal) channel is free; every open and close arrives automatically with price, size, and exit reason. Copy manually or enable auto-trading to stay hands-off.',
        },
        {
          q: 'What if a strategy is in drawdown?',
          a: 'Drawdown is normal — any trading system goes through losing periods. Each strategy has a Safety SL (protective stop above historical losses) that caps the maximum loss. In auto-trading you can disable any single strategy or turn the whole thing off at any time — open positions continue to their natural exit.',
        },
        {
          q: 'Are my funds safe in auto-trading?',
          a: 'Yes. Auto-trading runs on your own Bybit account via an API key. When creating the key you do NOT grant withdraw rights — Bybit will reject any withdrawal attempt from our side. We can only open and close positions on your USDT-futures. The key is AES-256-GCM encrypted at rest and only works from our server (IP whitelist). Full setup instructions on the [Auto-trading page](/autotrading).',
        },
        {
          q: 'What exchange fees are included?',
          a: 'Our numbers already deduct Bybit fees — 0.055% × 2 sides = 0.11% round-trip per trade. The figures on the site are realistic — same as what you\'ll get trading along with us.',
        },
      ],
    },
    ctaSection: {
      title: 'Where to start',
      subtitle:
        'First check the stats and subscribe to the channel — catch live trades in real-time. Once you\'re convinced the results are what you want, enable auto-trading and let the strategies trade for you.',
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
        // Layout-mode boundary: cards layout up to 3 positions,
        // compact-table layout for 4+. If the count crosses that
        // threshold we need a full SSR re-render to switch layouts.
        var prevCount = parseInt(section.getAttribute('data-position-count') || '0', 10);
        var nextCount = positions.length;
        var modeChanged = (prevCount < 4 && nextCount >= 4) || (prevCount >= 4 && nextCount < 4);
        section.setAttribute('data-position-count', String(nextCount));
        if (hasNew || modeChanged) {
          // Soft reload — preserves scroll position via sessionStorage
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
  // Layout selector — full card grid for 1-3 positions (eye-catcher
  // hero treatment), compact dense table for 4+ (avoids dominating
  // the page when many strategies fire concurrently). The JS poller
  // patches the same data-* hooks regardless of layout, so live PnL
  // updates work for both. When the count crosses the 3→4 boundary,
  // the soft-reload path (also used for new trade IDs) re-renders
  // server-side with the right layout.
  const COMPACT_THRESHOLD = 4;
  const renderPositionRow = (p: import('../api/active-positions.js').ActivePositionView): string => {
    const sideEmoji = p.side === 'long' ? '🟢' : '🔴';
    const sideLabel = lang === 'en' ? (p.side === 'long' ? 'LONG' : 'SHORT') : (p.side === 'long' ? 'ЛОНГ' : 'ШОРТ');
    const pnlSign = p.pnlUsd >= 0 ? '+' : '−';
    const pnlPctSign = p.pnlPct >= 0 ? '+' : '−';
    const pnlCls2 = p.pnlUsd >= 0 ? 'pos' : 'neg';
    const arrow = (p.side === 'long' && p.currentPrice >= p.entry) ||
                  (p.side === 'short' && p.currentPrice <= p.entry) ? '↑' : '↓';
    const arrowCls = (p.side === 'long' && p.currentPrice >= p.entry) ||
                     (p.side === 'short' && p.currentPrice <= p.entry) ? 'pos' : 'neg';
    return `
      <a class="live-pos-row" href="/strategies/${escapeHtml(p.strategyCode)}" data-trade-id="${escapeHtml(p.tradeId)}" data-strategy="${escapeHtml(p.strategyCode)}">
        <span class="live-pos-row-id">${sideEmoji} <b>${escapeHtml(p.tradeId)}</b></span>
        <span class="live-pos-row-side side-${p.side}">${sideLabel}</span>
        <span class="live-pos-row-price mono">
          <span data-current-price>$${p.currentPrice.toFixed(4)}</span>
          <span class="live-pos-arrow ${arrowCls}" data-arrow>${arrow}</span>
        </span>
        <span class="live-pos-row-pnl ${pnlCls2}" data-pnl-block>
          <span data-pnl-usd>${pnlSign}$${Math.abs(p.pnlUsd).toFixed(2)}</span>
          <span class="live-pos-row-pct" data-pnl-pct>${pnlPctSign}${Math.abs(p.pnlPct).toFixed(2)}%</span>
        </span>
        <span class="live-pos-row-age" data-age data-opened-at="${p.openedAt}">${formatAge(p.ageMs, lang)}</span>
        <span class="live-pos-row-pnl-r mono" data-pnl-r>${(p.pnlR >= 0 ? '+' : '−')}${Math.abs(p.pnlR).toFixed(2)}R</span>
      </a>
    `;
  };
  const useCompact = activePositions.length >= COMPACT_THRESHOLD;
  const positionsBody = activePositions.length === 0
    ? ''
    : useCompact
      ? `<div class="live-pos-table" data-positions-grid data-mode="compact">
           <div class="live-pos-row live-pos-row-head">
             <span>${lang === 'en' ? 'Trade' : 'Сделка'}</span>
             <span>${lang === 'en' ? 'Side' : 'Сторона'}</span>
             <span>${lang === 'en' ? 'Price' : 'Цена'}</span>
             <span>P&amp;L</span>
             <span>${lang === 'en' ? 'Age' : 'Возраст'}</span>
             <span>R</span>
           </div>
           ${activePositions.map(renderPositionRow).join('')}
         </div>`
      : `<div class="live-pos-grid" data-positions-grid data-mode="cards">
           ${activePositions.map(renderPositionCard).join('')}
         </div>`;
  const livePositionsHtml = `
    <div class="home-section live-pos-section" id="live-positions" data-empty="${activePositions.length === 0 ? 'true' : 'false'}" data-position-count="${activePositions.length}">
      <div class="live-pos-header">
        <span class="live-pos-pulse" aria-hidden="true"></span>
        <h2 class="live-pos-title">${lang === 'en' ? 'Working right now' : 'В работе прямо сейчас'}</h2>
        <span class="live-pos-count" data-count-label>${activePositions.length === 0 ? (lang === 'en' ? 'no open positions' : 'нет открытых позиций') : `${activePositions.length} ${pluralRu(activePositions.length, 'позиция', 'позиции', 'позиций')}`}</span>
      </div>
      ${positionsBody}
    </div>
  `;

  // ---------- TOP 3 strategy preview ----------
  // Ranking: by live netPnlUsd descending (only strategies with closed
  // trades). Operator's spec: "show TOP 3 by live profit explicitly, rest
  // behind a link". If fewer than 3 have closed trades, we backfill from
  // strategies-by-backtest-CAGR so the section never looks empty.
  //
  // Layout:
  //   Left  → [STRAT-00X] SYMBOL TFm + plain-Russian backtest summary
  //   Right → Live PnL only when closed > 0
  const withLive = enabled.map((s) => ({ cfg: s, live: getStrategyLiveStats(s.id) }));
  const liveLeaders = withLive
    .filter((x) => x.live.closed > 0)
    .sort((a, b) => b.live.netPnlUsd - a.live.netPnlUsd);
  const noLiveYet = withLive
    .filter((x) => x.live.closed === 0)
    .sort((a, b) => (b.cfg.backtest?.cagrPct ?? 0) - (a.cfg.backtest?.cagrPct ?? 0));
  // Pad with no-live strategies if we have <3 live leaders, so the
  // marketing section always shows 3 cards and never looks under-baked.
  const top3 = [...liveLeaders, ...noLiveYet].slice(0, 3);
  const previewItems = top3
    .map(({ cfg: s, live }) => {
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
  // Funnel-shaped: 3 cards = SEE (free) → FOLLOW (free) → AUTOMATE (paid).
  // Autotrading card is the climactic CTA — gradient border + green button.
  const isRu = lang === 'ru';
  const cta1Title = isRu ? '1. Смотрите статистику' : '1. Browse stats';
  const cta1Body = isRu
    ? 'Откройте список стратегий — у каждой свой бэктест, live-сделки и график доходности. Проверяемо до копейки.'
    : 'Open the strategies list — each has its own backtest, live trades, and equity curve. Verifiable down to the cent.';
  const cta1Btn = isRu ? 'Все стратегии →' : 'All strategies →';

  const cta2Title = isRu ? '2. Подпишитесь на канал' : '2. Subscribe to channel';
  const cta2Body = isRu
    ? 'Получайте сигналы в Telegram сразу как срабатывают. Бесплатно. Можно повторять вручную или просто следить.'
    : 'Get signals in Telegram the moment they fire. Free. Follow manually or just observe.';
  const cta2Btn = isRu ? 'Telegram канал ↗' : 'Telegram channel ↗';

  const cta3Title = isRu ? '3. Подключите автотрейдинг' : '3. Enable auto-trading';
  const cta3Body = isRu
    ? 'Когда убедились что нравится — подключите свой Bybit через API-ключ и пусть стратегии торгуют за вас. 14 дней бесплатно, потом $50/мес.'
    : 'Once you like what you see — connect your Bybit via API key and let strategies trade for you. 14 days free, then $50/mo.';
  const cta3Btn = isRu ? 'Попробовать автотрейдинг →' : 'Try auto-trading →';

  const ctaHtml = `
    <div class="home-section">
      <h2 class="home-section-title">${escapeHtml(c.ctaSection.title)}</h2>
      <p class="home-section-sub">${escapeHtml(c.ctaSection.subtitle)}</p>
      <div class="funnel-cards">
        <div class="funnel-card">
          <div class="funnel-card-title">${escapeHtml(cta1Title)}</div>
          <div class="funnel-card-body">${escapeHtml(cta1Body)}</div>
          <a class="btn btn-ghost" href="/strategies">${escapeHtml(cta1Btn)}</a>
        </div>
        <div class="funnel-card">
          <div class="funnel-card-title">${escapeHtml(cta2Title)}</div>
          <div class="funnel-card-body">${escapeHtml(cta2Body)}</div>
          <a class="btn btn-ghost" href="${escapeHtml(c.telegramUrl)}" target="_blank" rel="noopener">${escapeHtml(cta2Btn)}</a>
        </div>
        <div class="funnel-card funnel-card-accent">
          <div class="funnel-card-title">${escapeHtml(cta3Title)}</div>
          <div class="funnel-card-body">${escapeHtml(cta3Body)}</div>
          <a class="btn btn-primary" href="/autotrading">${escapeHtml(cta3Btn)}</a>
        </div>
      </div>
    </div>
  `;

  // ---------- Flow diagram (visual «how it works») ----------
  // Frequent feedback: "I don't fully understand how it all works".
  // This is a non-technical 4-node pipeline showing the path from
  // LuxAlgo signal → our server → public channel → optional user
  // account. Plain CSS boxes + arrows, no heavy SVG. Lives between
  // hero and «Что доступно» so it's seen before the funnel CTA.
  const flowTitle = lang === 'en' ? 'How the system works (in 30 seconds)' : 'Как устроена система (за 30 секунд)';
  const flowSub = lang === 'en'
    ? 'A signal travels from LuxAlgo through our server to your Telegram and (optionally) to your Bybit account. Same data, same path, four hops.'
    : 'Сигнал проходит путь от LuxAlgo через наш сервер в ваш Telegram и (опционально) на ваш счёт Bybit. Те же данные, тот же путь, четыре шага.';
  const flowNodes = lang === 'en'
    ? [
        { icon: '🧮', title: 'LuxAlgo', body: 'Strategy fires a signal based on indicator conditions (e.g. "Contrarian + Trend Catcher + Money Flow"). Sent as a webhook to our server.' },
        { icon: '🤖', title: 'Our server', body: 'Receives the webhook, executes the trade on the SHADOW account, records it in the public DB. <50ms.' },
        { icon: '📡', title: 'Telegram channel', body: 'Trade is mirrored to @luxalgosignal with entry/exit price, size, and trade ID. Free for everyone.' },
        { icon: '💼', title: 'Your Bybit account', body: 'If you have auto-trading enabled — our server places the IDENTICAL trade on your account via your API key. Same time, same price, same direction.' },
      ]
    : [
        { icon: '🧮', title: 'LuxAlgo', body: 'Стратегия выдаёт сигнал по условиям индикаторов (например «Contrarian + Trend Catcher + Money Flow»). Отправляется вебхуком на наш сервер.' },
        { icon: '🤖', title: 'Наш сервер', body: 'Получает вебхук, открывает позицию на SHADOW-счёте, записывает в публичную БД. <50мс.' },
        { icon: '📡', title: 'Telegram канал', body: 'Сделка дублируется в @luxalgosignal с ценой входа/выхода, размером и ID сделки. Бесплатно для всех.' },
        { icon: '💼', title: 'Ваш счёт Bybit', body: 'Если у вас включён автотрейдинг — наш сервер делает ТАКУЮ ЖЕ сделку на вашем счёте через ваш API-ключ. То же время, та же цена, то же направление.' },
      ];
  const flowDiagramHtml = `
    <div class="home-section flow-section">
      <h2 class="home-section-title">${escapeHtml(flowTitle)}</h2>
      <p class="home-section-sub">${escapeHtml(flowSub)}</p>
      <div class="flow-diagram">
        ${flowNodes
          .map(
            (n, i) => `
              <div class="flow-node">
                <div class="flow-node-icon" aria-hidden="true">${n.icon}</div>
                <div class="flow-node-title">${escapeHtml(n.title)}</div>
                <div class="flow-node-body">${n.body}</div>
              </div>
              ${i < flowNodes.length - 1 ? '<div class="flow-arrow" aria-hidden="true">→</div>' : ''}
            `,
          )
          .join('')}
      </div>
      <div class="flow-footnote">
        ${lang === 'en'
          ? `<b>The shadow account is real money</b> on our own Bybit. So the public stats you see on /strategies aren't a simulation — they're actual fills with real commission. When you enable auto-trading, your account gets the same fills <em>at the same prices</em>, just on a different UID.`
          : `<b>Shadow-счёт — это настоящие деньги</b> на нашем Bybit. Поэтому публичная статистика на /strategies — не симуляция, а реальные исполнения с реальной комиссией. Когда вы включаете автотрейдинг, на вашем счёте проходят те же сделки <em>по тем же ценам</em>, просто на другом UID.`}
      </div>
    </div>
  `;

  // Top-right nav is now handled by site-header in pageShell.

  const body = `
    <div class="scroll-progress" aria-hidden="true"></div>
    ${heroHtml}
    ${livePositionsHtml}
    ${flowDiagramHtml}
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

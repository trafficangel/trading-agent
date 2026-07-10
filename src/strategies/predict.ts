import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, chmodSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { pageShell } from './landing.js';
import { getAuthedUser } from '../auth/routes.js';

/**
 * Public read-only pages for the /predict track (robotclaude.biz/predict).
 *
 * The track is an experimental Polymarket BTC Up/Down (5m) strategy sandbox,
 * ISOLATED from this Bybit trading-agent. This site only DISPLAYS each
 * strategy's public log — it never controls an engine and never shares
 * strategy params or keys.
 *
 * Layout:
 *   /predict                      — overview (cards per strategy)
 *   /predict/<slug>               — per-strategy page (description + stats)
 *   /predict/<slug>/status.json   — that strategy's raw JSON
 *
 * Each strategy publishes its own JSON status artifact (written by a separate
 * process). Path is configurable per strategy via env.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));
// dist/strategies/predict.js → repo root is two levels up; statuses live in data/.
const dataDir = join(moduleDir, '..', '..', 'data');

type StrategyDef = {
  slug: string; // URL segment
  engine?: string; // имя стратегии в реестре движка (--strategy) — для реальной торговли
  realEligible?: boolean; // можно выбрать для реальной торговли (по умолчанию — да, если есть engine)
  title: string;
  tagline: string;
  statusEnv: string; // env override for the JSON path
  statusFile: string; // default filename under data/
  liveFile: string; // real-time snapshot filename under data/ (written by engine)
  description: string[]; // plain-language paragraphs (HTML-escaped on render)
  showStakeCol: boolean; // show stake/coef columns in recent-rounds table
  hasLive?: boolean; // публикует ли движок лайв-снимок (live.json)
  retired?: boolean; // стратегия остановлена (гипотеза не подтвердилась)
  isTrap?: boolean; // dual-leg ловушка: особый рендер «сторона» (🔒 / однобоко)
  minDeposit?: number; // рекомендуемый минимальный банк (доля депозита) под стратегию, $
  recommendedReal?: number; // рекомендуемый банк ($) для перехода в реальную торговлю — показываем на карточке
  recommendedRealNote?: string; // пояснение к рекомендуемой сумме (сайзинг/капы)
  standalone?: boolean; // живой движок-сервис (не engine): сам читает namерение running.<slug>, оператор флипает кнопкой
  lossPatternFile?: string; // отчёт фонового майнера паттернов проигрыша (data/) — рендерим карточку
};

const STRATEGIES: StrategyDef[] = [
  {
    slug: 'lagedge',
    realEligible: false, // ЭНДШПИЛЬНЫЙ ЛАГ-КРАЙ: standalone-движок (не engine) — пишет predict-lagedge-status.json, сам читает намерение running.lagedge. СВОЙ рендер статуса shadow↔real (renderLagedge), кнопка Арм/Стоп на /predict/lagedge.
    title: '🟡 LagEdge · широкий shadow-трекер (15–60с)',
    tagline: 'Купить дешёвого фаворита (ask 0.35–0.80, сторона = знак distBinanceBp — куда ушёл спот от открытия раунда) ЛИМИТКОЙ в последние 15–60с. Широкий ОБЪЁМНЫЙ shadow-трекер (мягкие гейты: окно 15–60с, |dist|≥1.5) — меряет объёмное расширение без денег рядом с боевым узким tw.',
    statusEnv: 'PREDICT_LAGEDGE_STATUS',
    statusFile: 'predict-lagedge-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 50,
    recommendedRealNote: 'shadow-трекер: денег не касается; меряет широкие гейты для будущего реала',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Это не охотник по расхождению модели, а отдельная гипотеза: в последние 15–60с раунда цена дешёвого фаворита отстаёт от факта (лаг). Берём фаворита по ask 0.35–0.80, сторона = знак distBinanceBp (дистанция спота от собственного открытия Binance), входим ЛИМИТКОЙ с потолком. Бэктест узкого ядра: ROI до +50% net, край персистит ~88%.',
      'ШИРОКИЙ SHADOW-ТРЕКЕР. Этот контур — ТОЛЬКО ТЕНЬ (денег не касается). Намеренно мягкие гейты (окно 15–60с, |dist|≥1.5, ask 0.35–0.80) → больше входов: меряем, держится ли край при объёмном расширении, прежде чем тащить его в боевой узкий tw. Реальные деньги идут на отдельном движке lagedge-tw.',
      'ЧЕСТНО. Это исследовательский замер объёма: часть мягких сигналов слабее и может разворачиваться. Если широкая полоса в тени держит край — расширим и боевой tw; если просядет — оставим tw узким. Ноль денег здесь по определению.',
    ],
  },
  {
    slug: 'lagedge-btc5-mid',
    realEligible: true,
    title: '🔴 LagEdge-BTC5-MID · РЕАЛ · 5m adaptive',
    tagline: 'Боевой BTC 5m micro-real: окно 121-200с до конца, дешёвый фаворит ask 0.55-0.72, сторона = знак distBinanceBp. Порог движения адаптируется к волатильности: dist ≥ max(1.5bp, 0.8×vol15m), плюс spotMove-гейт против застоя. 5 акций, 50 тестовых ордеров, стоп −$15.',
    statusEnv: 'PREDICT_LAGEDGE_BTC5_MID_STATUS',
    statusFile: 'predict-lagedge-btc5-mid-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧТО ЛОВИТ. В середине эндшпиля 5m BTC иногда Polymarket ещё продаёт фаворита дешевле, чем подсказывает текущий Binance spot. Берём только 121-200 секунд до закрытия, когда цена не совсем последняя секунда, но направление уже видно.',
      'ФИЛЬТРЫ. Сторона = знак distBinanceBp (BTC ушёл выше открытия → UP, ниже → DOWN). Real-вход только при ask 0.55-0.72, spread ≤0.15, свежем spot/book и размере 5 акций. Порог dist адаптивный: max(1.5bp, 0.8×vol15m), чтобы в бурном рынке не принимать шум за edge.',
      'ЗАЩИТА ОТ ЗАСТОЯ. Дополнительно нужен spotMove ≥0.5bp с момента последнего изменения ask. Если dist есть, а spot не продолжил движение, сигнал пишется в shadow, но real-ордер не отправляется. Это защита от старой ловушки “дешёвый фаворит уже устарел”.',
    ],
  },
  {
    // ИССЛЕДОВАТЕЛЬСКИЙ ВАРИАНТ lagedge — ТОЛЬКО ТЕНЬ. realEligible:false и нет engine → реал-арм/гард
    // (/predict/real/start) для него закрыт; страница view-only без кнопки Арм/Стоп. Свой статус той же
    // формы, что lagedge → рендерится тем же renderLagedge(showArm=false).
    slug: 'lagedge-tw',
    realEligible: true,
    title: '🔴 LagEdge-TW · РЕАЛ · узкое окно 15-30с',
    tagline: 'Боевой узкий контур эндшпильного лаг-края: последние 15-30с раунда. Купить дешёвого фаворита (ask 0.35-0.72, сторона = знак distBinanceBp) ЛИМИТКОЙ с потолком +3¢ (анти-свип: не платим разворотам), 5 акций (~$3/ордер). РЕАЛ малым кэпом: авто-стоп −$25. shadow↔real меряются бок-о-бок.',
    statusEnv: 'PREDICT_LAGEDGE_TW_STATUS',
    statusFile: 'predict-lagedge-tw-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага дешёвого фаворита, но узкое окно входа 15-30с до закрытия (у широкого shadow-трекера — 15-60с) и более решительный порог |dist|≥3. Узкое окно у самого эндшпиля — край чище и резче.',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. Движок в режиме real: на квалифиц. сигналы (15-30с, ask 0.35-0.72, |dist|≥3) шлёт реальные FAK-лимитки 5 акций с потолком +3¢, параллельно считая теневой результат. Капы: авто-стоп −$25, ценовой потолок +3¢ (срезан с +10¢ 07-02: 22/78 филлов шли на ≥+3¢ дороже — худшая часть adverse selection). Таблица «теневой против реального» — видно, доезжает ли край в реальном исполнении.',
      'ЧЕСТНО. Деньги в реале идут, пока нажата «Армить» (сейчас армлен). Если реальный fill-rate низкий или зазор реал−shadow по цене большой — край в исполнении не доезжает. Стоп-кнопка возвращает в чистый shadow.',
    ],
  },
  {
    // ИССЛЕДОВАТЕЛЬСКИЙ ВАРИАНТ lagedge — ТОЛЬКО ТЕНЬ. realEligible:false и нет engine → реал-арм/гард закрыт.
    slug: 'lagedge-imb',
    realEligible: false,
    title: '🔴 LagEdge-IMB · РЕАЛ UP-only · orderflow-гейт',
    tagline: 'Эндшпильный лаг-край с orderflow-гейтом imb20 (дисбаланс стакана подтверждает сторону). РЕАЛ ТОЛЬКО UP (SIDE_ONLY): первый системный промоут graduation-гейта — imb|UP прошёл 7/7 строгих критериев (shadow n=255, WR 74.1% > безуб 64.4%, FDR-значим, 2 дня персиста), и реал-история подтверждает: UP +$22.08 (WR 73.6%), DOWN −$12.98 (61.1% < безуб — весь минус движка сидел в DOWN). 5 акций, потолок +3¢, авто-стоп −$10; shadow продолжает логировать ОБЕ стороны.',
    statusEnv: 'PREDICT_LAGEDGE_IMB_STATUS',
    statusFile: 'predict-lagedge-imb-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ ОТ LagEdge. Та же гипотеза лага (окно 15-60с), но вход разрешается только при подтверждении orderflow-гейтом imb20 — дисбаланс заявок в стакане смотрит в ту же сторону, что и сделка. Сигналы без подтверждения пропускаются (imbSkips).',
      'РЕАЛ UP-ONLY (07-02): армлен через control.running по системному промоуту 7/7; SIDE_ONLY=UP режет DOWN-минус, shadow логирует обе стороны. Статус — в панели «ТОРГУЕТ» наверху; карточка скрыта (realEligible:false), арм — операторский.',
    ],
  },
  {
    slug: 'lagedge-eth',
    realEligible: false, // СНЯТ С РЕАЛА: край мёртв (52% = реальная неэффективность, доказано Binance-реконструкцией). Движок жив в shadow, копит данные; не показываем карточкой.
    title: '🟡 LagEdge-ETH · shadow (край мёртв)',
    tagline: 'Тот же эндшпильный лаг-край, но на ETH — рынке в ~4× менее контестед, чем BTC (24 бота/раунд vs 103). Окно 15-30с, ask 0.35-0.72, |dist|≥3, потолок +10¢, 5 акций. РЕАЛ малым кэпом: 50 ордеров, авто-стоп −$15. Тень-бэктест: +19% ROI, оба пол-периода в плюс.',
    statusEnv: 'PREDICT_LAGEDGE_ETH_STATUS',
    statusFile: 'predict-lagedge-eth-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага дешёвого фаворита, что у BTC-tw, но на ETH. Идея: BTC переполнен HFT (103 бота/раунд → наливаемся лишь ~37%, снайперы забирают лучшие ask). ETH в ~4× менее контестед (24 бота) → наливаемся чаще, тень доезжает до реала. Край слабее (+19% тень vs +57% BTC), но реально снимается.',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. На квалифиц. сигналы ETH (15-30с, ask 0.35-0.72, |dist|≥3) шлёт реальные FAK-лимитки 5 акций с потолком +10¢, параллельно считая тень. Капы: 50 ордеров, авто-стоп −$15.',
      'ЧЕСТНО. Альт-гипотеза «менее контестед = лучше филл» проверяется вживую. Выборка пока малая — край ещё не доказан реалом. Стоп-кнопка возвращает в чистый shadow.',
    ],
  },
  {
    slug: 'lagedge-sol',
    realEligible: true,
    title: '🔴 LagEdge-SOL · РЕАЛ · альт (менее контестед)',
    tagline: 'Эндшпильный лаг-край на SOL — рынке в ~5× менее контестед, чем BTC (20 ботов/раунд vs 103). Окно 15-30с, ask 0.35-0.72, |dist|≥6, потолок +3¢, 5 акций. РЕАЛ малым кэпом: авто-стоп −$15. Тень-бэктест: +5.6% ROI, оба пол-периода в плюс.',
    statusEnv: 'PREDICT_LAGEDGE_SOL_STATUS',
    statusFile: 'predict-lagedge-sol-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага, но на SOL. BTC переполнен HFT (103 бота → филл ~37%); SOL в ~5× тише (20 ботов) → лучше наполнение, тень≈реал. Край скромнее (+5.6% тень), но менее оспариваемый.',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. На квалифиц. сигналы SOL (15-30с, ask 0.35-0.72, |dist|≥6) шлёт реальные FAK-лимитки 5 акций с потолком +3¢, параллельно тень. Капы: авто-стоп −$15.',
      'ЧЕСТНО. Проверяем вживую, доезжает ли скромный край на тихом рынке. Малая выборка. Стоп-кнопка → чистый shadow.',
    ],
  },
  {
    slug: 'lagedge-xrp',
    realEligible: false, // СНЯТ С РЕАЛА (заморожен в shadow) — карточку не показываем; статус в панели graduation-gate
    title: '🟡 LagEdge-XRP · shadow (снят с реала: −EV в исполнении)',
    tagline: 'Эндшпильный лаг-край на XRP — самом тихом из торгуемых (всего ~9 ботов/раунд vs BTC 103, в ~11× меньше гонки). Окно 15-30с, ask 0.35-0.72, |dist|≥3, потолок +10¢, 5 акций. РЕАЛ малым кэпом: 50 ордеров, авто-стоп −$15. Тень-бэктест: +6.1% ROI.',
    statusEnv: 'PREDICT_LAGEDGE_XRP_STATUS',
    statusFile: 'predict-lagedge-xrp-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага, но на XRP — самом малоконтестед рынке (9 ботов/раунд). Если альт-гипотеза верна, ИМЕННО здесь тень должна доезжать до реала почти целиком (мало снайперов). Край +6.1% тень.',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. На квалифиц. сигналы XRP (15-30с, ask 0.35-0.72, |dist|≥3) шлёт реальные FAK-лимитки 5 акций с потолком +10¢, параллельно тень. Капы: 50 ордеров, авто-стоп −$15.',
      'ЧЕСТНО. XRP — главный кандидат на «дом» стратегии (минимум гонки). Выборка пока малая. Стоп-кнопка → чистый shadow.',
    ],
  },
  {
    slug: 'lagedge-early',
    realEligible: false, // СНЯТ С РЕАЛА: тонкий край не выжил в исполнении (реал 46% → −$8.91). Движок в shadow; не показываем карточкой.
    title: '🟡 LagEdge-EARLY · shadow (BTC 45-60с)',
    tagline: 'ТЕСТ гипотезы: на 45-60с до закрытия фаворит ещё не очевиден → снайперов МЕНЬШЕ → наполнение может быть лучше, чем в забитом эндшпиле 15-25с. Та же логика, что сделала альты (меньше гонки = лучше филл), но на раннем окне BTC. Окно 45-60с, ask 0.35-0.72, |dist|≥3, 5 акций. РЕАЛ малым кэпом: авто-стоп −$10.',
    statusEnv: 'PREDICT_LAGEDGE_EARLY_STATUS',
    statusFile: 'predict-lagedge-early-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага, но вход НЕ в эндшпиле (15-25с), а РАНО — 45-60с до закрытия. Наблюдение: в shadow на 45-60 много объёма (n=81) при симметричном крае (UP≈43%, не тренд). Открытый вопрос — наливается ли это в реале. Гипотеза: рано = фаворит не очевиден = меньше HFT-гонки = выше филл.',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. На квалифиц. сигналы BTC в окне 45-60с шлёт реальные FAK-лимитки 5 акций с потолком +10¢, параллельно тень. Авто-стоп −$10. Сравниваем фил-рейт vs боевой эндшпиль tw (15-25с).',
      'ЧЕСТНО. Per-signal край здесь ТОНКИЙ (+$0.24 vs +$1.92 у эндшпиля 15-30) — большой shadow-PnL это ОБЪЁМ, не качество. Тонкий край может умереть в исполнении. Тест дешёвый: проверяем, лучше ли филл раннего окна и выживает ли край.',
    ],
  },
  {
    slug: 'lagedge-doge',
    realEligible: false, // СНЯТ С РЕАЛА (заморожен в shadow) — карточку не показываем; статус в панели graduation-gate
    title: '🟡 LagEdge-DOGE · shadow (снят с реала)',
    tagline: 'Эндшпильный лаг-край на DOGE — наименее контестый рынок (~3 бота/раунд vs BTC 103). Окно 15-30с, ask 0.35-0.72, |dist|≥3, потолок +10¢, 5 акций. РЕАЛ малым пробным кэпом: 50 ордеров, авто-стоп −$10.',
    statusEnv: 'PREDICT_LAGEDGE_DOGE_STATUS',
    statusFile: 'predict-lagedge-doge-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага, но на DOGE — самом тихом рынке (3 бота/раунд). Если «меньше гонки = лучше филл» верно, здесь тень должна доезжать почти целиком. Сигналы редкие (тонкая ликвидность).',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. На квалифиц. сигналы DOGE (15-30с, ask 0.35-0.72, |dist|≥3) шлёт реальные FAK-лимитки 5 акций с потолком +10¢, параллельно тень. Капы: 50 ордеров, авто-стоп −$10.',
      'ЧЕСТНО. Край НЕ доказан — выборка крошечная (n=2-4). Это проба наполнения на самой тихой монете; флор −$10 остановит дёшево, если не пойдёт. Стоп-кнопка → чистый shadow.',
    ],
  },
  {
    slug: 'lagedge-bnb',
    realEligible: false, // СНЯТ С РЕАЛА (заморожен в shadow) — карточку не показываем; статус в панели graduation-gate
    title: '🟡 LagEdge-BNB · shadow (снят с реала)',
    tagline: 'Эндшпильный лаг-край на BNB — один из самых тихих рынков (~4 бота/раунд vs BTC 103). Окно 15-30с, ask 0.35-0.72, |dist|≥3, потолок +10¢, 5 акций. РЕАЛ малым пробным кэпом: 50 ордеров, авто-стоп −$10.',
    statusEnv: 'PREDICT_LAGEDGE_BNB_STATUS',
    statusFile: 'predict-lagedge-bnb-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же гипотеза лага, но на BNB — тихом рынке (4 бота/раунд). Тест альт-гипотезы «меньше гонки = лучше филл» на ещё одной малоконтестой монете. Сигналы редкие.',
      'РЕАЛ-ТЕСТ МАЛЫМ КЭПОМ. На квалифиц. сигналы BNB (15-30с, ask 0.35-0.72, |dist|≥3) шлёт реальные FAK-лимитки 5 акций с потолком +10¢, параллельно тень. Капы: 50 ордеров, авто-стоп −$10.',
      'ЧЕСТНО. Край НЕ доказан — выборка крошечная (n=2). Проба наполнения; флор −$10 остановит дёшево. Стоп-кнопка → чистый shadow.',
    ],
  },
];

type RecentRound = {
  t: number | null;
  side: 'UP' | 'DOWN' | null;
  stake?: number | null;
  coef?: number | null;
  entrySecLeft?: number | null; // секунд до закрытия на момент входа
  prob?: number | null; // наша оценка вероятности, %
  edge?: number | null; // недооценка (наша оценка − цена), проц. пункты
  distanceBp?: number | null;
  stakeReason?: string | null; // расчёт ставки (почему именно столько)
  pnl: number;
  win: boolean;
  bothLegs?: boolean; // dual-leg-trap: захлопнулась ли ловушка (обе ноги)
  // Маркет-мейкинг (mm): факты по ногам — чтобы таблица показывала, что куплено
  // и как сформировался PnL (замок обеих ног / срез одной), а не одну ногу как «сторону».
  mmKind?: 'lock' | 'flatten' | null; // 'lock'=обе ноги, 'flatten'=одна нога срезана; null=одна нога до резолюции
  legUp?: { p: number; n: number } | null; // нога UP: цена входа p, объём n
  legDown?: { p: number; n: number } | null; // нога DOWN
  sell?: { side: 'UP' | 'DOWN'; price: number } | null; // цена среза (флэт)
  _strategy?: string; // подпись стратегии (для общего списка)
  _live?: boolean; // открытая (текущая) сделка — исход ещё не известен
  _secLeft?: number; // секунд до закрытия (для лайв-строки)
  _isTrap?: boolean; // строка стратегии-ловушки (особый рендер «сторона»)
};

type PredictStatus = {
  updatedAt: string;
  phase: { number: number; label: string };
  mode: string;
  rounds: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  maxDrawdown: number;
  avgStake?: number | null;
  sizing?: string; // 'kelly' для живых движков — размер по дробному Келли (не плоская ставка)
  bank?: number | null; // текущий компаундящий банк Келли ($)
  bank0?: number | null; // стартовый банк Келли ($)
  kellyFrac?: number | null; // доля Келли (0.125 = ⅛)
  maxLossStreak?: number; // макс. серия проигрышей подряд (риск для прогрессий)
  maxWinStreak?: number; // макс. серия выигрышей подряд
  avgCoef?: number | null; // средний коэффициент входа (1/цена)
  trapClosed?: number; // dual-leg-trap: раундов с захлопнутой ловушкой
  oneLegged?: number; // dual-leg-trap: раундов с одной ногой
  marketOutcomes?: { up: number; down: number }; // опционально: упрощённые экспортеры (dynprob) его не пишут
  modelOnline?: boolean; // m15online: модель непрерывно дообучается (walk-forward)
  modelTrainN?: number | null; // на скольких сыгранных раундах обучена текущая модель
  modelTrainedAt?: string | null; // когда модель последний раз дообучена
  // Боевой контур (m15live в режиме real) — поля статуса реальной торговли:
  engineMode?: string; // 'real' для боевого движка
  allowReal?: boolean; // боевые ордера разрешены
  flatStake?: number | null; // фикс. ставка боевого движка ($)
  maxLossUsd?: number | null; // авто-стоп: лимит убытка ($) — боевой кап
  maxOrders?: number | null; // авто-стоп: лимит ордеров за сессию
  maxSlip?: number | null; // шлюз ликвидности: макс. допустимое проскальзывание цены (доли)
  skipped?: number | null; // ШЛЮЗ ЛИКВИДНОСТИ: входов, отменённых из-за тонкого стакана (НЕ сделки)
  openCount?: number | null; // открытых позиций сейчас
  evaluated?: number | null; // сколько раундов движок перебрал (для UX «работает, но фильтр не совпал»)
  coefBuckets?: { range: string; n: number; winRate: number | null; breakeven: number | null }[]; // винрейт по диапазонам коэф входа
  lastRoundAt?: number | null;
  recentRounds?: RecentRound[];
  equityCurve?: { t: number | null; slug: string; pnl: number; cumulative: number }[]; // опционально: если нет — строим из recentRounds
};

function statusPath(s: StrategyDef): string {
  return process.env[s.statusEnv] ?? join(dataDir, s.statusFile);
}

function readStatus(s: StrategyDef): PredictStatus | null {
  try {
    const p = statusPath(s);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as PredictStatus;
  } catch {
    return null;
  }
}

function readLive(s: StrategyDef): unknown | null {
  try {
    const p = join(dataDir, s.liveFile);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Лайв-панель: рынок + наша сделка + таймер. Обновляется клиентским опросом. */
function livePanel(s: StrategyDef): string {
  const slug = JSON.stringify(s.slug);
  return (
    `<div class="pd-card pd-live">` +
    `<h2>Лайв · текущий раунд <span id="pl-timer" class="pl-timer">—</span></h2>` +
    `<div class="pl-sides">` +
    `<div class="pl-side pl-side-up"><span class="pl-side-lbl">UP</span><span id="pl-up" class="pl-price">—</span><span id="pl-up-k" class="pl-k">—</span></div>` +
    `<div class="pl-side pl-side-down"><span class="pl-side-lbl">DOWN</span><span id="pl-down" class="pl-price">—</span><span id="pl-down-k" class="pl-k">—</span></div>` +
    `</div>` +
    `<div class="pl-meta"><span id="pl-asset">BTC</span> <span id="pl-px">—</span> · цель <span id="pl-target">—</span> · отрыв <span id="pl-gap">—</span><span id="pl-lead"></span></div>` +
    `<div id="pl-pos" class="pl-pos">—</div>` +
    `</div>` +
    `<script>(function(){` +
    `var slug=${slug};var slotStart=null;var slotEnd=null;var lastUpd=0;` +
    `function $(i){return document.getElementById(i);}` +
    `function set(i,v){var e=$(i);if(e)e.textContent=v;}` +
    `function fmt(ms){if(ms<0)ms=0;var s=Math.floor(ms/1000);return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}` +
    `function cents(p){return p!=null?Math.round(p*100)+'¢':'—';}` +
    `function coef(p){return p?'×'+(1/p).toFixed(2):'—';}` +
    `function usd(n){return n!=null?'$'+n.toLocaleString('ru-RU',{maximumFractionDigits:2}):'—';}` +
    `function tick(){var t=$('pl-timer');if(!t)return;if(!slotEnd||Date.now()-lastUpd>25000){t.textContent='ожидание данных';return;}var now=Date.now();if(slotStart&&now<slotStart)t.textContent='старт через '+fmt(slotStart-now);else if(now<slotEnd)t.textContent=fmt(slotEnd-now)+' до закрытия';else t.textContent='раунд закрыт';}` +
    `async function poll(){try{var r=await fetch('/predict/'+slug+'/live.json',{cache:'no-store'});if(!r.ok)return;var d=await r.json();lastUpd=Date.now();slotStart=d.slotStartMs;slotEnd=d.slotEndMs;` +
    `set('pl-up',cents(d.up&&d.up.ask));set('pl-up-k',coef(d.up&&d.up.ask));set('pl-down',cents(d.down&&d.down.ask));set('pl-down-k',coef(d.down&&d.down.ask));` +
    `var asset=d.asset||'BTC';set('pl-asset',asset);var px=(asset==='ETH')?d.eth:d.btc;set('pl-px',usd(px));set('pl-target',usd(d.target));var g=(px!=null&&d.target!=null)?px-d.target:null;set('pl-gap',g!=null?(g>=0?'+':'−')+'$'+Math.abs(g).toFixed(2):'—');var le=$('pl-lead');if(le)le.textContent=(d.btc!=null&&asset!=='BTC')?(' · BTC-лидер '+usd(d.btc)):'';` +
    `var p=d.position;if(!p){$('pl-pos').innerHTML=d.note?('⏭ '+d.note):'⚪ Открытой позиции нет — ждём сигнал';}else if(p.side==='BOTH'){$('pl-pos').innerHTML='🟢 Ловушка: обе ноги набраны · вложено '+usd(p.stake)+(d.lockedProfit!=null?(' · заперта прибыль +$'+d.lockedProfit+'/акция'):'');}else{$('pl-pos').innerHTML='🟢 В сделке: <b class=\"'+(p.side==='UP'?'pd-up':'pd-down')+'\">'+p.side+'</b> · ставка '+usd(p.stake)+(p.entryCoef?(' · коэф '+p.entryCoef):'');}` +
    `}catch(e){}}` +
    `poll();setInterval(poll,2000);setInterval(tick,1000);tick();` +
    `})();</script>`
  );
}

// ── НОВЫЙ ВИДЖЕТ: живой полный BTC 5m стакан + поедание уровней (данные из status-json) ──
const BTC_OB_STATUS = process.env.PREDICT_BTC_OB_STATUS ?? join(dataDir, 'predict-btc-orderbook-status.json');

function obReadStatus(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(BTC_OB_STATUS, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const obNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type ObLevel = { price: number; size: number; delta: number; state: string };

function obParseLevel(raw: unknown): ObLevel | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const price = obNum(o.price);
  const size = obNum(o.size);
  if (price == null || size == null) return null;
  const delta = obNum(o.delta) ?? 0;
  const state = typeof o.state === 'string' ? o.state : 'flat';
  return { price, size, delta, state };
}

function obCentsTxt(p: number | null): string {
  return p != null ? `${Math.round(p * 100)}¢` : '—';
}
function obSizeTxt(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n >= 100 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0);
}

function obRenderLadder(levels: ObLevel[], askLo: number, askHi: number, bestAsk: number | null): string {
  if (!levels.length) return `<div class="pd-muted-td" style="padding:14px 0">нет уровней</div>`;
  let maxLog = 0;
  for (const l of levels) {
    const lg = Math.log10(1 + l.size);
    if (lg > maxLog) maxLog = lg;
  }
  if (maxLog <= 0) maxLog = 1;
  const ordered = [...levels].sort((a, b) => b.price - a.price);
  const rows = ordered
    .map((l) => {
      const wpct = Math.max(2, Math.min(100, Math.round((Math.log10(1 + l.size) / maxLog) * 100)));
      const barColor =
        l.state === 'eaten' ? '#e5616c' :
        l.state === 'gone' ? '#7a3540' :
        l.state === 'added' ? '#4ad991' :
        '#3a4250';
      const barOpacity = l.state === 'gone' ? '0.35' : '0.85';
      const fade = l.state === 'gone' ? ' ob-fade' : '';
      const inZone = l.price >= askLo - 1e-9 && l.price <= askHi + 1e-9;
      const isBest = bestAsk != null && Math.abs(l.price - bestAsk) < 1e-9;
      const zoneStyle = inZone ? 'border-left:3px solid #d6a13a;padding-left:5px' : 'border-left:3px solid transparent;padding-left:5px';
      const priceCls = isBest ? 'pd-pos' : (inZone ? '' : 'pd-muted-td');
      const deltaTxt =
        l.state === 'eaten' ? `<span class="pd-neg">▼${obSizeTxt(Math.abs(l.delta))}</span>` :
        l.state === 'added' ? `<span class="pd-pos">▲${obSizeTxt(Math.abs(l.delta))}</span>` :
        l.state === 'gone' ? `<span class="pd-neg" style="opacity:.6">съеден</span>` :
        '';
      return (
        `<div class="ob-row${fade}" data-price="${l.price.toFixed(4)}" style="display:flex;align-items:center;gap:8px;font-size:13px;padding:1px 0;${zoneStyle}">` +
        `<span class="${priceCls}" style="width:46px;text-align:right;font-variant-numeric:tabular-nums">${esc(obCentsTxt(l.price))}</span>` +
        `<span style="flex:1;height:14px;position:relative;background:#0c0f15;border-radius:3px;overflow:hidden">` +
        `<span style="position:absolute;left:0;top:0;bottom:0;width:${wpct}%;background:${barColor};opacity:${barOpacity}"></span>` +
        `</span>` +
        `<span style="width:52px;text-align:right;font-variant-numeric:tabular-nums" class="pd-muted-td">${esc(obSizeTxt(l.size))}</span>` +
        `<span style="width:62px;text-align:right;font-variant-numeric:tabular-nums">${deltaTxt}</span>` +
        `</div>`
      );
    })
    .join('');
  return rows;
}

function renderBtcOrderbook(): string {
  const st = obReadStatus();
  const now = Date.now();
  const ts = st ? obNum(st.ts) : null;
  const ageSec = ts != null ? Math.round((now - ts) / 1000) : null;
  const stale = ageSec == null || ageSec > 10;

  const askLo = (st ? obNum(st.askLo) : null) ?? 0.5;
  const askHi = (st ? obNum(st.askHi) : null) ?? 0.72;
  const slug = st && typeof st.slug === 'string' ? st.slug : '';
  const secLeft = st ? obNum(st.secLeft) : null;
  const dist = st ? obNum(st.distBinanceBp) : null;
  const fav = st && (st.fav === 'up' || st.fav === 'down') ? (st.fav as 'up' | 'down') : null;
  const favLabel = fav === 'up' ? 'UP' : fav === 'down' ? 'DOWN' : '—';
  const favCls = fav === 'up' ? 'pd-up' : fav === 'down' ? 'pd-down' : 'pd-muted-td';

  const favKey = fav ?? 'up';
  const favBlock = (st ? (st[favKey] as Record<string, unknown> | undefined) : undefined) ?? {};
  const bestAsk = obNum((favBlock as Record<string, unknown>).bestAsk);
  const rawLevels = Array.isArray((favBlock as Record<string, unknown>).levels)
    ? ((favBlock as Record<string, unknown>).levels as unknown[])
    : [];
  const levels = rawLevels.map(obParseLevel).filter((l): l is ObLevel => l != null);

  const stOk = st ? st.ok !== false : false;
  const ladder = (!st || !stOk || !levels.length)
    ? `<div class="pd-muted-td" style="text-align:center;padding:22px">${st ? 'ожидание книги активного раунда…' : 'ожидание данных сервиса…'}</div>`
    : obRenderLadder(levels, askLo, askHi, bestAsk);

  const distTxt = dist != null ? `${dist > 0 ? '+' : ''}${dist.toFixed(1)}bp` : '—';
  const secTxt = secLeft != null ? `${secLeft}с` : '—';
  const coef = bestAsk != null && bestAsk > 0 ? (1 / bestAsk) : null;

  const staleBadge = stale
    ? `<span class="pd-neg" style="font-size:12px"> · ⏳ данные ${ageSec == null ? 'нет' : ageSec + 'с'} (устар.)</span>`
    : `<span class="pd-pos" style="font-size:12px"> · 🟢 live ${ageSec}с</span>`;

  return (
    `<div class="pd-card" id="btc-ob-card"${stale ? ' style="opacity:.6"' : ''}>` +
    `<style>@keyframes obFade{0%{opacity:1}100%{opacity:.18}}.ob-fade{animation:obFade .9s ease-out forwards}</style>` +
    `<h2>📖 Живой стакан BTC · поедание уровней (5-мин раунд)</h2>` +
    `<p class="pd-sub" id="btc-ob-meta" style="margin:-6px 0 12px;font-size:12px">` +
    `Полная лесенка ask токена-фаворита Polymarket (<b class="${favCls}">${favLabel}</b>, сторона по знаку отрыва Binance ${esc(distTxt)}). ` +
    `Дешёвые уровни снизу — их «съедают» первыми. <span class="pd-neg">▼красный</span> = уровень едят, ` +
    `<span style="opacity:.6">затухание</span> = съели, <span class="pd-pos">▲зелёный</span> = долили. ` +
    `Золотая рамка — наша зона лимитки ${Math.round(askLo * 100)}–${Math.round(askHi * 100)}¢ (потолок ${Math.round(askHi * 100)}¢).` +
    `</p>` +
    `<div id="btc-ob-head" style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px;margin-bottom:10px">` +
    `<span>раунд <b>${esc(slug || '—')}</b></span>` +
    `<span>осталось <b id="btc-ob-sec" class="${secLeft != null && secLeft <= 30 ? 'pd-neg' : ''}">${esc(secTxt)}</b></span>` +
    `<span>best ask <b id="btc-ob-bestask">${esc(obCentsTxt(bestAsk))}</b></span>` +
    `<span>коэф <b>${coef != null ? '×' + coef.toFixed(2) : '—'}</b></span>` +
    `<span id="btc-ob-stale">${staleBadge}</span>` +
    `</div>` +
    `<div id="btc-ob-ladder" style="max-height:520px;overflow-y:auto;font-family:ui-monospace,Menlo,monospace">${ladder}</div>` +
    `</div>` +
    obClientScript()
  );
}

function obClientScript(): string {
  return (
    `<script>(function(){` +
    `function cents(p){return p!=null?Math.round(p*100)+'¢':'—';}` +
    `function sz(n){if(n==null)return '—';if(n>=1000)return (n/1000).toFixed(1)+'k';return n>=100?String(Math.round(n)):n.toFixed(n<10?1:0);}` +
    `function num(v){return (typeof v==='number'&&isFinite(v))?v:null;}` +
    `function ladder(levels,askLo,askHi,bestAsk){` +
    `if(!levels||!levels.length)return '<div class=\"pd-muted-td\" style=\"text-align:center;padding:22px\">ожидание книги активного раунда…</div>';` +
    `var maxLog=0;for(var i=0;i<levels.length;i++){var lg=Math.log10(1+(levels[i].size||0));if(lg>maxLog)maxLog=lg;}if(maxLog<=0)maxLog=1;` +
    `var ord=levels.slice().sort(function(a,b){return b.price-a.price;});` +
    `return ord.map(function(l){` +
    `var w=Math.max(2,Math.min(100,Math.round((Math.log10(1+(l.size||0))/maxLog)*100)));` +
    `var bc=l.state==='eaten'?'#e5616c':l.state==='gone'?'#7a3540':l.state==='added'?'#4ad991':'#3a4250';` +
    `var bo=l.state==='gone'?'0.35':'0.85';var fade=l.state==='gone'?' ob-fade':'';` +
    `var inZone=(l.price>=askLo-1e-9&&l.price<=askHi+1e-9);` +
    `var isBest=(bestAsk!=null&&Math.abs(l.price-bestAsk)<1e-9);` +
    `var zs=inZone?'border-left:3px solid #d6a13a;padding-left:5px':'border-left:3px solid transparent;padding-left:5px';` +
    `var pc=isBest?'pd-pos':(inZone?'':'pd-muted-td');` +
    `var dt=l.state==='eaten'?('<span class=\"pd-neg\">▼'+sz(Math.abs(l.delta||0))+'</span>'):l.state==='added'?('<span class=\"pd-pos\">▲'+sz(Math.abs(l.delta||0))+'</span>'):l.state==='gone'?'<span class=\"pd-neg\" style=\"opacity:.6\">съеден</span>':'';` +
    `return '<div class=\"ob-row'+fade+'\" style=\"display:flex;align-items:center;gap:8px;font-size:13px;padding:1px 0;'+zs+'\">'+` +
    `'<span class=\"'+pc+'\" style=\"width:46px;text-align:right;font-variant-numeric:tabular-nums\">'+cents(l.price)+'</span>'+` +
    `'<span style=\"flex:1;height:14px;position:relative;background:#0c0f15;border-radius:3px;overflow:hidden\"><span style=\"position:absolute;left:0;top:0;bottom:0;width:'+w+'%;background:'+bc+';opacity:'+bo+'\"></span></span>'+` +
    `'<span style=\"width:52px;text-align:right;font-variant-numeric:tabular-nums\" class=\"pd-muted-td\">'+sz(l.size)+'</span>'+` +
    `'<span style=\"width:62px;text-align:right;font-variant-numeric:tabular-nums\">'+dt+'</span></div>';` +
    `}).join('');}` +
    `function set(id,html){var e=document.getElementById(id);if(e)e.innerHTML=html;}` +
    `async function poll(){try{` +
    `var r=await fetch('/predict/btc-orderbook.json',{cache:'no-store'});if(!r.ok)return;var d=await r.json();if(!d)return;` +
    `var card=document.getElementById('btc-ob-card');` +
    `var age=(typeof d.ts==='number')?Math.round((Date.now()-d.ts)/1000):null;var stale=(age==null||age>10);` +
    `if(card)card.style.opacity=stale?'0.6':'1';` +
    `var askLo=num(d.askLo)!=null?d.askLo:0.5;var askHi=num(d.askHi)!=null?d.askHi:0.72;` +
    `var fav=(d.fav==='up'||d.fav==='down')?d.fav:'up';var fb=d[fav]||{};` +
    `var bestAsk=num(fb.bestAsk);var levels=Array.isArray(fb.levels)?fb.levels:[];` +
    `if(d.ok===false)levels=[];` +
    `set('btc-ob-ladder',ladder(levels,askLo,askHi,bestAsk));` +
    `var sec=num(d.secLeft);var se=document.getElementById('btc-ob-sec');if(se){se.textContent=(sec!=null?sec+'с':'—');se.className=(sec!=null&&sec<=30)?'pd-neg':'';}` +
    `set('btc-ob-bestask',cents(bestAsk));` +
    `set('btc-ob-stale',stale?('<span class=\"pd-neg\" style=\"font-size:12px\"> · ⏳ данные '+(age==null?'нет':age+'с')+' (устар.)</span>'):('<span class=\"pd-pos\" style=\"font-size:12px\"> · 🟢 live '+age+'с</span>'));` +
    `}catch(e){}}` +
    `poll();setInterval(poll,1000);` +
    `})();</script>`
  );
}


// ── ДИНАМИЧЕСКАЯ СИСТЕМА: панель монитора стратегий (graduation-gate, read-only) ──
const MON_STATUS = process.env.PREDICT_MON_STATUS ?? join(dataDir, 'predict-strategy-monitor.json');

type MonSlice = {
  sliceId: string; level: number; asset?: string; n_uniq: number; net?: number | null;
  avgCoef?: number | null; maxLossStreak?: number;
  WR_point: number | null; WR_be_gate: number | null; effect_pp: number | null;
  walkForwardOk?: boolean; fdr_pass?: boolean; holdout?: { ok?: boolean };
  status: string; recommendation: string; why?: string;
  readiness?: { passed: number; total: number; stage: string; missing: string[]; checks?: { short: string; label: string; ok: boolean }[] };
  transfer?: Record<string, unknown>;
};
type MonEngineParams = {
  askBand?: number[]; secWindow?: number[]; imbConfirm?: boolean; sizeShares?: number; maxLossUsd?: number;
  distMin?: number; volDistFrac?: number;
};
type MonArtifact = {
  updatedAt?: string; slices?: MonSlice[]; engines?: string[];
  engineParams?: Record<string, MonEngineParams>;
  fdrByLevel?: Record<string, { m: number; passed: number }>;
  fdrCaveat?: string;
  sideHints?: Record<string, unknown>[];
  distHints?: Record<string, unknown>[];
  sizing?: MonSizing;
};
// ── АВТО-САЙЗЕР (дисплей target-размера ставки; монитор считает read-only) ──
type MonSizeScenario = { raw?: number | null; target?: number | null; binding?: string };
type MonSizeEng = {
  ok: boolean; reason?: string;
  cur?: number; target?: number; gate?: string; binding?: string; direction?: string;
  liqBelowFloor?: boolean; provisional?: boolean;
  inputs?: {
    price?: number; priceSrc?: string; p?: number; pSrc?: string;
    wilson_lo?: number | null; be?: number | null; nReal?: number;
    askSizeP10?: number | null; askSizeP25?: number | null;
    b?: number; fstar?: number; stake?: number; sharesKellyRaw?: number;
    bankEng?: number; bankFull?: number; capLiq?: number | null; capBank?: number | null;
    capDepth?: number | null; capDepthPctl?: string;
  };
  // fracTable: sizeShares на ПОЛНОМ распределяемом банке — «сырой» Kelly (fullRaw) → «итог» (full, после капов/пола).
  // split* — на банке ÷N (корреляц. риск-кап), для сравнения.
  fracTable?: Record<string, { fullRaw?: number | null; full?: number | null; splitRaw?: number | null; split?: number | null }>;
  scenarios?: { confirm?: MonSizeScenario; weaken?: MonSizeScenario; bankUp?: MonSizeScenario };
};
type MonSizing = {
  wallet?: number | null; walletSrc?: string; reserve?: number; distributable?: number;
  nArmed?: number; armed?: string[];
  bankMode?: string; bankSplit?: number; bankFull?: number; activeBank?: number;
  kellyFrac?: string; kellyFracVal?: number; liqFrac?: number; liqPctl?: string; floor?: number; globalUtil?: number;
  globalValve?: { triggered?: boolean; shrink?: number; utilCap?: number; sumBefore?: number; sumStake?: number } | null;
  sumActiveStake?: number; sumFitsWallet?: boolean;
  nLiqBinding?: number; nLiqBelowFloor?: number; mode?: string;
  engines?: Record<string, MonSizeEng>;
};

function monRead(): MonArtifact | null {
  try {
    if (!existsSync(MON_STATUS)) return null;
    return JSON.parse(readFileSync(MON_STATUS, 'utf8')) as MonArtifact;
  } catch {
    return null;
  }
}

const monPct = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) + '%' : '—';
const monUsd = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? (v >= 0 ? '+$' : '−$') + Math.abs(v).toFixed(2) : '—';
const monCent = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? (v >= 0 ? '+' : '') + Math.round(v * 100) + '¢' : '—';
const monStage = (st: string): string => {
  switch (st) {
    case 'ready': return '<b class="pd-pos">🟢 ГОТОВ</b>';
    case 'close': return '<b style="color:#e0b341">🟡 БЛИЗКО</b>';
    case 'maturing': return '<span style="color:#d6a13a">🟠 ЗРЕЕТ</span>';
    case 'loser': return '<b class="pd-neg">🔴 ЛУЗЕР</b>';
    default: return '<span class="pd-muted-td">⚪ РАНО</span>';
  }
};
// имя строки: МОНЕТА (крупно) · движок (тускло) · доп. Если движок = монете, не дублируем.
// уникальное читаемое имя стратегии (вместо серого слага). Слаг — в тултипе для операций.
const STRAT_NAME: Record<string, string> = {
  tw: 'Снайпер', imb: 'Ордерфлоу', 'tw-narrow': 'Дешёвый', early: 'Дальний',
  sol: 'Лаг', xrp: 'Лаг', doge: 'Лаг', bnb: 'Лаг', eth: 'Даун',
  'xrp-late': 'Поздний', 'xrp-early': 'Ранний', 'sol-early': 'Ранний', lagedge: 'База',
};
const monName = (coin: string, eng: string, extra = ''): string => {
  const nm = STRAT_NAME[eng] ?? eng;
  return `<b>${esc(coin)}</b> <span style="color:#aeb6c2;font-weight:600" title="движок: ${esc(eng)}">${esc(nm)}</span>${extra ? ' ' + extra : ''}`;
};
// размер ставки движка (акций на сделку) — из живого статуса
const engSizeShares = (eng: string): number | null => {
  try {
    const p = join(dataDir, `predict-lagedge-${eng}-status.json`);
    if (!existsSync(p)) return null;
    const st = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return obNum(st.sizeShares);
  } catch {
    return null;
  }
};
// примерный уровень налива для гип. реал-оценки кандидатов (грубо; альты наливаются выше)
const FILL_EST = 0.5;

// ── вотчдог: авто-стоп события (Дмитрий: «на сайте показывать если сработал стоп») ──
const WD_EVENTS = process.env.PREDICT_WD_EVENTS ?? join(dataDir, 'predict-watchdog-events.json');
type WdEvent = { ts?: string; eng?: string; action?: string; reasons?: string[]; hysteresisRuns?: number };
const wdReadEvents = (): WdEvent[] => {
  try {
    if (!existsSync(WD_EVENTS)) return [];
    const d = JSON.parse(readFileSync(WD_EVENTS, 'utf8')) as { events?: WdEvent[] };
    return Array.isArray(d.events) ? d.events : [];
  } catch {
    return [];
  }
};
const agoTxt = (iso?: string): string => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
};

// ── САЙЗЕР: формат «текущий → цель» + тултип «почему» + мини-таблица дробей + сценарии (read-only дисплей) ──
const SZ_GATE_COL: Record<string, string> = { CONFIRMED: '#4ad991', UNCONFIRMED: '#8b96a5', WEAKENING: '#e5616c' };
const SZ_GATE_TXT: Record<string, string> = {
  CONFIRMED: 'край подтверждён в реале (Wilson-низ выше безубытка) — можно растить',
  UNCONFIRMED: 'край не подтверждён (Wilson-низ ещё не выше безубытка) — держим текущий/пол, не растим на надежде',
  WEAKENING: 'край слабеет (точечный реал-WR ниже безубытка, −EV) — снижаем к полу',
};
const SZ_FR_LBL: Record<string, string> = { eighth: '⅛K', quarter: '¼K', half: '½K' };
const SZ_BIND_TXT: Record<string, string> = {
  kelly: 'дробный Kelly', liq: 'ликвидность стакана', bank: 'доля банка',
  floor: 'биржевой пол 5', 'liq<floor': 'стакан тоньше мин.лота (½·глубина < 5)',
  hold: 'держим текущий', 'global-valve': 'глобальный клапан банка',
};
// ячейка «размер» в таблице ТОРГУЕТ: текущий → цель (цвет по направлению), тултип с полным «почему».
function sizeCell(eng: string, sz?: MonSizing): string {
  const e = sz?.engines?.[eng];
  const cur = engSizeShares(eng);
  if (!e || !e.ok || e.target == null) {
    return `<td style="text-align:right">${cur != null ? cur + ' акц' : '—'}</td>`;
  }
  const i = e.inputs ?? {};
  const gate = e.gate ?? 'UNCONFIRMED';
  const col = SZ_GATE_COL[gate] ?? '#8b96a5';
  const dir = e.direction === 'up' ? '▲' : e.direction === 'down' ? '▼' : '=';
  const curN = e.cur ?? cur ?? 0;
  const same = e.target === curN;
  const wl = i.wilson_lo, be = i.be;
  const gateChk = wl != null && be != null
    ? `Wilson-низ ${(wl * 100).toFixed(1)}% ${wl > be ? '>' : '≤'} безуб ${(be * 100).toFixed(1)}%`
    : 'нет реал-данных';
  const prov = e.provisional ? ' · ⚠ предварительно (shadow-фолбэк, мало реала)' : '';
  const liqWarn = e.liqBelowFloor
    ? `\n⚠ стакан тоньше мин.лота: ½·${i.capDepthPctl ?? 'p25'}(=${i.capDepth ?? '—'}) < пол 5 — движок на грани исполнимости, вероятно проскальзывание`
    : '';
  const tip = esc(
    `${SZ_GATE_TXT[gate] ?? gate}${prov}\n` +
    `реал-WR ${i.p != null ? (i.p * 100).toFixed(1) + '%' : '—'} (${i.pSrc ?? '?'}) · ${gateChk}\n` +
    `цена входа ${i.price ?? '—'} (${i.priceSrc ?? '?'}) · нетто-коэф b=${i.b ?? '—'} · nReal=${i.nReal ?? 0}\n` +
    `полный банк $${i.bankFull ?? '—'} (актив.банк $${i.bankEng ?? '—'}) · Kelly f*=${i.fstar ?? '—'} → стейк $${i.stake ?? '—'} = ${i.sharesKellyRaw ?? '—'} акц (сырой)\n` +
    `глубина p10=${i.askSizeP10 ?? '—'} p25=${i.askSizeP25 ?? '—'} (опора капа ${i.capDepthPctl ?? 'p25'}=${i.capDepth ?? '—'}) · капы: ликвидность→${i.capLiq ?? '∞'} · банк→${i.capBank ?? '∞'} · связывает: ${SZ_BIND_TXT[e.binding ?? ''] ?? e.binding ?? ''}${liqWarn}`,
  );
  const step = (e as { stepSignal?: { ok?: boolean; to?: number; why?: string } }).stepSignal;
  const stepBadge = step?.ok
    ? ` <span style="color:#e0b341;font-weight:700" title="${esc(`ЛЕСТНИЦА: мягкая ступень выполнена (${step.why ?? ''}) — можно ВРУЧНУЮ поднять до ${step.to} акц (чистое окно после). Решение оператора; авто ничего не меняет.`)}">↗${step.to}</span>`
    : '';
  return (
    `<td style="text-align:right;white-space:nowrap" title="${tip}">` +
    `${curN} <span style="color:${col}">${dir} ${e.target}</span>` + stepBadge +
    `${same ? '' : ' акц'}` +
    `${e.liqBelowFloor ? ' <span style="color:#e5616c" title="стакан тоньше мин.лота">⚠</span>' : ''}` +
    `</td>`
  );
}
// раскрывающийся блок под таблицей ТОРГУЕТ: per-eng таблица дробей × банк + сценарии «что станет».
function renderSizingDetail(engines: string[], sz?: MonSizing): string {
  if (!sz || !sz.engines) return '';
  const armed = engines.filter((e) => sz.engines?.[e]?.ok);
  if (!armed.length) return '';
  const frOf = (k?: string) => (k ? SZ_FR_LBL[k] ?? k : '');
  // «сырой→итог» ячейка: если кап/пол не срезал (raw≈target) — одно число; иначе показываем оба.
  const rawArrow = (raw?: number | null, tgt?: number | null): string => {
    if (raw == null && tgt == null) return '—';
    if (raw == null) return `${tgt}`;
    if (tgt == null) return `${raw}`;
    return Math.abs(raw - tgt) < 0.5 ? `${tgt}` : `${raw}→${tgt}`;
  };
  const cards = armed.map((eng) => {
    const e = sz.engines![eng]!;
    const i = e.inputs ?? {};
    const gate = e.gate ?? 'UNCONFIRMED';
    const col = SZ_GATE_COL[gate] ?? '#8b96a5';
    const ft = e.fracTable ?? {};
    const activeFr = sz.kellyFrac;
    // ФИКС-РЕВЬЮ: таблица дробей — на ПОЛНОМ распределяемом банке (fullRaw→full), чтобы дроби расходились.
    // Показываем «сырой Kelly → итог»: сырой = до капов (дифференциация ⅛/¼/½ видна всегда),
    // итог = что реально уйдёт на биржу (после ½·глубина + пол).
    const cell = (fk: string) => {
      const c = ft[fk];
      const isActive = fk === activeFr;
      const txt = rawArrow(c?.fullRaw, c?.full);
      return `<td style="text-align:right${isActive ? ';color:#4ad991;font-weight:700' : ''}">${txt}${isActive ? ' ●' : ''}</td>`;
    };
    const sc = e.scenarios ?? {};
    const scTxt = (s?: MonSizeScenario) => rawArrow(s?.raw, s?.target);
    const liqLine = e.liqBelowFloor
      ? `<div class="pd-neg" style="font-size:11px;margin:2px 0">⚠ ½·${esc(i.capDepthPctl ?? 'p25')}-глубина (=${i.capDepth ?? '—'}) &lt; пол 5 акц: стакан не переваривает даже минимальный лот — реальное проскальзывание вероятно, движок на грани исполнимости.</div>`
      : '';
    const provLine = e.provisional
      ? `<div style="font-size:11px;margin:2px 0;color:#d6a13a">⚠ предварительно: p/цена с shadow-фолбэка (реал-филлов &lt; 15) — числа ориентировочные, не подтверждены реалом.</div>`
      : '';
    return (
      `<div style="border:1px solid #1e2430;border-radius:6px;padding:8px 10px;margin:6px 0;font-size:12px">` +
      `<div style="font-weight:600">📏 ${esc(eng)}: <span class="pd-muted-td">сейчас</span> ${e.cur} → ` +
      `<span style="color:${col}">цель ${e.target} акц</span> ` +
      `<span style="color:${col};font-size:11px">(${gate === 'CONFIRMED' ? 'растим' : gate === 'WEAKENING' ? 'к полу' : 'держим'}; ` +
      `связывает: ${esc(SZ_BIND_TXT[e.binding ?? ''] ?? e.binding ?? '')})</span></div>` +
      liqLine + provLine +
      `<div class="pd-muted-td" style="margin:3px 0">` +
      `реал-WR <b>${i.p != null ? (i.p * 100).toFixed(0) + '%' : '—'}</b> (${esc(i.pSrc ?? '')}) · ` +
      `Wilson-низ ${i.wilson_lo != null ? (i.wilson_lo * 100).toFixed(0) + '%' : '—'} · ` +
      `безуб ${i.be != null ? (i.be * 100).toFixed(0) + '%' : '—'} · ` +
      `цена ${i.price ?? '—'} · b=${i.b ?? '—'} · nReal=${i.nReal ?? 0} · полный банк $${i.bankFull ?? '—'} · ` +
      `Kelly f*=${i.fstar ?? '—'} · глубина p10=${i.askSizeP10 ?? '—'}/p25=${i.askSizeP25 ?? '—'} (опора ${esc(i.capDepthPctl ?? 'p25')})` +
      `</div>` +
      `<table class="pd-mon-tbl" style="margin:4px 0;font-size:12px"><tr>` +
      `<th title="размер акций при разных дробях Kelly на полном распределяемом банке — политику выбираешь ты. сырой→итог: сырой Kelly до капов → что уйдёт на биржу">${esc(eng)}: размер (сырой Kelly→итог)</th>` +
      `<th style="text-align:right">⅛K</th><th style="text-align:right">¼K</th><th style="text-align:right">½K</th></tr>` +
      `<tr><td>полный банк $${sz.bankFull}</td>${cell('eighth')}${cell('quarter')}${cell('half')}</tr>` +
      `</table>` +
      `<div class="pd-muted-td" style="font-size:11px">● = активная политика (${esc(frOf(activeFr))}). «сырой→итог»: сырой = Kelly до капов (видно, как дробь двигает размер); итог = после ½·глубина + пол 5. ` +
      `<b>Сценарии</b> (сырой→итог): край ПОДТВЕРДИТСЯ → <b>${scTxt(sc.confirm)}</b> · ` +
      `край ОСЛАБНЕТ → <b>${scTxt(sc.weaken)}</b> (пол) · банк вырастет ($200) → <b>${scTxt(sc.bankUp)}</b> акц.</div>` +
      `</div>`
    );
  }).join('');
  const valve = sz.globalValve?.triggered
    ? ` · <span class="pd-neg">клапан сработал ×${sz.globalValve.shrink} (Σ>${sz.globalUtil}·кошелёк)</span>`
    : '';
  const liqSummary = (sz.nLiqBelowFloor ?? 0) > 0
    ? ` · <span class="pd-neg">⚠ у ${sz.nLiqBelowFloor} движ. стакан тоньше мин.лота (½·глубина < 5)</span>`
    : (sz.nLiqBinding ?? 0) > 0
      ? ` · <span style="color:#d6a13a">ликвидность держит цель у ${sz.nLiqBinding} движ.</span>`
      : '';
  const plank =
    `<div style="margin:8px 0 4px;padding:8px 10px;background:#0f1318;border:1px solid #1e2430;border-radius:6px;font-size:11px;color:#8b96a5;line-height:1.7">` +
    `<b style="color:#cfd6e0">📏 Авто-сайзер · <span class="pd-muted-td">режим ${esc(sz.mode ?? 'ДИСПЛЕЙ')} (деньги НЕ трогает, только показывает)</span></b><br>` +
    `кошелёк <b>$${sz.wallet ?? '—'}</b> (${esc(sz.walletSrc ?? '')}) · армлено ${sz.nArmed ?? 0} · резерв ${Math.round((sz.reserve ?? 0) * 100)}% · ` +
    `распределяемый банк <b>$${sz.distributable ?? sz.bankFull ?? '—'}</b> · корреляц. риск-кап (÷N) $${sz.bankSplit ?? '—'} · ` +
    `политика <b>${esc(frOf(sz.kellyFrac))}</b> · ` +
    `Σ целевых стейков $${sz.sumActiveStake ?? '—'} (${sz.sumFitsWallet ? '≤ кошелёк ✓' : '⚠ > кошелёк'})${valve}${liqSummary}<br>` +
    `<span style="opacity:.85">Таблица дробей считается на <b>полном распределяемом банке</b> — чтобы ⅛/¼/½ Kelly реально расходились и ты видел выбор политики (split÷N — отдельный корреляц. риск-кап, не банк Kelly). ` +
    `«сырой→итог» = Kelly до капов → что уйдёт на биржу (пол 5 + ½·глубина ${esc(sz.liqPctl ?? 'p25')} стакана). ` +
    `Растим размер только когда край ПОДТВЕРЖДЁН (Wilson-низ реал-WR выше безубытка); при слабеющем — к полу.</span>` +
    `</div>`;
  return (
    `<details style="margin:2px 0 10px"><summary style="cursor:pointer;font-size:12px;color:#6aa3e0">` +
    `📏 Как считаются размеры ставок (текущий → цель, почему, сценарии) — раскрыть</summary>` +
    plank + cards + `</details>`
  );
}

function renderStrategyMonitor(): string {
  const mon = monRead();
  if (!mon || !Array.isArray(mon.slices)) {
    return (
      `<div class="pd-card"><h2>🎯 Динамическая система стратегий · graduation-gate</h2>` +
      `<p class="pd-muted-td">Монитор ещё не сформировал артефакт — появится после первого почасового прогона.</p></div>`
    );
  }
  const running = (readRealControl().running ?? {}) as Record<string, unknown>;
  const isArmed = (eng: string) => !!running['lagedge-' + eng];
  const ep = mon.engineParams ?? {};
  const paramsStr = (eng: string): string => {
    const p = ep[eng]; if (!p) return '';
    const bits: string[] = [];
    const ab = p.askBand; if (Array.isArray(ab) && ab.length === 2) bits.push(`ask ${Math.round((ab[0] ?? 0) * 100)}–${Math.round((ab[1] ?? 0) * 100)}¢`);
    const sw = p.secWindow; if (Array.isArray(sw) && sw.length === 2) bits.push(`вход ${sw[0]}–${sw[1]}с`);
    if (typeof p.distMin === 'number') bits.push(typeof p.volDistFrac === 'number' && p.volDistFrac > 0 ? `dist≥max(${p.distMin.toFixed(1)}, ${p.volDistFrac.toFixed(1)}×vol15m)` : `dist≥${p.distMin.toFixed(1)}bp`);
    if (p.imbConfirm) bits.push('orderflow-фильтр');
    return bits.join(' · ');
  };
  const paramsLine = (eng: string): string => {
    const ps = paramsStr(eng);
    return ps ? `<div class="pd-muted-td" style="font-size:10px;margin-top:1px">⚙ ${esc(ps)}</div>` : '';
  };

  const slices = mon.slices;
  const l0: Record<string, MonSlice> = {};
  const l1: Record<string, { UP?: MonSlice; DOWN?: MonSlice }> = {};
  for (const s of slices) {
    const parts = s.sliceId.split('|');
    const eng = parts[0];
    if (!eng) continue;
    if (s.level === 0) l0[eng] = s;
    else if (s.level === 1) {
      (l1[eng] ??= {});
      if (parts[1] === 'UP') l1[eng].UP = s;
      else if (parts[1] === 'DOWN') l1[eng].DOWN = s;
    }
  }
  const engines = (mon.engines ?? Object.keys(l0)).slice().sort();
  const trf = (eng: string) => (l0[eng]?.transfer ?? {}) as Record<string, unknown>;
  const engNet = (eng: string) => obNum(trf(eng).status_realNetPnlCum) ?? obNum(trf(eng).realNetPnl);
  const engNReal = (eng: string) => obNum(trf(eng).nReal);

  const upd = mon.updatedAt ? Date.parse(mon.updatedAt) : NaN;
  const ageMin = Number.isFinite(upd) ? Math.round((Date.now() - upd) / 60000) : null;
  const fresh = ageMin != null && ageMin < 90;
  const freshTxt = ageMin == null ? 'нет данных' : `${fresh ? '🟢' : '⏳'} обновлён ${ageMin} мин назад`;
  const cnt = (st: string) => slices.filter((s) => s.status === st).length;

  // ── 🟢 ТОРГУЕТ ──
  const tradingEngs = engines.filter(isArmed);
  const tradeRows = tradingEngs.map((eng) => {
    const s = l0[eng]; const t = trf(eng);
    const hasSess = t.sessionArmedAt != null;   // сброшен на чистый лист с момента арма
    const net = hasSess ? obNum(t.sessionRealNet) : (obNum(t.status_realNetPnlCum) ?? obNum(t.realNetPnl));
    const nReal = hasSess ? obNum(t.sessionNReal) : obNum(t.nReal);
    const rwr = hasSess ? obNum(t.sessionRealWR) : obNum(t.realWR_point);
    const fill = hasSess ? obNum(t.sessionFillRate) : obNum(t.fillRatePct);
    const gap = hasSess ? obNum(t.sessionGapP50) : obNum(t.priceGapP50);
    const r = s?.readiness;
    const stageCell = r ? monStage(r.stage) : '—';
    const freshTag = hasSess ? ' <span style="font-size:9px;color:#6aa3e0" title="чистый лист с момента арма; прежние тесты — в истории/state">🆕 с&nbsp;арма</span>' : '';
    return (
      `<tr><td>${monName(s?.asset ?? eng, eng)}${freshTag}${paramsLine(eng)}</td>` +
      `<td>${stageCell}</td>` +
      sizeCell(eng, mon.sizing) +
      `<td style="text-align:right">${s?.avgCoef != null ? '×' + s.avgCoef.toFixed(2) : '—'}</td>` +
      `<td style="text-align:right" class="${(s?.maxLossStreak ?? 0) >= 6 ? 'pd-neg' : ''}">${s?.maxLossStreak ?? '—'}</td>` +
      `<td class="${(net ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}" style="text-align:right;font-weight:600">${monUsd(net)}</td>` +
      `<td style="text-align:right">${nReal ?? '—'}</td>` +
      `<td style="text-align:right">${monPct(rwr)}</td>` +
      `<td style="text-align:right" class="pd-muted-td">${monPct(s?.WR_point)}</td>` +
      `<td style="text-align:right"><span class="${(fill ?? 100) < 50 ? 'pd-neg' : ''}">${fill != null ? Math.round(fill) + '%' : '—'}</span> <span class="pd-muted-td">/ ${monCent(gap)}</span></td></tr>`
    );
  }).join('');
  const tradingBlock = tradingEngs.length
    ? `<table class="pd-mon-tbl"><tr><th>🟢 торгует</th><th>стадия</th><th title="акций на сделку: текущий → целевой авто-размер (наведи на ячейку — почему)">разм→цель</th><th title="средний коэффициент входа = 1/ask">коэф</th><th title="макс. серия проигрышей подряд">сер−</th><th>net</th><th title="реальных филлов">n</th><th title="WR реал">WR re</th><th title="WR shadow">WR sh</th><th title="доля налива / медианный priceGap">fill/gap</th></tr>${tradeRows}</table>` +
      renderSizingDetail(tradingEngs, mon.sizing) +
      `<p class="pd-muted-td" style="font-size:11px;margin:4px 0 0">разм→цель = текущий размер → авто-цель (наведи — почему; детали и сценарии в «📏 Как считаются размеры»). <b>🆕 с&nbsp;арма</b> = net/n/WR считаются с ЧИСТОГО ЛИСТА (с момента арма) — прежние тесты в истории/state, не в дисплее. Без метки — накопленный net (при разных размерах).</p>`
    : `<p class="pd-muted-td">Нет армленных движков.</p>`;

  // ── «⏸ был в реале» бейдж: паузу влили в таблицу кандидатов (отдельного блока нет) ──
  const exRealBadge = (eng: string): string => {
    const n = engNReal(eng) ?? 0;
    if (n <= 0) return '';
    return ` <span style="font-size:10px;color:#d6a13a;white-space:nowrap" title="был короткий тест-арм реалом, сейчас заморожен (shadow продолжает)">⏸ был тест-арм: ${n} филл. ${monUsd(engNet(eng))}</span>`;
  };

  // ── 🟡 ОТСЛЕЖИВАЕТСЯ → готовность: ⇅ОБЕ (L0, как движок реально торгует) + UP/DOWN (L1, поиск асимметрии) ──
  const stageOrder: Record<string, number> = { ready: 0, close: 1, maturing: 2, early: 3, loser: 4 };
  const dirEntries: { so: number; passed: number; eff: number; html: string }[] = [];
  const pushSlice = (eng: string, sideHtml: string, s: MonSlice) => {
    const r = s.readiness ?? { passed: 0, total: 7, stage: 'early', missing: [], checks: [] };
    const ready = r.stage === 'ready';
    const checklist = (r.checks ?? [])
      .map((c) =>
        `<span title="${esc(c.label)}" style="display:inline-block;margin:0 2px 1px 0;padding:0 4px;border-radius:3px;font-size:9px;white-space:nowrap;` +
        `${c.ok ? 'background:rgba(74,217,145,.16);color:#4ad991' : 'background:#1a1f29;color:#6b7480'}">` +
        `${c.ok ? '✓' : '○'}${esc(c.short)}</span>`)
      .join('');
    dirEntries.push({
      so: stageOrder[r.stage] ?? 3, passed: r.passed, eff: s.effect_pp ?? -999,
      html:
        `<tr${ready ? ' style="background:rgba(74,217,145,.10)"' : ''}>` +
        `<td>${monName(s.asset ?? eng, eng, sideHtml)}${exRealBadge(eng)}${paramsLine(eng)}</td>` +
        `<td>${monStage(r.stage)}</td>` +
        `<td style="text-align:right">${s.n_uniq}</td>` +
        `<td style="text-align:right">${monPct(s.WR_point)}</td>` +
        `<td style="text-align:right">${s.avgCoef != null ? '×' + s.avgCoef.toFixed(2) : '—'}</td>` +
        `<td style="text-align:right" class="${(s.maxLossStreak ?? 0) >= 6 ? 'pd-neg' : ''}">${s.maxLossStreak ?? '—'}</td>` +
        `<td style="text-align:right" class="${(s.effect_pp ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}">${s.effect_pp != null ? (s.effect_pp >= 0 ? '+' : '') + s.effect_pp.toFixed(0) + 'пп' : '—'}</td>` +
        `<td class="${(s.net ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}" style="text-align:right;white-space:nowrap">${s.net != null ? `${monUsd(s.net)}<span class="pd-muted-td"> → ${monUsd(s.net * FILL_EST)}</span>` : '—'}</td>` +
        `<td style="min-width:175px">${checklist || '<span class="pd-muted-td">—</span>'}</td></tr>`,
    });
  };
  for (const eng of engines) {
    if (isArmed(eng)) continue;   // уже в реале → показан в 🟢 ТОРГУЕТ (с готовностью), здесь не дублируем
    if (l0[eng]) pushSlice(eng, `<span style="color:#6aa3e0;font-weight:600">⇅ ОБЕ</span>`, l0[eng]);
    const sides = l1[eng];
    if (sides?.UP) pushSlice(eng, `<b class="pd-up">UP</b>`, sides.UP);
    if (sides?.DOWN) pushSlice(eng, `<b class="pd-down">DOWN</b>`, sides.DOWN);
  }
  dirEntries.sort((a, b) => a.so - b.so || b.passed - a.passed || b.eff - a.eff);
  const armedNote =
    `<p class="pd-muted-td" style="font-size:11px;margin:2px 0 4px">Кандидаты в shadow (армленные — выше в 🟢 ТОРГУЕТ). <span style="color:#d6a13a">⏸ был в реале</span> = торговался ранее, сейчас заморожен. Наведи курсор на значок критерия/заголовок — подсказка.</p>`;
  const AUDIT_BANNER = '<div style="margin:8px 0;padding:10px 12px;background:#1a1710;border:1px solid #6b5a1e;border-radius:6px;font-size:12px;color:#d6c78a;line-height:1.6">' + '<b style="color:#e0c94a">🟡 AUDIT MODE — shadow-кандидаты под re-validation</b><br>' + 'Shadow-кандидаты временно под re-validation после freshness-fix (07-07). Старые <b>7/7</b>/<b>ГОТОВ</b> основаны на <b>pre-fix shadow</b> (частично фантом из-за замороженного стакана коллектора) и <b>не являются основанием для сайзинга/промоута</b>. Ждём executable-shadow window. Real PnL и деньги ниже — реальны, без изменений.' + '</div>';
  const dirBlock = AUDIT_BANNER + '<div style="opacity:.6;border-left:2px solid #6b5a1e;padding-left:8px">' + (dirEntries.length
    ? armedNote +
      `<table class="pd-mon-tbl"><tr><th>🟡 кандидаты <span style="color:#b89b3a;font-weight:400;font-size:10px">· pre-fix shadow, re-validating</span></th><th>стадия</th><th>n</th><th>WR</th><th title="средний коэффициент входа = 1/ask">коэф</th><th title="макс. серия проигрышей подряд">сер−</th><th title="винрейт − безубыток (направленный край)">край</th><th title="доход shadow → гип. реал при ~${Math.round(FILL_EST * 100)}% налива">доход sh→re</th><th title="7 критериев готовности (порядок как в легенде ниже); наведи на значок">критерии ✓</th></tr>${dirEntries.map((e) => e.html).join('')}</table>` +
      `<p class="pd-muted-td" style="font-size:11px;margin:4px 0 0">Доход shadow = накопленный PnL, если бы налились ВСЕ сигналы по котировке. Гип. реал ≈ shadow × ~${Math.round(FILL_EST * 100)}% налива — грубая оценка СВЕРХУ и только на НАЛИВ. ВАЖНО: это НЕ учитывает перенос края — эмпирически shadow-край часто не доезжает в реал (early +91→−9, doge +32→−8 на реал-филлах). Истинный результат знает только реал-трансфер-гейт.</p>`
    : `<p class="pd-muted-td">Все кандидаты уже в реале — новых нет.</p>`) + '</div>';

  const hints = [...(mon.sideHints ?? []), ...(mon.distHints ?? [])];
  const hintsBlock = hints.length
    ? `<div style="margin-top:8px;font-size:12px"><b>Подсказки оператору:</b><ul style="margin:4px 0 0">${hints
        .map((h) => `<li>${esc(String(h.eng ?? ''))} → ${esc(String(h.recommendation ?? ''))}: ${esc(String(h.why ?? ''))}</li>`)
        .join('')}</ul></div>`
    : '';

  const legendBlock =
    `<div style="margin:2px 0 12px;padding:9px 11px;background:#0f1318;border:1px solid #1e2430;border-radius:6px;font-size:11px;color:#8b96a5;line-height:1.7">` +
    `<b style="color:#cfd6e0">📋 Чек-лист «критерии ✓» — 7 порогов готовности к реалу (в этом порядке):</b><br>` +
    `<b class="pd-pos">n</b> — данных ≥150 уникальных раундов (не «горячий отрезок») · ` +
    `<b class="pd-pos">FDR</b> — край значим (точный биномиальный тест + поправка на мультитест) · ` +
    `<b class="pd-pos">край</b> — винрейт ≥8пп над безубытком (запас на проскальзывание) · ` +
    `<b class="pd-pos">WF</b> — walk-forward: держится на обеих половинах истории · ` +
    `<b class="pd-pos">HO</b> — hold-out: подтверждён на отложенных 20% (n≥40, значимо) · ` +
    `<b class="pd-pos">ev</b> — bootstrap-низ прибыли >0 (не случайна) · ` +
    `<b class="pd-pos">дни</b> — стабилен ≥2 дня подряд<br>` +
    `<span style="opacity:.85">Все 7 ✓ → 🟢 ГОТОВ к малому реал-пробнику. ○ серым — критерий ещё не выполнен. Наведи на значок — подсказка.</span>` +
    `</div>`;

  const wdEvents = wdReadEvents();
  const wdBlock = wdEvents.length
    ? `<div style="margin:0 0 12px;padding:9px 11px;background:#1a1410;border:1px solid #6b4a1a;border-radius:6px;font-size:12px">` +
      `<b style="color:#e0b341">🛡️ Вотчдог — авто-стопы (пауза при ухудшении данных):</b>` +
      wdEvents.slice(-6).reverse().map((e) =>
        `<div style="margin-top:4px;font-size:11px">` +
        (e.action === 'paused'
          ? '<b class="pd-neg">🛑 СНЯТ</b>'
          : '<span style="color:#e0b341">⚠️ кандидат на стоп (наблюдение)</span>') +
        ` <b>${esc(e.eng ?? '')}</b> — ${esc((e.reasons ?? []).join('; '))} <span class="pd-muted-td">· ${esc(agoTxt(e.ts))}</span></div>`).join('') +
      `</div>`
    : `<div style="margin:0 0 10px;font-size:11px" class="pd-muted-td">🛡️ Вотчдог активен (авто-пауза при ухудшении данных, с гистерезисом) — 0 срабатываний, движки здоровы.</div>`;

  // ── 💰 ДЕНЬГИ (реал, не бумага) — честный итог против «всё зелёное, а мы в минусе» ──
  const rdRaw = mon as unknown as { realDaily?: Array<{ day: string; n: number; wr: number | null; net: number }>; realTotal?: number };
  const rd = rdRaw.realDaily ?? [];
  const rTotal = obNum(rdRaw.realTotal);
  const wallet = obNum((mon.sizing as Record<string, unknown> | undefined)?.['wallet']);
  let moneyBlock = '';
  if (rd.length) {
    const today = rd[rd.length - 1];
    const cells = rd.map((d) => {
      const pos = d.net >= 0;
      return (
        `<td style="text-align:center;padding:3px 7px;border-bottom:none">` +
        `<div class="pd-muted-td" style="font-size:9px">${esc(d.day)}</div>` +
        `<div class="${pos ? 'pd-pos' : 'pd-neg'}" style="font-weight:700;font-size:13px">${monUsd(d.net)}</div>` +
        `<div class="pd-muted-td" style="font-size:9px">${d.n}сд·${d.wr != null ? Math.round(d.wr) + '%' : '—'}</div></td>`
      );
    }).join('');
    moneyBlock =
      `<div style="border:1px solid #34405a;border-radius:8px;padding:9px 12px;margin:0 0 12px;background:rgba(18,23,33,.6)">` +
      `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:baseline;font-size:13px">` +
      `<b style="font-size:14px">💰 Реал — живые деньги</b>` +
      (wallet != null ? `<span class="pd-muted-td">кошелёк <b style="color:#e6e9ef">$${wallet.toFixed(2)}</b></span>` : '') +
      (today ? `<span class="pd-muted-td">сегодня <b class="${today.net >= 0 ? 'pd-pos' : 'pd-neg'}">${monUsd(today.net)}</b></span>` : '') +
      (rTotal != null ? `<span class="pd-muted-td">итог за всё время <b class="${rTotal >= 0 ? 'pd-pos' : 'pd-neg'}">${monUsd(rTotal)}</b></span>` : '') +
      `</div>` +
      `<table style="border-collapse:collapse;margin-top:5px"><tr>${cells}</tr></table>` +
      `<div class="pd-muted-td" style="font-size:10px;margin-top:3px">Фактические реал-филлы ВСЕХ движков по дням (включая уже снятые — их убытки тоже наши). ` +
      `Зелёные суммы у «кандидатов» ниже — <b>бумага</b> (shadow) для отбора, НЕ деньги; деньги только здесь и в «🟢 торгует».</div>` +
      `</div>`;
  }

  const fdrL = mon.fdrByLevel ?? {};
  const lv = (k: string) => `${fdrL[k]?.passed ?? 0}/${fdrL[k]?.m ?? 0}`;
  return (
    `<div class="pd-card">` +
    `<style>.pd-mon-tbl{border-collapse:collapse;width:100%;margin:6px 0 14px;font-size:13px}` +
    `.pd-mon-tbl th,.pd-mon-tbl td{border-bottom:1px solid #1e2430;padding:4px 8px;text-align:left}` +
    `.pd-mon-tbl th{color:#8b96a5;font-weight:600;font-size:11px;text-transform:uppercase}</style>` +
    `<h2>🎯 Динамическая система стратегий · graduation-gate</h2>` +
    `<p class="pd-sub" style="margin:-6px 0 10px;font-size:12px">` +
    `Каждая стратегия оценивается и как <b style="color:#6aa3e0">⇅ ОБЕ</b> стороны (как движок реально торгует — берёт фаворита любой стороны), и по отдельным <b class="pd-up">UP</b>/<b class="pd-down">DOWN</b> (поиск односторонней асимметрии). Монитор раз в час ранжирует всё по 7 строгим критериям от 🟢 ГОТОВ к реалу до 🔴 ЛУЗЕР. ` +
    `Реал армится <b>вручную</b> (авто-арм спроектирован, но выключен, пока край не доказан). ` +
    `<span class="${fresh ? 'pd-pos' : 'pd-neg'}">${esc(freshTxt)}</span></p>` +
    `<div style="font-size:12px;margin-bottom:10px">` +
    `<span class="pd-pos" title="прошёл все 7 критериев на БУМАГЕ (shadow) — достоин малого реал-пробника; это ещё НЕ доказанный деньгами край">✅ бумага-OK: ${cnt('proven-shadow')}</span> · ` +
    `<span class="pd-pos" title="край подтверждён РЕАЛЬНЫМИ деньгами (реал-трансфер-гейт)">💰 реал-OK: ${cnt('real-confirmed')}</span> · ` +
    `<span class="pd-neg" title="реал опроверг бумагу — снят">демоут: ${cnt('demote')}</span> · ` +
    `<span class="pd-muted-td" title="копят статистику">наблюдение: ${cnt('watch')}</span></div>` +
    moneyBlock + wdBlock + tradingBlock + dirBlock + legendBlock + hintsBlock +
    `<p class="pd-muted-td" style="font-size:11px;margin-top:8px;border-top:1px solid #1e2430;padding-top:8px">` +
    `Стадии: 🟢 ГОТОВ (7/7 критериев → малый реал-пробник) · 🟡 БЛИЗКО (5-6) · 🟠 ЗРЕЕТ (3-4) · ⚪ РАНО (1-2) · 🔴 ЛУЗЕР (край<0). ` +
    `⚠️ Даже 🟢 ГОТОВ = «достоин малого пробника», НЕ «доказанный край» (межмоторный FDR приближён — BTC-движки делят раунды) — финальная защита ручной малый тест + реал-трансфер-гейт. ` +
    `FDR по уровням: L0 ${lv('0')}, L1 ${lv('1')}, L2 ${lv('2')}.</p>` +
    `</div>`
  );
}


function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function fmtUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// Время ОТКРЫТИЯ позиции по Москве (UTC+3), ЧЧ:ММ — «на какой минуте вошли».
function mskHHMM(ms: number): string {
  const d = new Date(ms + 3 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function agoText(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 90) return `${sec} сек назад`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} мин назад`;
  return `${Math.round(min / 60)} ч назад`;
}

function freshnessPill(updatedAt: string): string {
  const ts = Date.parse(updatedAt);
  const fresh = Number.isFinite(ts) && Date.now() - ts < 10 * 60 * 1000;
  const cls = fresh ? 'pd-fresh-ok' : 'pd-fresh-stale';
  const label = fresh ? `онлайн · обновлено ${agoText(ts)}` : `данные устарели · ${agoText(ts)}`;
  return `<span class="pd-fresh ${cls}"><span class="pd-dot"></span>${esc(label)}</span>`;
}

/** Inline SVG equity curve — no external chart lib (CSP blocks third-party). */
// Спарклайн скользящего КРАЯ (винрейт − безубыток) по окну сделок — тренд эффективности стратегии.
function edgeSparkline(rounds: RecentRound[]): string {
  const tr = rounds.filter((r) => !r._live && r.coef != null && (r.coef ?? 0) > 0 && r.t != null).sort((a, b) => a.t! - b.t!);
  const WIN = 10;
  if (tr.length < WIN + 3) return '';
  const series: number[] = [];
  for (let i = WIN - 1; i < tr.length; i++) {
    const w = tr.slice(i - WIN + 1, i + 1);
    const winrate = (w.filter((r) => r.win).length / WIN) * 100;
    const be = (w.reduce((a, r) => a + 1 / (r.coef ?? 1), 0) / WIN) * 100;
    series.push(winrate - be);
  }
  const W = 700, H = 90, PAD = 24;
  const min = Math.min(-5, ...series), max = Math.max(5, ...series), span = max - min || 1;
  const x = (i: number) => PAD + (i / (series.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const last = series[series.length - 1]!;
  const color = last >= 0 ? '#4ad991' : '#e5616c';
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    `<div class="pd-card"><h2>Тренд края (окно ${WIN} сделок)</h2>` +
    `<svg viewBox="0 0 ${W} ${H}" class="pd-chart"><line x1="${PAD}" y1="${y(0).toFixed(1)}" x2="${W - PAD}" y2="${y(0).toFixed(1)}" stroke="#2a313c" stroke-dasharray="4 4"/>` +
    `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/></svg>` +
    `<div class="pd-foot">Скользящий край (винрейт − безубыток) по последним ${WIN} сделкам. Выше нуля = в плюсе на отрезке; вверх = край появляется, вниз = тает.</div></div>`
  );
}

function equitySvg(points: NonNullable<PredictStatus['equityCurve']>): string {
  if (points.length < 2) {
    return `<div class="pd-empty-chart">Недостаточно данных для кривой (нужно ≥2 раунда).</div>`;
  }
  const W = 720;
  const H = 220;
  const PAD = 24;
  const ys = points.map((p) => p.cumulative);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - PAD).toFixed(1)} L${x(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;
  const zeroY = y(0).toFixed(1);
  const last = points[points.length - 1]!;
  const stroke = last.cumulative >= 0 ? '#4ad991' : '#e5616c';
  const fill = last.cumulative >= 0 ? 'rgba(74,217,145,0.12)' : 'rgba(229,97,108,0.12)';
  return (
    `<svg viewBox="0 0 ${W} ${H}" class="pd-chart" role="img" aria-label="Кривая накопленного PnL">` +
    `<line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" stroke="#2a313c" stroke-width="1" stroke-dasharray="4 4"/>` +
    `<path d="${area}" fill="${fill}" stroke="none"/>` +
    `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.cumulative).toFixed(1)}" r="4" fill="${stroke}"/>` +
    `</svg>`
  );
}

/** Кривая накопленного PnL из списка раундов (реальный экспорт не пишет equityCurve). */
function equityFromRounds(rounds: RecentRound[], slug: string): NonNullable<PredictStatus['equityCurve']> {
  const asc = [...rounds].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  let cum = 0;
  return asc.map((r) => {
    cum += r.pnl ?? 0;
    return { t: r.t ?? null, slug, pnl: r.pnl ?? 0, cumulative: Math.round(cum * 100) / 100 };
  });
}

function statCard(label: string, value: string, accent?: 'pos' | 'neg' | 'muted'): string {
  const cls = accent ? ` pd-stat-${accent}` : '';
  return `<div class="pd-stat${cls}"><div class="pd-stat-val">${value}</div><div class="pd-stat-lbl">${esc(label)}</div></div>`;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${('0' + (Math.max(0, s) % 60)).slice(-2)}`;

function recentRoundsTable(
  rounds: RecentRound[],
  opts: { title?: string; showStrategy?: boolean; showMetric?: boolean; page?: number; totalPages?: number; baseHref?: string; isTrap?: boolean } = {},
): string {
  if (rounds.length === 0) return '';
  // Ловушка (dual-leg): «сторона» бессмысленна (две ноги). Показываем,
  // захлопнулась ли ловушка (обе ноги) или осталась однобокой.
  // Тип раунда мейкера: 'lock'=обе ноги (прибыль заперта), 'flatten'=одна нога
  // срезана перед закрытием, 'hold'=одна нога доведена до резолюции.
  const mmKindOf = (r: RecentRound): 'lock' | 'flatten' | 'hold' => {
    if (r.mmKind === 'lock' || r.bothLegs) return 'lock';
    if (r.mmKind === 'flatten' || r.sell) return 'flatten';
    return 'hold';
  };
  // Колонка «Что произошло» (мейкер) / «Сторона» (обычные стратегии).
  const sideCell = (r: RecentRound): string => {
    if (opts.isTrap || r._isTrap) {
      const k = mmKindOf(r);
      if (k === 'lock') return `<td class="pd-pos">🔒 Замок (обе ноги)</td>`;
      if (k === 'flatten') return `<td style="color:#e5b461">✂️ Срез (одна нога)</td>`;
      return `<td class="pd-muted-td">📥 Одна нога (до конца)</td>`;
    }
    const sc = r.side === 'UP' ? 'pd-up' : r.side === 'DOWN' ? 'pd-down' : '';
    return `<td class="${sc}">${esc(r.side ?? '—')}</td>`;
  };
  // Колонка «Куплено / продано» (мейкер): обе ноги с ценами + как сформировался PnL.
  const fmtP = (p: number): string => p.toFixed(2);
  const boughtCell = (r: RecentRound): string => {
    const k = mmKindOf(r);
    if (k === 'lock' && r.legUp && r.legDown) {
      const sum = r.legUp.p + r.legDown.p;
      const lockSpan = (1 - sum) * Math.min(r.legUp.n, r.legDown.n);
      return (
        `<td class="pd-muted-td"><span class="pd-up">UP</span> @${fmtP(r.legUp.p)} + <span class="pd-down">DOWN</span> @${fmtP(r.legDown.p)} ` +
        `= <b style="color:#cfd6e0">${fmtP(sum)}</b> &lt; 1.00 → заперто ${fmtUsd(lockSpan)}</td>`
      );
    }
    if (k === 'flatten') {
      const leg = r.legUp ?? r.legDown;
      const legSide = r.legUp ? 'UP' : 'DOWN';
      const sc = legSide === 'UP' ? 'pd-up' : 'pd-down';
      const buyTxt = leg ? `@${fmtP(leg.p)}` : '';
      const sellTxt = r.sell ? ` → продано @${fmtP(r.sell.price)}` : '';
      return `<td class="pd-muted-td"><span class="${sc}">${legSide}</span> ${buyTxt}${sellTxt} (спред)</td>`;
    }
    // hold: одна нога доведена до резолюции
    const leg = r.legUp ?? r.legDown;
    const legSide = r.legUp ? 'UP' : 'DOWN';
    const sc = legSide === 'UP' ? 'pd-up' : 'pd-down';
    return `<td class="pd-muted-td"><span class="${sc}">${legSide}</span> ${leg ? '@' + fmtP(leg.p) : ''} (до резолюции)</td>`;
  };
  const title = opts.title ?? 'Последние раунды';
  const showStrategy = opts.showStrategy ?? false;
  const showMetric = opts.showMetric !== false;
  // Адаптивные колонки: оценка (prob), коэф входа, время входа.
  const hasEdge = showMetric && rounds.some((r) => r.prob != null); // гейт по тому же полю, что рендерим в ячейке (prob), а не по edge
  const hasCoef = showMetric && !opts.isTrap && rounds.some((r) => r.coef != null); // у MM/ловушки коэф одной ноги бессмыслен
  const hasEntry = showMetric && rounds.some((r) => r.entrySecLeft != null);
  const right = 'style="text-align:right"';
  // Для мейкера (две ноги) колонки «Сторона/Ставка» бессмысленны — показываем
  // «Что произошло» (замок/срез/одна нога) и «Куплено / продано» (обе ноги + цены).
  const head =
    `<tr>` +
    (showStrategy ? `<th>Стратегия</th>` : '') +
    (opts.isTrap ? `<th>Что</th><th>Куплено / продано</th>` : `<th>Сторона</th><th>Ставка</th>`) +
    (hasEdge ? `<th ${right}>Оценка</th>` : '') +
    (hasCoef ? `<th ${right}>Коэф.</th>` : '') +
    (hasEntry ? `<th ${right}>Вход (до конца)</th>` : '') +
    `<th>Исход</th><th ${right}>PnL</th><th ${right}>Когда</th></tr>`;
  const rows = rounds
    .map((r) => {
      const stratCell = showStrategy ? `<td class="pd-muted-td">${esc(r._strategy ?? '')}</td>` : '';
      const edgeCells = hasEdge ? `<td ${right}>${r.prob != null ? r.prob + '%' : '—'}</td>` : '';
      const coefCell = hasCoef ? `<td class="pd-muted-td" ${right}>${r.coef != null ? r.coef.toFixed(2) : '—'}</td>` : '';
      // «Вход (до конца)» = за сколько минут:секунд ДО закрытия раунда мы вошли в сделку
      // (для m15 это всегда T-600 = 10:00 до конца). Берём entrySecLeft, а не часы по МСК.
      const entryCell = hasEntry
        ? `<td class="pd-muted-td" ${right}>${r.entrySecLeft != null ? 'за ' + mmss(r.entrySecLeft) : '—'}</td>`
        : '';
      // Лайв-строка (открытая сделка): исход ещё не известен.
      if (r._live) {
        const when = r._secLeft != null ? `ещё ${mmss(r._secLeft)}` : 'идёт';
        return (
          `<tr class="pd-liverow">` +
          stratCell +
          sideCell(r) +
          (opts.isTrap
            ? `<td class="pd-muted-td">котировки выставлены</td>`
            : `<td>${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}</td>`) +
          edgeCells +
          coefCell +
          (hasEntry ? `<td class="pd-muted-td" ${right}>—</td>` : '') +
          `<td style="color:#e5b461">🟢 в работе</td>` +
          `<td class="pd-muted-td" ${right}>—</td>` +
          `<td class="pd-muted-td" ${right}>${esc(when)}</td></tr>`
        );
      }
      const when = r.t ? agoText(r.t) : '—';
      const resCls = r.win ? 'pd-pos' : 'pd-neg';
      return (
        `<tr>` +
        stratCell +
        sideCell(r) +
        (opts.isTrap
          ? boughtCell(r)
          : `<td style="text-align:left">${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}` +
            (r.stakeReason ? `<div class="pd-muted-td" style="font-size:10px;font-weight:400;white-space:normal;line-height:1.3;max-width:190px;margin:2px auto 0 0">${esc(r.stakeReason)}</div>` : '') +
            `</td>`) +
        edgeCells +
        coefCell +
        entryCell +
        `<td class="${resCls}">${r.win ? 'выигрыш' : 'проигрыш'}</td>` +
        `<td class="${resCls}" ${right}>${fmtUsd(r.pnl)}</td>` +
        `<td class="pd-muted-td" ${right}>${esc(when)}</td></tr>`
      );
    })
    .join('');
  // Футер пагинации.
  let pager = '';
  if (opts.totalPages && opts.totalPages > 1 && opts.baseHref) {
    const page = opts.page ?? 1;
    const link = (p: number, label: string, on: boolean) =>
      on ? `<a class="pd-page" href="${opts.baseHref}?page=${p}">${label}</a>` : `<span class="pd-page pd-page-off">${label}</span>`;
    pager =
      `<div class="pd-pager">` +
      link(page - 1, '← Назад', page > 1) +
      `<span class="pd-page-info">стр. ${page} из ${opts.totalPages}</span>` +
      link(page + 1, 'Вперёд →', page < opts.totalPages) +
      `</div>`;
  }
  return (
    `<div class="pd-card"><h2>${esc(title)}</h2>` +
    `<table class="pd-table"><thead>${head}</thead><tbody>${rows}</tbody></table>${pager}</div>`
  );
}

const STYLES = `<style>
  .pd-wrap{max-width:880px;margin:0 auto;padding:32px 20px 64px;color:#e6e9ef}
  .pd-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  .pd-head h1{font-size:28px;margin:0;color:#fff}
  .pd-badge{font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;background:rgba(74,217,145,0.15);color:#4ad991;border:1px solid rgba(74,217,145,0.3)}
  .pd-fresh{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 9px;border-radius:999px}
  .pd-fresh-ok{background:rgba(74,217,145,0.12);color:#4ad991}
  .pd-fresh-stale{background:rgba(229,180,97,0.14);color:#e5b461}
  .pd-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
  .pd-sub{color:#9aa4b2;font-size:15px;line-height:1.55;margin:0 0 24px}
  .pd-back{display:inline-block;color:#7d8794;font-size:13px;text-decoration:none;margin-bottom:14px}
  .pd-back:hover{color:#cfd6e0}
  .pd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
  .pd-stat{background:#11151c;border:1px solid #1e2530;border-radius:12px;padding:16px}
  .pd-stat-val{font-size:24px;font-weight:700;color:#fff}
  .pd-stat-lbl{font-size:12px;color:#8b95a4;margin-top:4px;text-transform:uppercase;letter-spacing:.04em}
  .pd-stat-pos .pd-stat-val{color:#4ad991}
  .pd-stat-neg .pd-stat-val{color:#e5616c}
  .pd-stat-muted .pd-stat-val{color:#9aa4b2}
  .pd-card{background:#11151c;border:1px solid #1e2530;border-radius:12px;padding:20px;margin-bottom:20px}
  .pd-card h2{font-size:15px;margin:0 0 14px;color:#cfd6e0;text-transform:uppercase;letter-spacing:.04em}
  .pd-desc p{color:#b6bdc8;font-size:14.5px;line-height:1.6;margin:0 0 12px}
  .pd-desc p:last-child{margin-bottom:0}
  .pd-chart{width:100%;height:auto;display:block}
  .pd-empty-chart{color:#8b95a4;text-align:center;padding:32px 0}
  .pd-foot{color:#6b7484;font-size:13px;margin-top:8px}
  .pd-note{background:rgba(74,217,145,0.06);border:1px solid rgba(74,217,145,0.18);border-radius:12px;padding:14px 16px;color:#9aa4b2;font-size:13.5px;line-height:1.5}
  .pd-empty{text-align:center;padding:40px 16px;color:#9aa4b2;line-height:1.6}
  .pd-table{width:100%;border-collapse:collapse;font-size:14px}
  .pd-table th{text-align:left;color:#8b95a4;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;padding:6px 8px;border-bottom:1px solid #1e2530}
  .pd-table td{padding:8px;border-bottom:1px solid #161b22}
  .pd-pos{color:#4ad991}.pd-neg{color:#e5616c}.pd-up{color:#4ad991}.pd-down{color:#e5616c}.pd-muted-td{color:#6b7484}
  .pd-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:36px}
  .pd-scard{display:block;background:#11151c;border:1px solid #1e2530;border-radius:14px;padding:20px;text-decoration:none;transition:border-color .15s}
  .pd-scard:hover{border-color:#33414f}
  .pd-scard h3{margin:0 0 4px;color:#fff;font-size:18px}
  .pd-scard .tag{color:#8b95a4;font-size:13px;line-height:1.4;margin-bottom:14px}
  .pd-scard .row{display:flex;gap:18px;flex-wrap:wrap}
  .pd-scard .row div{font-size:13px;color:#9aa4b2}
  .pd-scard .row b{display:block;font-size:18px;color:#fff;font-weight:700;margin-bottom:2px}
  .pd-arrow{color:#4ad991;font-size:13px;margin-top:14px;display:inline-block}
  .pd-pager{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:14px;font-size:13px}
  .pd-page{color:#4ad991;text-decoration:none;padding:4px 10px;border:1px solid #1e2530;border-radius:8px}
  .pd-page:hover{border-color:#33414f}
  .pd-page-off{color:#3a424d;border-color:#161b22;pointer-events:none}
  .pd-page-info{color:#8b95a4}
  .pd-liverow{background:rgba(229,180,97,0.06)}
  .pd-retired{font-size:11px;font-weight:600;color:#8b95a4;background:#1e2530;border-radius:6px;padding:2px 8px;margin-left:8px;vertical-align:middle}
  .pd-scard-off{opacity:.62}
  .pd-rcard{background:#11151c;border:1px solid #1e2530;border-radius:14px;padding:18px;transition:opacity .15s,filter .15s,border-color .15s}
  .pd-rcard h3{margin:0 0 4px;color:#fff;font-size:17px}
  .pd-rcard h3 a{color:#fff;text-decoration:none}
  .pd-rcard h3 a:hover{color:#4ad991}
  .pd-rcard .tag{color:#8b95a4;font-size:12.5px;line-height:1.4;margin-bottom:12px}
  .pd-rcard .row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px}
  .pd-rcard .row div{font-size:12.5px;color:#9aa4b2}
  .pd-rcard .row b{display:block;font-size:16px;color:#fff;font-weight:700;margin-bottom:2px}
  .pd-rcard-on{border-color:#2e5a3a;box-shadow:0 0 0 1px rgba(74,217,145,.12)}
  .pd-rcard-off{opacity:.5;filter:grayscale(.55) blur(.5px)}
  .pd-rcard-off:hover{opacity:1;filter:none}
  .pd-rbtn{display:inline-block;width:100%;text-align:center;font-size:14px;padding:9px 14px;border-radius:8px;cursor:pointer;margin-top:6px}
  .pd-rbtn-go{background:#16321f;border:1px solid #2e5a3a;color:#e6e9ef}
  .pd-rbtn-go:hover{background:#1b3d27}
  .pd-rbtn-stop{background:#3a1f1f;border:1px solid #5a2e2e;color:#ffd9d9}
  .pd-rbtn-stop:hover{background:#491f1f}
  .pd-rbtn-off{background:#23262c;border:1px solid #33373f;color:#888;cursor:not-allowed}
  .pd-rstate{font-size:12px;font-weight:600;border-radius:6px;padding:2px 8px;margin-left:6px;vertical-align:middle}
  .pd-rstate-on{color:#4ad991;background:rgba(74,217,145,.12)}
  .pd-rstate-low{color:#e5c061;background:rgba(229,192,97,.12)}
  .pd-retired-banner{background:rgba(229,97,108,0.08);border:1px solid rgba(229,97,108,0.25);border-radius:12px;padding:14px 16px;color:#cdb4b6;font-size:14px;line-height:1.5;margin-bottom:20px}
  .pd-live h2{display:flex;align-items:center;gap:10px}
  .pl-timer{margin-left:auto;font-size:13px;font-weight:700;color:#e5b461;letter-spacing:.02em;text-transform:none}
  .pl-sides{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
  .pl-side{display:flex;align-items:baseline;gap:10px;padding:14px 16px;border-radius:10px}
  .pl-side-up{background:rgba(74,217,145,0.10);border:1px solid rgba(74,217,145,0.25)}
  .pl-side-down{background:rgba(229,97,108,0.10);border:1px solid rgba(229,97,108,0.25)}
  .pl-side-lbl{font-size:13px;font-weight:700;color:#cfd6e0}
  .pl-side-up .pl-side-lbl{color:#4ad991}.pl-side-down .pl-side-lbl{color:#e5616c}
  .pl-price{font-size:24px;font-weight:700;color:#fff}
  .pl-k{font-size:13px;color:#8b95a4;margin-left:auto}
  .pl-meta{color:#9aa4b2;font-size:13.5px;margin-bottom:10px}
  .pl-meta span{color:#cfd6e0;font-weight:600}
  .pl-pos{font-size:14px;color:#cfd6e0;padding-top:10px;border-top:1px solid #1e2530}
  .pl2{display:flex;flex-direction:column;gap:8px}
  .pl2-row{display:flex;align-items:center;gap:12px;font-size:14px;padding:8px 0;border-bottom:1px solid #161b22}
  .pl2-row:last-child{border-bottom:none}
  .pl2-name{color:#cfd6e0;font-weight:600;min-width:170px}
  .pl2-pos{color:#9aa4b2;flex:1}
  .pl2-timer{color:#e5b461;font-weight:600;font-size:13px}
</style>`;

const PAPER_NOTE =
  `<div class="pd-note">⚠ Paper-режим (симуляция). Это валидация гипотезы, а не доказанная прибыльность: ` +
  `перевес считается реальным только после статистической проверки на большой выборке с учётом проскальзывания. ` +
  `Параметры стратегии не публикуются.<br>` +
  `<span style="opacity:.8">КОЭФ — котировка стакана на входе; PnL считается по ФАКТИЧЕСКОМУ исполнению. ` +
  `На тонком стакане ставка «съедает» и более дорогие уровни, поэтому реальный выигрыш бывает на пару процентов ` +
  `меньше теоретического коэф×ставка (учтённое проскальзывание — это честно, а не ошибка расчёта).</span></div>`;

function strategyCard(s: StrategyDef, st: PredictStatus | null): string {
  // СПЕЦ-КЕЙС lagedge (+ shadow-варианты lagedge-tw/lagedge-imb): статус другой формы (shadow.* / real.*)
  // → берём метрики оттуда, иначе st.rounds/winRate/netPnl будут undefined/NaN.
  const stat = (s.slug.startsWith('lagedge'))
    ? (() => {
        const d = readDataJson(s.statusFile);
        const r = d?.real;
        // Реал-движки: показываем РЕАЛЬНЫЕ сделки/PnL (а не тень). Пока реала нет — ждём сигнала + контекст по тени.
        if (r && typeof r.n === 'number' && r.n > 0) {
          const np = typeof r.netPnl === 'number' ? r.netPnl : 0;
          return `<div class="row">` +
            `<div><b>${r.n}</b>реал-сделок</div>` +
            `<div><b>${typeof r.winRatePct === 'number' ? r.winRatePct.toFixed(0) : '—'}%</b>win rate</div>` +
            `<div><b style="color:${np >= 0 ? '#4ad991' : '#e5616c'}">${fmtUsd(np)}</b>реал PnL</div>` +
            `</div>`;
        }
        const sh = d?.shadow;
        if (sh && typeof sh.n === 'number') {
          return `<div class="row">` +
            `<div><b>0</b>реал-сделок</div>` +
            `<div style="color:#9aa4b2;flex:1">ждёт сигнала · тень ${sh.n}/${typeof sh.winRatePct === 'number' ? sh.winRatePct.toFixed(0) : '—'}%</div>` +
            `</div>`;
        }
        return `<div class="row"><div style="color:#6b7484">данных пока нет</div></div>`;
      })()
    : st
    ? `<div class="row">` +
      `<div><b>${st.rounds}</b>раундов</div>` +
      `<div><b>${st.winRate}%</b>win rate</div>` +
      `<div><b style="color:${st.netPnl >= 0 ? '#4ad991' : '#e5616c'}">${fmtUsd(st.netPnl)}</b>net PnL</div>` +
      (st.maxLossStreak != null ? `<div><b>${st.maxLossStreak}</b>серия −</div>` : '') +
      (st.avgCoef != null ? `<div><b>${st.avgCoef.toFixed(2)}</b>ср. коэф.</div>` : '') +
      `</div>`
    : `<div class="row"><div style="color:#6b7484">данных пока нет</div></div>`;
  const retiredBadge = s.retired ? `<span class="pd-retired">остановлена</span>` : '';
  // Боевой мини-тест (h5m12): красный бейдж «реальные деньги» прямо в обзоре.
  const realBadge = s.standalone && s.realEligible === true
    ? `<span style="display:inline-block;margin-left:8px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(216,58,58,0.15);color:#ff6b6b;border:1px solid rgba(216,58,58,0.45)">🔴 реальные деньги</span>`
    : '';
  return (
    `<a class="pd-scard${s.retired ? ' pd-scard-off' : ''}" href="/predict/${s.slug}">` +
    `<h3>${esc(s.title)}${retiredBadge}${realBadge}</h3>` +
    `<div class="tag">${esc(s.tagline)}</div>` +
    stat +
    `<span class="pd-arrow">Подробнее →</span></a>`
  );
}

/** Общий список сделок по всем стратегиям: открытые (лайв) сверху, затем завершённые. */
function globalFeed(): string {
  // Открытые сейчас сделки (из live.json) — в начало.
  const liveRows: RecentRound[] = [];
  for (const s of STRATEGIES) {
    if (!s.hasLive) continue;
    const live = readLive(s) as { position?: { side?: string; stake?: number; entryCoef?: number }; slotEndMs?: number } | null;
    const pos = live?.position;
    if (pos && (pos.side === 'UP' || pos.side === 'DOWN')) {
      const secLeft = typeof live?.slotEndMs === 'number' ? Math.round((live.slotEndMs - Date.now()) / 1000) : undefined;
      liveRows.push({
        t: Date.now(), side: pos.side, stake: pos.stake ?? null, coef: pos.entryCoef ?? null,
        pnl: 0, win: false, _strategy: s.title, _live: true, _secLeft: secLeft,
      });
    }
  }
  // Завершённые сделки всех стратегий, новые первыми.
  const done: RecentRound[] = [];
  for (const s of STRATEGIES) {
    const st = readStatus(s);
    if (st?.recentRounds) for (const r of st.recentRounds) done.push({ ...r, _strategy: s.title, _isTrap: s.isTrap });
  }
  done.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  const rows = [...liveRows, ...done.slice(0, 15)];
  return recentRoundsTable(rows, {
    title: 'Сделки · все стратегии',
    showStrategy: true,
    showMetric: false,
  });
}

// Публичный лендинг раздела /predict: WebGL-шейдер в hero + описание что делаем и
// планируем. Шейдер портирован из React-компонента в чистый WebGL (GLSL лежит в
// <script type="x-shader">, инициализация — ванильный JS, без React/Tailwind).
const SHADER_VS = `
    attribute vec4 aVertexPosition;
    void main() {
      gl_Position = aVertexPosition;
    }
`;
const SHADER_FS = `
    precision highp float;
    uniform vec2 iResolution;
    uniform float iTime;

    const float overallSpeed = 0.2;
    const float gridSmoothWidth = 0.015;
    const float axisWidth = 0.05;
    const float majorLineWidth = 0.025;
    const float minorLineWidth = 0.0125;
    const float majorLineFrequency = 5.0;
    const float minorLineFrequency = 1.0;
    const vec4 gridColor = vec4(0.5);
    const float scale = 5.0;
    const vec4 lineColor = vec4(0.4, 0.2, 0.8, 1.0);
    const float minLineWidth = 0.01;
    const float maxLineWidth = 0.2;
    const float lineSpeed = 1.0 * overallSpeed;
    const float lineAmplitude = 1.0;
    const float lineFrequency = 0.2;
    const float warpSpeed = 0.2 * overallSpeed;
    const float warpFrequency = 0.5;
    const float warpAmplitude = 1.0;
    const float offsetFrequency = 0.5;
    const float offsetSpeed = 1.33 * overallSpeed;
    const float minOffsetSpread = 0.6;
    const float maxOffsetSpread = 2.0;
    const int linesPerGroup = 16;

    #define drawCircle(pos, radius, coord) smoothstep(radius + gridSmoothWidth, radius, length(coord - (pos)))
    #define drawSmoothLine(pos, halfWidth, t) smoothstep(halfWidth, 0.0, abs(pos - (t)))
    #define drawCrispLine(pos, halfWidth, t) smoothstep(halfWidth + gridSmoothWidth, halfWidth, abs(pos - (t)))
    #define drawPeriodicLine(freq, width, t) drawCrispLine(freq / 2.0, width, abs(mod(t, freq) - (freq) / 2.0))

    float drawGridLines(float axis) {
      return drawCrispLine(0.0, axisWidth, axis)
            + drawPeriodicLine(majorLineFrequency, majorLineWidth, axis)
            + drawPeriodicLine(minorLineFrequency, minorLineWidth, axis);
    }

    float drawGrid(vec2 space) {
      return min(1.0, drawGridLines(space.x) + drawGridLines(space.y));
    }

    float random(float t) {
      return (cos(t) + cos(t * 1.3 + 1.3) + cos(t * 1.4 + 1.4)) / 3.0;
    }

    float getPlasmaY(float x, float horizontalFade, float offset) {
      return random(x * lineFrequency + iTime * lineSpeed) * horizontalFade * lineAmplitude + offset;
    }

    void main() {
      vec2 fragCoord = gl_FragCoord.xy;
      vec4 fragColor;
      vec2 uv = fragCoord.xy / iResolution.xy;
      vec2 space = (fragCoord - iResolution.xy / 2.0) / iResolution.x * 2.0 * scale;

      float horizontalFade = 1.0 - (cos(uv.x * 6.28) * 0.5 + 0.5);
      float verticalFade = 1.0 - (cos(uv.y * 6.28) * 0.5 + 0.5);

      space.y += random(space.x * warpFrequency + iTime * warpSpeed) * warpAmplitude * (0.5 + horizontalFade);
      space.x += random(space.y * warpFrequency + iTime * warpSpeed + 2.0) * warpAmplitude * horizontalFade;

      vec4 lines = vec4(0.0);
      vec4 bgColor1 = vec4(0.1, 0.1, 0.3, 1.0);
      vec4 bgColor2 = vec4(0.3, 0.1, 0.5, 1.0);

      for(int l = 0; l < linesPerGroup; l++) {
        float normalizedLineIndex = float(l) / float(linesPerGroup);
        float offsetTime = iTime * offsetSpeed;
        float offsetPosition = float(l) + space.x * offsetFrequency;
        float rand = random(offsetPosition + offsetTime) * 0.5 + 0.5;
        float halfWidth = mix(minLineWidth, maxLineWidth, rand * horizontalFade) / 2.0;
        float offset = random(offsetPosition + offsetTime * (1.0 + normalizedLineIndex)) * mix(minOffsetSpread, maxOffsetSpread, horizontalFade);
        float linePosition = getPlasmaY(space.x, horizontalFade, offset);
        float line = drawSmoothLine(linePosition, halfWidth, space.y) / 2.0 + drawCrispLine(linePosition, halfWidth * 0.15, space.y);

        float circleX = mod(float(l) + iTime * lineSpeed, 25.0) - 12.0;
        vec2 circlePosition = vec2(circleX, getPlasmaY(circleX, horizontalFade, offset));
        float circle = drawCircle(circlePosition, 0.01, space) * 4.0;

        line = line + circle;
        lines += line * lineColor * rand;
      }

      fragColor = mix(bgColor1, bgColor2, uv.x);
      fragColor *= verticalFade;
      fragColor.a = 1.0;
      fragColor += lines;

      gl_FragColor = fragColor;
    }
`;
// Инициализация WebGL без шаблонных строк (чтобы не конфликтовать с внешним литералом).
const SHADER_INIT = [
  '(function(){',
  "  var c=document.getElementById('predict-shader'); if(!c) return;",
  "  var gl=c.getContext('webgl')||c.getContext('experimental-webgl');",
  "  if(!gl){ c.style.background='linear-gradient(120deg,#15123a,#3a1560)'; return; }",
  "  function sh(t,src){var s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){console.error(gl.getShaderInfoLog(s));return null;}return s;}",
  "  var p=gl.createProgram();",
  "  gl.attachShader(p,sh(gl.VERTEX_SHADER,document.getElementById('predict-vs').textContent));",
  "  gl.attachShader(p,sh(gl.FRAGMENT_SHADER,document.getElementById('predict-fs').textContent));",
  '  gl.linkProgram(p);',
  '  if(!gl.getProgramParameter(p,gl.LINK_STATUS)){console.error(gl.getProgramInfoLog(p));return;}',
  '  var b=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b);',
  '  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);',
  "  var pos=gl.getAttribLocation(p,'aVertexPosition');",
  "  var rl=gl.getUniformLocation(p,'iResolution'), tl=gl.getUniformLocation(p,'iTime');",
  '  function rs(){var r=c.getBoundingClientRect();var d=Math.min(window.devicePixelRatio||1,2);c.width=Math.max(1,Math.floor(r.width*d));c.height=Math.max(1,Math.floor(r.height*d));gl.viewport(0,0,c.width,c.height);}',
  "  window.addEventListener('resize',rs); rs();",
  '  var t0=Date.now();',
  '  function frame(){var t=(Date.now()-t0)/1000;gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(p);gl.uniform2f(rl,c.width,c.height);gl.uniform1f(tl,t);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(pos);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);requestAnimationFrame(frame);}',
  '  requestAnimationFrame(frame);',
  '})();',
].join('\n');

function renderAbout(): string {
  const paStyle = `<style>
    html{overflow-x:clip}
    .pa-hero{position:relative;width:100vw;margin-left:calc(50% - 50vw);margin-top:calc(-1 * clamp(20px,4vw,32px));min-height:88vh;min-height:calc(100svh - 52px);display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0b0e13}
    #predict-shader{position:absolute;inset:0;width:100%;height:100%;display:block}
    .pa-hero::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,14,19,.14) 0%,rgba(11,14,19,.40) 48%,rgba(11,14,19,.80) 80%,#0b0e13 100%);z-index:1}
    .pa-hero::before{content:'';position:absolute;inset:0;z-index:1;background:radial-gradient(82% 68% at 50% 44%,rgba(5,7,11,.78) 0%,rgba(5,7,11,.58) 30%,rgba(5,7,11,.30) 56%,rgba(5,7,11,0) 84%)}
    .pa-hero-inner{position:relative;z-index:2;text-align:center;padding:54px 30px;max-width:760px}
    .pa-kicker{display:inline-block;font-size:12.5px;letter-spacing:.16em;text-transform:uppercase;color:#b9a7ff;border:1px solid #4a3a7a;background:rgba(40,28,80,.4);padding:5px 12px;border-radius:999px;margin-bottom:18px}
    .pa-hero h1{font-size:clamp(40px,8vw,76px);line-height:1.02;margin:0 0 16px;font-weight:800;background:linear-gradient(180deg,#fff,#e6dcff);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 2px 6px rgba(0,0,0,.9)) drop-shadow(0 4px 22px rgba(0,0,0,.75))}
    .pa-lead{font-size:clamp(16px,2.4vw,20px);color:#fbfaff;font-weight:500;line-height:1.55;margin:0 auto 26px;max-width:620px;text-shadow:0 1px 2px rgba(0,0,0,.95),0 2px 10px rgba(0,0,0,.85)}
    .pa-kicker{text-shadow:0 1px 6px rgba(0,0,0,.6)}
    .pa-cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
    .pa-btn{font-size:15px;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block}
    .pa-btn-p{background:linear-gradient(120deg,#6d3bff,#9a52ff);color:#fff;border:1px solid #8a5cff}
    .pa-btn-s{background:rgba(255,255,255,.06);color:#e6e9ef;border:1px solid #3a3550}
    .pa-sec{max-width:920px;margin:46px auto 0;padding:0 20px}
    .pa-sec h2{font-size:23px;margin:0 0 8px}
    .pa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:18px}
    .pa-tile{background:#11141b;border:1px solid #232a36;border-radius:14px;padding:18px}
    .pa-tile .pa-ico{font-size:22px;margin-bottom:8px}
    .pa-tile h3{margin:0 0 6px;font-size:16px;color:#eef1f6}
    .pa-tile p{margin:0;font-size:13.5px;color:#aab2c0;line-height:1.6}
    .pa-steps{margin:16px 0 0;padding:0;list-style:none;counter-reset:s}
    .pa-steps li{position:relative;padding:12px 0 12px 44px;border-top:1px solid #1d232e;color:#c3c9d4;line-height:1.6;font-size:14.5px}
    .pa-steps li::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:11px;width:28px;height:28px;border-radius:50%;background:rgba(109,59,255,.18);border:1px solid #5a44a0;color:#c9b8ff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
    .pa-note{max-width:920px;margin:30px auto 8px;padding:16px 20px;background:rgba(40,28,80,.18);border:1px solid #2e2750;border-radius:12px;color:#bdb6d6;font-size:13.5px;line-height:1.65}
  </style>`;

  const hero =
    `<div class="pa-hero">` +
    `<canvas id="predict-shader" aria-hidden="true"></canvas>` +
    `<div class="pa-hero-inner">` +
    `<span class="pa-kicker">Robot Claude · раздел Predict</span>` +
    `<h1>Predict</h1>` +
    `<p class="pa-lead">Будет ли биткоин через 5 минут дороже или дешевле? На Polymarket на это делают ставки — а наши программы делают их <b>автоматически</b> и аккуратно, показывая всё честно.</p>` +
    `<div class="pa-cta">` +
    `<a class="pa-btn pa-btn-p" href="/predict">Открыть дашборд →</a>` +
    `</div></div></div>`;

  const whatWeDo =
    `<div class="pa-sec"><h2>Коротко о главном</h2>` +
    `<div class="pa-grid">` +
    `<div class="pa-tile"><div class="pa-ico">🎯</div><h3>Вход в последний момент</h3><p>Ставим в последние секунды, когда исход почти ясен.</p></div>` +
    `<div class="pa-tile"><div class="pa-ico">📐</div><h3>Умный размер ставки</h3><p>В основе — проверенные математические модели управления деньгами (те же, что у профи). Больше — где есть перевес, минимум — где нет. Так капитал под защитой.</p></div>` +
    `<div class="pa-tile"><div class="pa-ico">🧪</div><h3>Сначала без денег</h3><p>Каждая идея сперва торгует виртуально. Отчёт честно показывает, кто в плюсе.</p></div>` +
    `<div class="pa-tile"><div class="pa-ico">🔒</div><h3>Реал — осторожно</h3><p>Настоящие деньги — только вручную, с лимитами и кнопкой «стоп».</p></div>` +
    `</div></div>`;

  const next =
    `<div class="pa-sec"><h2>Что дальше</h2>` +
    `<p class="pd-sub">Оставляем только то, что стабильно в плюсе на бумаге, и аккуратно переходим на небольшие реальные суммы. Цель — спокойный дополнительный доход для семьи, а не быстрые деньги.</p></div>`;

  const note =
    `<p class="pa-note">⚠️ Честно: лёгких гарантированных денег на бирже не бывает. Это эксперимент, а не финансовый совет.</p>`;

  const shaderTags =
    `<script type="x-shader/x-vertex" id="predict-vs">${SHADER_VS}</script>` +
    `<script type="x-shader/x-fragment" id="predict-fs">${SHADER_FS}</script>` +
    `<script>${SHADER_INIT}</script>`;

  return (
    STYLES + paStyle +
    hero +
    `<div class="pd-wrap" style="max-width:1000px">` +
    whatWeDo + next + note +
    `<p style="text-align:center;margin:34px 0 10px"><a class="pa-btn pa-btn-p" href="/predict">Перейти в раздел /predict →</a></p>` +
    `</div>` + shaderTags
  );
}


function readDataJson(name: string): any | null {
  try {
    const p = join(dataDir, name);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return null; }
}

// Карточка фонового майнера паттернов проигрыша (OOS-валидация). Read-only отчёт, ставки не меняет.
function lossPatternCard(file: string): string {
  const d = readDataJson(file);
  if (!d || !d.base) return '';
  const b = d.base;
  const pct = (x: number | null) => (x != null ? (x * 100).toFixed(1) + '%' : '—');
  const rowsHtml = (d.patterns ?? [])
    .map((r: any) =>
      `<tr>` +
      `<td style="text-align:left">${r.survivesOOS ? '✅ ' : ''}${esc(r.feature)}</td>` +
      `<td style="text-align:right" class="pd-muted-td">${pct(r.lossRateTrain)} → ${pct(r.lossRateTest)}</td>` +
      `<td style="text-align:right" class="pd-muted-td">${r.nTrain}/${r.nTest}</td>` +
      `<td style="text-align:right" class="${(r.skipGainTestPnl ?? 0) > 0 ? 'pd-pos' : 'pd-muted-td'}">${r.skipGainTestPnl != null ? '$' + r.skipGainTestPnl.toFixed(2) : '—'}</td>` +
      `</tr>`,
    )
    .join('');
  const verdictColor = (d.survivors?.length ?? 0) > 0 ? '#e5b461' : '#7fd49b';
  return (
    `<div class="pd-card" style="border-color:#33384a">` +
    `<h2>🔬 Паттерны проигрыша · фон (OOS)</h2>` +
    `<p class="pd-sub" style="margin-top:-4px">Майнер ищет условия повышенного проигрыша и проверяет каждое вне выборки (ранние 60% → поздние 40%). Ставки не меняет — только отчёт. «Выжившим» считается лишь паттерн, повышающий проигрыш на ОБЕИХ половинах и улучшающий PnL поздней — защита от подгонки под шум.</p>` +
    `<div class="pd-foot" style="margin:6px 0 10px">Входов: ${b.n} · проигрышей: ${Math.round((b.lossRate ?? 0) * b.n)} · базовая доля: ${pct(b.lossRate)} · flat-PnL: ${fmtUsd(b.flatPnl)} · проверено гипотез: ${d.testsRun}</div>` +
    (d.independence
      ? `<div class="pd-foot" style="margin:0 0 8px"><b style="color:#cfd6e0">Кластеризуются ли проигрыши:</b> база ${pct(d.independence.baseLoss)} · после проигрыша ${pct(d.independence.pLoseAfterLoss)} (n=${d.independence.nAfterLoss}) · после выигрыша ${pct(d.independence.pLoseAfterWin)} (n=${d.independence.nAfterWin})<br>${esc(d.independence.verdict ?? '')}</div>`
      : '') +
    (d.sequencing
      ? `<div class="pd-foot" style="margin:0 0 10px"><b style="color:#cfd6e0">Пропуск после проигрыша (вне выборки, flat $1):</b> Δ PnL ${fmtUsd(d.sequencing.skipAfterLossDelta)} · пропуск после 2 подряд: Δ ${fmtUsd(d.sequencing.skipAfter2LossDelta)} <span style="opacity:.7">(>0 — помогло бы, ≤0 — нет)</span></div>`
      : '') +
    `<table class="pd-table"><thead><tr><th>Условие</th><th style="text-align:right">Проигрыш train→test</th><th style="text-align:right">n</th><th style="text-align:right">Δ test-PnL</th></tr></thead><tbody>${rowsHtml}</tbody></table>` +
    `<div class="pd-foot" style="margin-top:10px;color:${verdictColor}">${esc(d.verdict ?? '')}</div>` +
    (d.multipleTestingNote ? `<div class="pd-foot" style="margin-top:6px">${esc(d.multipleTestingNote)}</div>` : '') +
    `</div>`
  );
}

// 🎯 Сводный дашборд вилок: нормализует находки всех арб-сканеров в одну таблицу.
function arbPct(x: number): string {
  const v = x * 100;
  const col = v > 0 ? '#2ecc71' : '#e0556b';
  return `<span style="color:${col};font-variant-numeric:tabular-nums;font-weight:600">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
}

function renderArb(): string {
  const nr = readDataJson('predict-nrscan-status.json');
  const pk = readDataJson('predict-pmkx-status.json');
  const lx = readDataJson('predict-pmlx-status.json');
  const po = readDataJson('predict-pmopt-status.json');
  const sim = readDataJson('predict-arb-sim.json');

  type ARow = { scanner: string; venue: string; label: string; gross: number; net: number; depth: number | null; live: boolean; ts: number };
  const rows: ARow[] = [];
  const recOf = (d: any): any[] => (d && Array.isArray(d.recent)) ? d.recent : [];
  for (const r of recOf(nr)) rows.push({ scanner: 'NRSCAN', venue: 'внутри Polymarket', label: String(r.slug ?? ''), gross: Math.max(r.rawBuy ?? -1, r.rawSell ?? -1), net: r.netBuy ?? 0, depth: r.depthUsd ?? null, live: !!r.persisted, ts: r.ts ?? 0 });
  for (const r of recOf(pk)) rows.push({ scanner: 'PMKX', venue: 'PM ↔ Kalshi', label: String(r.pm ?? r.kx ?? ''), gross: r.raw ?? 0, net: r.net ?? 0, depth: r.depthUsd ?? null, live: !!r.persisted, ts: r.ts ?? 0 });
  for (const r of recOf(lx)) rows.push({ scanner: 'PMLX', venue: 'PM ↔ Limitless', label: String(r.pm ?? r.lx ?? ''), gross: r.raw ?? 0, net: r.net ?? 0, depth: r.depthUsd ?? null, live: !!r.persisted, ts: r.ts ?? 0 });
  for (const r of recOf(po)) rows.push({ scanner: 'PMOPT', venue: 'PM vs опционы', label: String(r.q ?? ''), gross: r.div ?? 0, net: r.net ?? 0, depth: null, live: !!r.candidate, ts: r.ts ?? 0 });

  rows.sort((a, b) => b.net - a.net);
  const top = rows.slice(0, 30);
  const now = Date.now();

  const trs = top.map((r) => {
    const am = r.ts ? Math.max(0, Math.round((now - r.ts) / 60000)) : null;
    return `<tr style="border-top:1px solid rgba(255,255,255,0.06)">` +
      `<td style="padding:7px 10px;white-space:nowrap"><b>${r.scanner}</b><br><span style="color:#6b7484;font-size:11px">${r.venue}</span></td>` +
      `<td style="padding:7px 10px">${esc(r.label).slice(0, 80)}</td>` +
      `<td style="padding:7px 10px;text-align:right;color:#9aa3b0;font-variant-numeric:tabular-nums">${(r.gross * 100).toFixed(1)}%</td>` +
      `<td style="padding:7px 10px;text-align:right">${arbPct(r.net)}</td>` +
      `<td style="padding:7px 10px;text-align:right;color:#9aa3b0">${r.depth != null ? '$' + Math.round(r.depth) : '—'}</td>` +
      `<td style="padding:7px 10px;text-align:center">${r.live ? '<span style="color:#2ecc71">✓</span>' : '<span style="color:#6b7484">·</span>'}</td>` +
      `<td style="padding:7px 10px;text-align:right;color:#6b7484;white-space:nowrap">${am != null ? am + ' мин' : '—'}</td>` +
      `</tr>`;
  }).join('');

  const sumCard = (name: string, venue: string, d: any, qkey: string, qlabel: string, watch: string) =>
    !d ? '' :
    `<div class="pd-card" style="margin:0;flex:1;min-width:190px">` +
    `<h3 style="margin:0 0 2px;font-size:15px">${name}</h3>` +
    `<p class="pd-sub" style="margin:0 0 8px;font-size:12px">${venue}</p>` +
    `<div class="row" style="font-size:13px">` +
    `<div><b>${d.daysCollected ?? 0}/${d.daysTarget ?? 21}</b>дней</div>` +
    `<div><b>${d.runs ?? 0}</b>сканов</div>` +
    (watch && d[watch] != null ? `<div><b>${d[watch]}</b>${watch === 'pairsUnderWatch' ? 'пар' : watch === 'marketsTracked' ? 'рынков' : 'событий'}</div>` : '') +
    `<div><b style="color:${(d[qkey] ?? 0) > 0 ? '#2ecc71' : 'inherit'}">${d[qkey] ?? 0}</b>${qlabel}</div>` +
    `</div></div>`;

  return STYLES +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>🎯 Вилки и расхождения</h1><span class="pd-fresh pd-fresh-stale" style="font-size:13px;padding:3px 10px">Фаза 0 · только наблюдение</span></div>` +
    `<p class="pd-sub">Живой свод по всем арбитраж-сканерам. Строки ниже — <b>наблюдаемые</b> расхождения цен, НЕ гарантированная прибыль. ` +
    `Единственная значимая колонка — <b>НЕТТО</b> (после комиссий обеих площадок); валовая щель обманчива. Колонка <b>✓</b> = щель прожила ≥60с. ` +
    `Даже зачётная щель упирается в глубину стакана, задержку исполнения, leg-risk и (для Kalshi) KYC — поэтому ставок здесь нет.</p>` +
    `<p style="margin:-6px 0 18px"><a class="pd-arrow" href="/predict">← к стратегиям</a></p>` +
    (sim
      ? `<div class="pd-card" style="margin-bottom:20px;border:1px solid rgba(74,217,145,0.3)">` +
        `<h3 style="margin:0 0 8px">💰 Прибыль, если бы мы брали ВСЕ исполнимые вилки</h3>` +
        `<div class="row" style="font-size:14px">` +
        `<div><b style="color:${(sim.totalProfitUsd ?? 0) > 0 ? '#2ecc71' : 'inherit'};font-size:22px">$${sim.totalProfitUsd ?? 0}</b>за ${sim.daysCollected ?? 0} дней</div>` +
        `<div><b style="font-size:18px">≈$${sim.perMonthUsd ?? 0}</b>в месяц (прогноз)</div>` +
        `<div><b style="font-size:18px">${sim.totalTrades ?? 0}</b>исполнимых вилок всего</div>` +
        `</div>` +
        `<p class="pd-sub" style="margin:10px 0 0">⚠️ Это ОПТИМИСТИЧНАЯ верхняя граница: ${esc(String(sim.assumptions ?? ''))}, мгновенный фил обеих ног по котировке. В реале ещё ниже — щель исчезает за секунды (задержка исполнения) и есть leg-risk (одна нога налилась, вторая нет). Если цифра около нуля — значит исполнимых вилок почти нет, комиссии съедают щели.</p>` +
        `</div>`
      : '') +
    `<div class="pd-grid" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-bottom:22px">` +
    sumCard('NRSCAN', 'внутри Polymarket (NegRisk)', nr, 'qualifying', 'зачётных', 'eventsScanned') +
    sumCard('PMKX', 'Polymarket ↔ Kalshi', pk, 'qualifying', 'зачётных', 'pairsUnderWatch') +
    sumCard('PMLX', 'Polymarket ↔ Limitless', lx, 'qualifying', 'зачётных', 'pairsUnderWatch') +
    sumCard('PMOPT', 'PM vs опционы Deribit', po, 'candidates', 'кандидатов', 'marketsTracked') +
    `</div>` +
    `<h2 style="margin:0 0 10px">Лучшие наблюдения сейчас (по нетто-краю)</h2>` +
    (top.length
      ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">` +
        `<thead><tr style="color:#6b7484;text-align:left;font-size:11px;text-transform:uppercase">` +
        `<th style="padding:6px 10px">Сканер</th><th style="padding:6px 10px">Рынок</th>` +
        `<th style="padding:6px 10px;text-align:right">Валовая</th><th style="padding:6px 10px;text-align:right">Нетто</th>` +
        `<th style="padding:6px 10px;text-align:right">Глубина</th><th style="padding:6px 10px;text-align:center">Жив 60с</th>` +
        `<th style="padding:6px 10px;text-align:right">Возраст</th></tr></thead><tbody>${trs}</tbody></table></div>`
      : `<p class="pd-sub">Свежих наблюдений пока нет — сканеры собирают данные.</p>`) +
    `<p class="pd-sub" style="margin-top:16px">Критерий Фазы 0 (зафиксирован до данных): по каждой ноге ≥7–10 зачётных за 21 день (нетто ≥2–3% после комиссий, сторона ≥$50, жизнь ≥60с) — иначе нога закрывается. ` +
    `Честный ранний итог: щели находятся, но тонкие комиссии съедают почти все в минус — большинство ног тянет к нулю зачётных.</p>` +
    `</div>`;
}

// 🔬 Фаза 0 — исследовательские треки (сбор данных, без ставок): NRSCAN + PMKX + PMLX + PMOPT + DYNPROB.
function researchSection(): string {
  const nr = readDataJson('predict-nrscan-status.json');
  const pk = readDataJson('predict-pmkx-status.json');
  const lx = readDataJson('predict-pmlx-status.json');
  const po = readDataJson('predict-pmopt-status.json');
  const dp = readDataJson('predict-dynprob-status.json');
  if (!nr && !pk && !lx && !po && !dp) return '';
  let html =
    `<h2 style="margin:30px 0 6px">🔬 Исследования — Фаза 0 (сбор данных, ставок нет)</h2>` +
    `<p class="pd-sub" style="margin-bottom:14px">Гипотезы сначала доказывают себя на данных — критерии зафиксированы заранее, и только потом получают право стать бумажной стратегией.</p>`;
  if (nr) {
    const q = nr.qualifying ?? 0;
    html +=
      `<div class="pd-card" style="margin-bottom:12px">` +
      `<h3 style="margin:0 0 6px">NRSCAN · перекосы NegRisk-событий</h3>` +
      `<p class="pd-sub" style="margin:0 0 10px">Каждые 10 минут сканируем события со взаимоисключающими исходами: сумма цен должна равняться $1 — перекос в любую сторону это арбитражная щель. ` +
      `Критерий (зафиксирован): ≥10 находок/мес с нетто ≥3% после комиссий, глубиной ≥$50 и жизнью ≥60с — иначе направление закрывается.</p>` +
      `<div class="row">` +
      `<div><b>${nr.daysCollected ?? 0}/${nr.daysTarget ?? 21}</b>дней сбора</div>` +
      `<div><b>${nr.runs ?? 0}</b>сканов</div>` +
      `<div><b>${nr.eventsScanned ?? 0}</b>событий проверено</div>` +
      `<div><b>${nr.findingsRaw ?? 0}</b>перекосов ≥0.5%</div>` +
      `<div><b>${nr.candidates2pct ?? 0}</b>кандидатов ≥2%</div>` +
      `<div><b style="color:${q > 0 ? 'var(--up,#2ecc71)' : 'inherit'}">${q}/10</b>зачётных (критерий)</div>` +
      `</div></div>`;
  }
  if (pk) {
    const q = pk.qualifying ?? 0;
    html +=
      `<div class="pd-card" style="margin-bottom:12px">` +
      `<h3 style="margin:0 0 6px">PMKX · вилки Polymarket ↔ Kalshi</h3>` +
      `<p class="pd-sub" style="margin:0 0 10px">Каждые 10 минут сравниваем цены эквивалентных рынков двух площадок (консервативный автомэтчинг: крипто-пороги, месячные reach/dip, решения ФРС): купить YES дешевле + NO на другой — связка платит $1. ` +
      `Критерий (зафиксирован): ≥10 находок/мес с нетто ≥2% после комиссий обеих площадок, стороной ≥$50 и жизнью ≥60с — иначе направление закрывается.</p>` +
      `<div class="row">` +
      `<div><b>${pk.daysCollected ?? 0}/${pk.daysTarget ?? 21}</b>дней сбора</div>` +
      `<div><b>${pk.pairsUnderWatch ?? 0}</b>пар под наблюдением</div>` +
      `<div><b>${pk.runs ?? 0}</b>сканов</div>` +
      `<div><b>${pk.findingsRaw ?? 0}</b>перекосов ≥0.5%</div>` +
      `<div><b>${pk.candidates1pct ?? 0}</b>кандидатов ≥1%</div>` +
      `<div><b style="color:${q > 0 ? 'var(--up,#2ecc71)' : 'inherit'}">${q}/10</b>зачётных (критерий)</div>` +
      `</div></div>`;
  }
  if (lx) {
    const q = lx.qualifying ?? 0;
    html +=
      `<div class="pd-card" style="margin-bottom:12px">` +
      `<h3 style="margin:0 0 6px">PMLX · вилки Polymarket ↔ Limitless</h3>` +
      `<p class="pd-sub" style="margin:0 0 10px">Каждые 10 минут сравниваем цены эквивалентных рынков Polymarket и Limitless (Base): консервативный автомэтчинг Up/Down-окон (часовые и дневные, BTC/ETH/SOL/XRP/DOGE) — окна должны совпадать с точностью до минут, расхождения правил (Pyth vs Binance, tie-правила) зафиксированы в реестре пар. ` +
      `Критерий (зафиксирован до первого скана): ≥10 находок/мес с нетто ≥2% после комиссий обеих площадок, стороной ≥$50 и жизнью ≥60с — иначе нога закрывается.</p>` +
      `<div class="row">` +
      `<div><b>${lx.daysCollected ?? 0}/${lx.daysTarget ?? 21}</b>дней сбора</div>` +
      `<div><b>${lx.pairsUnderWatch ?? 0}</b>пар под наблюдением</div>` +
      `<div><b>${lx.runs ?? 0}</b>сканов</div>` +
      `<div><b>${lx.findingsRaw ?? 0}</b>перекосов ≥0.5%</div>` +
      `<div><b>${lx.candidates1pct ?? 0}</b>кандидатов ≥1%</div>` +
      `<div><b style="color:${q > 0 ? 'var(--up,#2ecc71)' : 'inherit'}">${q}/10</b>зачётных (критерий)</div>` +
      `</div></div>`;
  }
  if (po) {
    const q = po.candidates ?? 0;
    html +=
      `<div class="pd-card" style="margin-bottom:12px">` +
      `<h3 style="margin:0 0 6px">PMOPT · цены Polymarket против опционного fair (Deribit)</h3>` +
      `<p class="pd-sub" style="margin:0 0 10px">Это не вилка, а монитор misprice: для месячных и годовых рынков «достигнет/упадёт» (BTC/ETH) считаем честную вероятность из опционов Deribit (digital через колл-спред, mid-цены, поправка на касание ×2) и сравниваем с ценой Polymarket. ` +
      `Гипотеза края: хвосты на prediction-рынках систематически переоценены против опционного рынка; сигнал торговался бы мейкером на PM (комиссия 0). ` +
      `Критерий (зафиксирован до первого скана): ≥10 кандидатов/мес с расхождением ≥5пп нетто (после тейкер-фи и полуспреда — двойной консерватизм) при узком опционном спреде (≤8пп) и жизни ≥60с — иначе ветка закрывается.</p>` +
      `<div class="row">` +
      `<div><b>${po.daysCollected ?? 0}/${po.daysTarget ?? 21}</b>дней сбора</div>` +
      `<div><b>${po.marketsTracked ?? 0}</b>рынков под наблюдением</div>` +
      `<div><b>${po.runs ?? 0}</b>сканов</div>` +
      `<div><b>${po.measurements ?? 0}</b>замеров fair-vs-PM</div>` +
      `<div><b>${po.meanAbsDivLastRun != null ? (po.meanAbsDivLastRun * 100).toFixed(1) + 'пп' : '—'}</b>среднее |расхождение|</div>` +
      `<div><b style="color:${q > 0 ? 'var(--up,#2ecc71)' : 'inherit'}">${q}/10</b>кандидатов (критерий)</div>` +
      `</div></div>`;
  }
  if (dp) {
    const bb = Array.isArray(dp.buckets?.bestBuckets) ? dp.buckets.bestBuckets : [];
    html +=
      `<div class="pd-card" style="margin-bottom:12px">` +
      `<h3 style="margin:0 0 6px">DYNPROB · динамическая вероятность против цены рынка</h3>` +
      `<p class="pd-sub" style="margin:0 0 10px">${esc(String(dp.question ?? ''))} Офлайн-бэктест на наших раундах: фичи-индикаторы (RSI/EMA/momentum/VWAP из Binance) → калиброванная модель P(up) → сравнение с ценой рынка. ${esc(String(dp.phase ?? ''))}.</p>` +
      `<div class="row">` +
      `<div><b>${dp.dataset?.rounds ?? '—'}</b>раундов в датасете</div>` +
      `<div><b>${dp.dataset?.test ?? '—'}</b>в тесте (по времени)</div>` +
      `<div><b>рынок</b>точнее по Brier</div>` +
      `<div><b>${bb.length}</b>плюсовых бакета расхождения</div>` +
      `</div>` +
      `<p class="pd-sub" style="margin:10px 0 0">Итог прогона: <b>${esc(String(dp.interimVerdict ?? ''))}</b> Главные оговорки: лонгшот-профиль, статистически не значимо (t≈1.8), один рыночный режим.</p>` +
      (dp.forwardUnit && typeof dp.forwardUnit === 'object'
        ? `<p class="pd-sub" style="margin:10px 0 0">Форвард юнит-контроль: <b>${dp.forwardUnit.rounds ?? 0}</b> сделок · винрейт <b>${dp.forwardUnit.winRate ?? 0}%</b> · netPnL <b style="color:${(dp.forwardUnit.netPnl ?? 0) >= 0 ? '#4ad991' : '#e5616c'}">${fmtUsd(Number(dp.forwardUnit.netPnl ?? 0))}</b></p>`
        : '') +
      `</div>`;
  }
  const ff = readDataJson('predict-5m15m-status.json');
  if (ff) {
    const r15 = Number(ff.resolved15m ?? 0);
    const tgt = Number(ff.targetRounds ?? 670);
    const pct = Math.min(100, Math.round((r15 / tgt) * 100));
    html +=
      `<div class="pd-card" style="margin-bottom:12px">` +
      `<h3 style="margin:0 0 6px">5M→15M · датчик (сбор данных, Фаза 0)</h3>` +
      `<p class="pd-sub" style="margin:0 0 10px">Read-only сбор синхронных стаканов 5m+15m BTC Up/Down (без торговли, без денег). ` +
      `Проверяем: добавляет ли микроструктура 5m информацию к честной вероятности 15m-исхода ПОВЕРХ самой цены 15m-книги. Критерий зафиксирован до данных.</p>` +
      `<div class="row">` +
      `<div><b>${ff.daysCollected ?? 0}</b>дней сбора</div>` +
      `<div><b style="color:${pct >= 100 ? '#4ad991' : 'inherit'}">${r15}/${tgt}</b>раундов 15m (${pct}%)</div>` +
      `<div><b>${(Number(ff.samples ?? 0) / 1000).toFixed(0)}k</b>снапшотов</div>` +
      `<div><b style="color:${ff.feedHealthy ? '#4ad991' : '#e5a13b'}">${ff.feedHealthy ? '✓ живой' : 'переподключение'}</b>фид</div>` +
      `<div><b>$${ff.btc != null ? Math.round(Number(ff.btc)).toLocaleString('en-US') : '—'}</b>BTC</div>` +
      `</div>` +
      `<p class="pd-sub" style="margin:10px 0 0">Первый анализ — при наборе ~${tgt} раундов (≈неделя). Приор сдержанный: те же боты котируют 15m, вопрос — менее ли эффективна 15m-книга. Решат данные.</p>` +
      `</div>`;
    if (ff.ofiSamples != null) {
      const ofiN = Number(ff.ofiRounds ?? 0);
      const tgt5 = Number(ff.targetRounds5m ?? 600);
      const pct5 = Math.min(100, Math.round((ofiN / tgt5) * 100));
      const ofiLive = Number(ff.ofiSamples ?? 0) > 0 && ff.feedHealthy;
      html +=
        `<div class="pd-card" style="margin-bottom:12px">` +
        `<h3 style="margin:0 0 6px">5M-OFI · дисбаланс стакана спота (Фаза 0)</h3>` +
        `<p class="pd-sub" style="margin:0 0 10px">Read-only. Гипотеза: перевес объёма в стакане Binance (order-flow imbalance) предсказывает 5m-исход лучше цены 5m-книги Polymarket — проверяем строго ДОБАВОЧНО к цене. Приор низкий (OFI — территория HFT, цену уже ставят боты), решат данные.</p>` +
        `<div class="row">` +
        `<div><b style="color:${pct5 >= 100 ? '#4ad991' : 'inherit'}">${ofiN}/${tgt5}</b>5m-раундов (${pct5}%)</div>` +
        `<div><b style="color:${ofiLive ? '#4ad991' : '#e5a13b'}">${ofiLive ? '✓ идёт' : 'ожидание'}</b>поток OFI</div>` +
        `<div><b>${(Number(ff.ofiSamples ?? 0) / 1000).toFixed(0)}k</b>замеров с OFI</div>` +
        `</div>` +
        `<p class="pd-sub" style="margin:10px 0 0">Анализ при ~${tgt5} раундах (≈2–3 дня — 5m идут быстро).</p>` +
        `</div>`;
    }
  }
  return html;
}

// Дашборд «Обучение»: учится ли модель (точность на свежих раундах vs рынок) + вердикт по стратегиям.
function renderLearning(): string {
  const MODEL = process.env.PREDICT_M15_MODEL ?? '/home/trader/apps/predict-tools/data/predict-m15-model-online.json';
  const HIST = process.env.PREDICT_M15_HISTORY ?? '/home/trader/apps/predict-tools/data/predict-m15-model-online-history.jsonl';
  let m: { trainN?: number; valHit?: number | null; mktHit?: number | null; valN?: number; conf?: number } | null = null;
  try { m = JSON.parse(readFileSync(MODEL, 'utf8')); } catch {}
  let hist: { valHit?: number | null; mktHit?: number | null }[] = [];
  try { hist = readFileSync(HIST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const back = `<a class="pd-back" href="/predict">← Все стратегии</a>`;
  if (!m) return STYLES + `<div class="pd-wrap">${back}<h1>Обучение модели</h1><div class="pd-empty">Модель ещё не обучена.</div></div>`;
  const lead = m.valHit != null && m.mktHit != null ? m.valHit - m.mktHit : null;
  let verdict = '⏳ копим данные';
  if ((m.valN ?? 0) >= 50 && lead != null) verdict = lead >= 1.5 ? `📈 модель умнее рынка (+${lead.toFixed(1)}пп)` : lead <= -1 ? `📉 хуже рынка (${lead.toFixed(1)}пп)` : '➡️ вровень с рынком (перевес ~0)';
  const vh = hist.filter((h) => h.valHit != null) as { valHit: number; mktHit?: number | null }[];
  let trend = '';
  if (vh.length >= 6) {
    const a = vh.slice(0, 3).reduce((s, h) => s + h.valHit, 0) / 3, b = vh.slice(-3).reduce((s, h) => s + h.valHit, 0) / 3;
    trend = b > a + 0.5 ? `📈 точность растёт (${a.toFixed(1)}→${b.toFixed(1)}%)` : b < a - 0.5 ? `📉 точность падает (${a.toFixed(1)}→${b.toFixed(1)}%)` : `➡️ точность стабильна (~${b.toFixed(1)}%)`;
  }
  const chart = (() => {
    if (vh.length < 2) return `<div class="pd-empty-chart">Кривая появится после нескольких дообучений (сейчас ${vh.length}).</div>`;
    const W = 720, H = 200, PAD = 30;
    const ys = vh.flatMap((p) => [p.valHit, p.mktHit ?? p.valHit]);
    const min = Math.min(...ys, 48), max = Math.max(...ys, 52), span = max - min || 1;
    const x = (i: number) => PAD + (i / (vh.length - 1)) * (W - 2 * PAD);
    const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
    const poly = (key: 'valHit' | 'mktHit', color: string) => `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${vh.map((p, i) => `${x(i).toFixed(1)},${y((p[key] ?? p.valHit) as number).toFixed(1)}`).join(' ')}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="pd-chart"><line x1="${PAD}" y1="${y(50).toFixed(1)}" x2="${W - PAD}" y2="${y(50).toFixed(1)}" stroke="#2a313c" stroke-dasharray="4 4"/>${poly('mktHit', '#7d8794')}${poly('valHit', '#4ad991')}</svg>`;
  })();
  const rows = STRATEGIES.filter((s) => s.standalone && s.realEligible === true).map((s) => {
    const a = aggStat(s); const rounds = a.rounds; const wr = a.winRate;
    const netPnl = a.netPnl;
    const be = a.be;
    const edge = be != null && rounds > 0 ? wr - be : null;
    let v = `⏳ мало данных (${rounds})`;   // вердикт по ДЕНЬГАМ (netPnl), не по краю — деньги главнее
    if (rounds >= 30) v = netPnl > 0 && (edge == null || edge > 0) ? `📈 в плюсе (${fmtUsd(netPnl)})` : netPnl < 0 ? `📉 в минусе (${fmtUsd(netPnl)})` : '➡️ около нуля';
    const pnlCls = netPnl > 0 ? 'pd-pos' : netPnl < 0 ? 'pd-neg' : 'pd-muted-td';
    return `<tr><td><a href="/predict/${s.slug}" style="color:#cfd6e0;text-decoration:none">${esc(s.title)}</a></td><td class="pd-muted-td" style="text-align:right">${rounds}</td><td style="text-align:right">${rounds > 0 ? wr + '%' : '—'}</td><td class="pd-muted-td" style="text-align:right">${be != null ? be.toFixed(0) + '%' : '—'}</td><td style="text-align:right">${edge != null ? (edge > 0 ? '+' : '') + edge.toFixed(1) + 'пп' : '—'}</td><td class="${pnlCls}" style="text-align:right">${fmtUsd(netPnl)}</td><td>${v}</td></tr>`;
  }).join('');
  return STYLES + `<div class="pd-wrap">${back}` +
    `<div class="pd-head"><h1>🧠 Обучение модели</h1><span class="pd-badge">${verdict}</span></div>` +
    `<p class="pd-sub">Одна обучающаяся модель кормит все стратегии-фильтры. Здесь видно, учится ли она и бьёт ли рынок. Дообучается каждые 30 мин на всех сыгранных раундах.</p>` +
    `<div class="pd-grid">` +
    statCard('Обучена на', `${m.trainN ?? '—'}`) +
    statCard('Точность (свежие)', m.valHit != null ? `${m.valHit}%` : '—', 'pos') +
    statCard('Точность рынка', m.mktHit != null ? `${m.mktHit}%` : '—', 'muted') +
    statCard('Перевес модели', lead != null ? `${lead > 0 ? '+' : ''}${lead.toFixed(1)}пп` : '—', lead != null ? (lead > 0 ? 'pos' : 'neg') : 'muted') +
    statCard('Уверенность', m.conf != null ? `${(m.conf * 100).toFixed(0)}пп` : '—', 'muted') +
    `</div>` +
    `<div class="pd-card"><h2>Точность модели vs рынка во времени</h2>${chart}` +
    `<div class="pd-foot"><span style="color:#4ad991">━ модель</span> &nbsp; <span style="color:#7d8794">━ рынок</span> · % верных предсказаний направления на свежих раундах (которые модель НЕ видела). Зелёная выше серой = модель умнее рынка. ${trend}</div></div>` +
    `<div class="pd-card"><h2>Эффективность по стратегиям</h2>` +
    `<table class="pd-table"><thead><tr><th>Стратегия</th><th style="text-align:right">Сделок</th><th style="text-align:right">Винрейт</th><th style="text-align:right">Безубыток</th><th style="text-align:right">Край</th><th style="text-align:right">PnL</th><th>Вердикт</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="pd-foot"><b>PnL = реальные деньги</b> (главное). Край — направленный сигнал, может расходиться с PnL (на разных коэффициентах разный размер payoff). Вердикт по деньгам; нужно ≥30 сделок для вывода.</div></div>` +
    PAPER_NOTE + `</div>`;
}

// Нормализация метрик для агрегатов: lagedge-семейство хранит статус в форме shadow.* (n/winRatePct/netPnl),
// прочие — в top-level rounds/winRate/netPnl. Без этого lagedge в таблицах показывался как «0 / $0».
function aggStat(s: StrategyDef): { rounds: number; winRate: number; netPnl: number; be: number | null } {
  if (s.slug.startsWith('lagedge')) {
    const sh = readDataJson(s.statusFile)?.shadow;
    return {
      rounds: typeof sh?.n === 'number' ? sh.n : 0,
      winRate: typeof sh?.winRatePct === 'number' ? Math.round(sh.winRatePct) : 0,
      netPnl: typeof sh?.netPnl === 'number' ? sh.netPnl : 0,
      be: null,
    };
  }
  const st = readStatus(s);
  let be: number | null = null;
  if (st?.coefBuckets) { let sn = 0, sb = 0; for (const b of st.coefBuckets) if (b.n > 0 && b.breakeven != null) { sn += b.n; sb += b.breakeven * b.n; } be = sn > 0 ? sb / sn : null; }
  return { rounds: st?.rounds ?? 0, winRate: st?.winRate ?? 0, netPnl: st?.netPnl ?? 0, be };
}

// Таблица кандидатов («система поощрения»): ранжируем живые движки по КРАЮ (винрейт − безубыток).
// Кто устойчиво обгоняет безубыток на достаточной выборке — лидер 🏆, он и идёт в реал.
function leaderboard(): string {
  const MIN_SAMPLE = 30;
  const rows = STRATEGIES.filter((s) => s.standalone && s.realEligible === true).map((s) => {
    const a = aggStat(s);
    const rounds = a.rounds;
    const winRate = a.winRate;
    const be = a.be;
    const edge = be != null && rounds > 0 ? winRate - be : null;
    const netPnl = a.netPnl;
    return { s, rounds, winRate, be, edge, netPnl };
  });
  // ранжируем строго по netPnl (кто впереди по деньгам), при равенстве — по числу сделок.
  rows.sort((a, b) => (b.netPnl - a.netPnl) || (b.rounds - a.rounds));
  const body = rows
    .map((r) => {
      // 🏆 только если в плюсе по деньгам И есть положительный край И набрана выборка.
      const leader = r.netPnl > 0 && r.edge != null && r.edge > 0 && r.rounds >= MIN_SAMPLE;
      const edgeCls = r.edge == null ? 'pd-muted-td' : r.edge > 0 ? 'pd-pos' : 'pd-neg';
      const pnlCls = r.netPnl > 0 ? 'pd-pos' : r.netPnl < 0 ? 'pd-neg' : 'pd-muted-td';
      return (
        `<tr><td>${leader ? '🏆 ' : ''}<a href="/predict/${r.s.slug}" style="color:#cfd6e0;text-decoration:none">${esc(r.s.title)}</a></td>` +
        `<td class="pd-muted-td" style="text-align:right">${r.rounds}</td>` +
        `<td style="text-align:right">${r.rounds > 0 ? r.winRate + '%' : '—'}</td>` +
        `<td class="pd-muted-td" style="text-align:right">${r.be != null ? r.be.toFixed(1) + '%' : '—'}</td>` +
        `<td class="${edgeCls}" style="text-align:right">${r.edge != null ? (r.edge > 0 ? '+' : '') + r.edge.toFixed(1) + 'пп' : '—'}</td>` +
        `<td class="${pnlCls}" style="text-align:right">${fmtUsd(r.netPnl)}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="pd-card" style="border-color:#3a5a2e"><h2>🏁 Таблица кандидатов — кто впереди</h2>` +
    `<table class="pd-table"><thead><tr><th>Стратегия</th><th style="text-align:right">Сделок</th><th style="text-align:right">Винрейт</th><th style="text-align:right">Безубыток</th><th style="text-align:right">Край</th><th style="text-align:right">PnL</th></tr></thead><tbody>${body}</tbody></table>` +
    `<div class="pd-foot"><b>PnL</b> = накопленный shadow-результат (плоско $5 на сделку). Безубыток ≈ средняя цена входа (порог, выше которого винрейт даёт плюс). Край (винрейт − безубыток) — направленный сигнал. 🏆 = лидер: в плюсе по деньгам, с положительным краем И ≥${MIN_SAMPLE} сделок. Пока сделок мало — это шум.</div></div>`
  );
}

type PfArbVenue = 'pm' | 'pf';
type PfArbLegPlan = {
  venue?: PfArbVenue;
  price?: number;
  avg?: number;
  last?: number;
  qty?: number;
  cost?: number;
};
type PfArbTakerPlan = {
  qty?: number;
  cross?: number;
  edge?: number;
  grossProfitUsd?: number;
  up?: PfArbLegPlan;
  down?: PfArbLegPlan;
  pfMode?: string;
  pmMode?: string;
  executable?: boolean;
  clips?: number;
  clipQty?: number;
};
type PfArbPair = {
  asset?: string;
  window?: string;
  slug?: string;
  secLeft?: number;
  pm?: { up?: number; down?: number; upSize?: number; downSize?: number };
  pf?: { marketId?: string | number; up?: number; down?: number; upSize?: number; downSize?: number; volumeUsd?: number };
  buyUp?: PfArbVenue;
  buyDown?: PfArbVenue;
  cross?: number;
  grossEdge?: number;
  grossProfitUsd?: number;
  executableQty?: number;
  freshExecutable?: boolean;
  takerExecutable?: boolean;
  takerPlan?: PfArbTakerPlan | null;
  takerLadder?: PfArbTakerPlan[];
  bestTakerLadder?: PfArbTakerPlan | null;
  pmSampleAgeMs?: number | null;
  pfBookAgeMs?: number | null;
  depthStatus?: string;
  iso?: string;
};
type PfArbStatus = {
  updatedAt?: string;
  mode?: string;
  note?: string;
  hasPredictFunApiKey?: boolean;
  pairs?: PfArbPair[];
  executableNow?: PfArbPair[];
  freshExecutableNow?: PfArbPair[];
  takerExecutableNow?: PfArbPair[];
  recentFreshExecutable?: PfArbPair[];
  recentAlerts?: PfArbPair[];
  bestFreshExecutable?: PfArbPair | null;
  bestTakerExecutable?: PfArbPair | null;
  stats?: Record<string, { n?: number; cand?: number; exec?: number; freshExec?: number; takerExec?: number; bestEdge?: number | null; bestGrossProfitUsd?: number | null; sumGrossProfitUsd?: number }>;
  taker?: { qty?: number; minEdge?: number; maxClips?: number; pfMode?: string; pmMode?: string };
  alerts?: { enabled?: boolean; minGrossProfitUsd?: number; minEdge?: number; cooldownS?: number; improveUsd?: number };
  freshness?: { pmMaxAgeMs?: number; pfMaxAgeMs?: number; minGrossProfitUsd?: number };
};

type PfArbRealPortfolio = {
  updatedAt?: string;
  complete?: boolean;
  baseline?: { at?: string; totalEquityUsd?: number; cashUsd?: number; positionValueUsd?: number } | null;
  pnlFromBaselineUsd?: number | null;
  totalEquityUsd?: number | null;
  cashUsd?: number | null;
  positionValueUsd?: number | null;
  history?: Array<{ ts?: number; iso?: string; totalEquityUsd?: number; pnlFromBaselineUsd?: number | null; cashUsd?: number | null; positionValueUsd?: number | null }>;
  pf?: { wallet?: string | null; signerWallet?: string | null; cashUsdt?: number | null; positions?: { ok?: boolean; count?: number; valueUsd?: number | null; pnlUsd?: number | null; error?: string | null } | null };
  pm?: { wallet?: string | null; cashUsdc?: number | null; positions?: { ok?: boolean; count?: number; valueUsd?: number | null; currentValueUsd?: number | null; cashPnlUsd?: number | null; error?: string | null } | null };
  errors?: Record<string, string | null | undefined>;
};

type PfArbRealStatus = {
  updatedAt?: string;
  enabled?: boolean;
  halted?: boolean;
  haltReason?: string | null;
  qty?: number;
  maxQty?: number;
  minEdge?: number;
  minLockEdge?: number;
  minNetLockUsd?: number;
  minNetEdge?: number;
  executionMode?: string;
  capitalLimitUsd?: number;
  capitalInUseUsd?: number;
  capitalAvailableUsd?: number;
  maxSessionLossUsd?: number;
  sessionPnlUsd?: number | null;
  riskSession?: { id?: string; at?: string; baselineEquityUsd?: number | null; maxLossUsd?: number } | null;
  tradesToday?: number;
  maxTradesDay?: number;
  attempts?: number;
  entered?: number;
  cleanRejects?: number;
  oneLegRisk?: number;
  skipped?: number;
  wallet?: string | null;
  signerWallet?: string | null;
  predictAccount?: string | null;
  pfUsdt?: number | null;
  liveBooks?: {
    enabled?: boolean;
    maxAgeMs?: number;
    maxSkewMs?: number;
    pfConnected?: boolean;
    pmConnected?: boolean;
    pfMessageAgeMs?: number | null;
    pmMessageAgeMs?: number | null;
    pfBooks?: number;
    pmBooks?: number;
    pfTargets?: number;
    pmTargets?: number;
    pfLastError?: string | null;
    pmLastError?: string | null;
  } | null;
  portfolio?: PfArbRealPortfolio | null;
  last?: { at?: string; event?: string; asset?: string; window?: string; slug?: string; edge?: number; [k: string]: unknown } | null;
  gate?: string;
};

const PF_ARB_STATUS_FILE = process.env.PREDICTFUN_ARB_STATUS ?? join(dataDir, 'predict-predictfun-arb-status.json');
const PF_ARB_REAL_STATUS_FILE = process.env.PREDICTFUN_ARB_REAL_STATUS ?? join(dataDir, 'predict-predictfun-arb-real-status.json');
const PF_ARB_REAL_AUDIT_FILE = process.env.PREDICTFUN_ARB_REAL_AUDIT ?? '/home/trader/apps/predict-tools/data/predictfun-arb-real.ndjson';
const PF_ARB_RECON_FILE = process.env.PREDICTFUN_ARB_RECON ?? join(dataDir, 'predict-predictfun-arb-reconciliation.json');
const PF_ARB_CONFIRMED_FILL_CUTOFF_MS = Date.parse('2026-07-09T18:10:00Z');

type PfArbReconciliation = {
  updatedAt?: string;
  baseline?: { at?: string; totalEquityUsd?: number; cashUsd?: number; positionValueUsd?: number };
  reconciled?: boolean;
  actual?: { cashDeltaUsd?: number; positionDeltaUsd?: number; equityDeltaUsd?: number; activityCashFlowUsd?: number };
  venues?: {
    pf?: { matches?: number; redemptions?: number; tradeCostUsd?: number; redeemedUsd?: number; cashFlowUsd?: number; feeShares?: number; feeCollateralEquivalentUsd?: number };
    pm?: { trades?: number; redemptions?: number; tradeCostUsd?: number; redeemedUsd?: number; cashFlowUsd?: number };
  };
  execution?: { results?: number; confirmedPairs?: number; pmOnly?: number; pfOnly?: number; neither?: number; confirmedNetLockUsd?: number; oldClaimedGrossUsd?: number; negativeConfirmedLocks?: number };
  pfOrders?: Record<string, { status?: string; amount?: number; amountFilled?: number; terminal?: boolean }>;
};

function readPfArbStatus(): PfArbStatus | null {
  try {
    if (!existsSync(PF_ARB_STATUS_FILE)) return null;
    return JSON.parse(readFileSync(PF_ARB_STATUS_FILE, 'utf8')) as PfArbStatus;
  } catch {
    return null;
  }
}

function readPfArbRealStatus(): PfArbRealStatus | null {
  try {
    if (!existsSync(PF_ARB_REAL_STATUS_FILE)) return null;
    return JSON.parse(readFileSync(PF_ARB_REAL_STATUS_FILE, 'utf8')) as PfArbRealStatus;
  } catch {
    return null;
  }
}

function readPfArbReconciliation(): PfArbReconciliation | null {
  try {
    if (!existsSync(PF_ARB_RECON_FILE)) return null;
    return JSON.parse(readFileSync(PF_ARB_RECON_FILE, 'utf8')) as PfArbReconciliation;
  } catch {
    return null;
  }
}

function pfN(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pfAge(updatedAt?: string): { sec: number | null; cls: string; label: string } {
  if (!updatedAt) return { sec: null, cls: 'pd-fresh-stale', label: 'нет данных' };
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return { sec: null, cls: 'pd-fresh-stale', label: 'время неизвестно' };
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  return { sec, cls: sec <= 15 ? 'pd-fresh-ok' : 'pd-fresh-stale', label: sec <= 15 ? `live ${sec}с` : `устарело ${sec}с` };
}

function pfPct(v: unknown, digits = 1): string {
  const n = pfN(v);
  return n == null ? '—' : `${(n * 100).toFixed(digits)}%`;
}

function pfUsd(v: unknown, digits = 2): string {
  const n = pfN(v);
  if (n == null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

function pfPrice(v: unknown): string {
  const n = pfN(v);
  return n == null ? '—' : `${Math.round(n * 100)}¢`;
}

function pfQty(v: unknown): string {
  const n = pfN(v);
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n >= 100 ? String(Math.round(n)) : n.toFixed(n < 10 ? 2 : 1);
}

function pfPlainUsd(v: unknown, digits = 2): string {
  const n = pfN(v);
  return n == null ? '—' : `$${n.toFixed(digits)}`;
}

function pfShortAddr(v?: string | null): string {
  if (!v) return '—';
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

function pfSideLabel(v: unknown): string {
  const s = String(v ?? '').toUpperCase();
  if (s === 'UP') return '<span class="pd-up">UP</span>';
  if (s === 'DOWN') return '<span class="pd-down">DOWN</span>';
  return esc(s || '—');
}

function pfTradeSlugMeta(slug?: string): { asset: string; window: string } {
  const s = String(slug ?? '');
  const asset = s.split('-')[0] || '?';
  const window = s.includes('-15m-') ? '15m' : s.includes('-5m-') ? '5m' : '?';
  return { asset, window };
}

function pfTimeLeft(v: unknown): string {
  const n = pfN(v);
  if (n == null) return '—';
  const s = Math.max(0, Math.round(n));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}с`;
}

function pfVenue(v?: PfArbVenue): string {
  return v === 'pf' ? 'Predict.fun' : v === 'pm' ? 'Polymarket' : '—';
}

function pfLegPrice(r: PfArbPair, side: 'up' | 'down', venue?: PfArbVenue): number | undefined {
  if (venue === 'pf') return side === 'up' ? r.pf?.up : r.pf?.down;
  if (venue === 'pm') return side === 'up' ? r.pm?.up : r.pm?.down;
  return undefined;
}

function pfLegSize(r: PfArbPair, side: 'up' | 'down', venue?: PfArbVenue): number | undefined {
  if (venue === 'pf') return side === 'up' ? r.pf?.upSize : r.pf?.downSize;
  if (venue === 'pm') return side === 'up' ? r.pm?.upSize : r.pm?.downSize;
  return undefined;
}

function pfSignalRow(r: PfArbPair, mode: 'now' | 'recent'): string {
  const taker = r.takerPlan ?? null;
  const upPx = taker?.up?.avg ?? pfLegPrice(r, 'up', r.buyUp);
  const dnPx = taker?.down?.avg ?? pfLegPrice(r, 'down', r.buyDown);
  const edge = taker?.edge ?? r.grossEdge;
  const gross = taker?.grossProfitUsd ?? r.grossProfitUsd;
  const qty = taker?.qty ?? r.executableQty;
  const liveCls = r.takerExecutable ? 'pd-pos' : r.freshExecutable ? '' : 'pd-muted-td';
  const when = mode === 'now' ? pfTimeLeft(r.secLeft) : (r.iso ? new Date(r.iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—');
  const asset = String(r.asset ?? '?').toUpperCase();
  const window = String(r.window ?? '');
  return (
    `<tr>` +
    `<td><b>${esc(asset)}</b> <span class="pd-muted-td">${esc(window)}</span></td>` +
    `<td class="${liveCls}">${mode === 'now' ? 'live' : 'history'}<br><span class="pd-muted-td">${esc(when)}</span></td>` +
    `<td>UP <b>${esc(pfVenue(r.buyUp))}</b> @ ${esc(pfPrice(upPx))}<br><span class="pd-muted-td">DOWN <b>${esc(pfVenue(r.buyDown))}</b> @ ${esc(pfPrice(dnPx))}</span></td>` +
    `<td style="text-align:right">${esc(pfPct(edge))}<br><span class="pd-muted-td">cross ${esc(pfPrice(r.cross))}</span></td>` +
    `<td style="text-align:right">${esc(pfQty(qty))}<br><span class="pd-muted-td">${esc(pfUsd(gross))}</span></td>` +
    `<td style="text-align:right"><span class="pd-muted-td">PM ${esc(String(r.pmSampleAgeMs ?? '—'))}ms</span><br><span class="pd-muted-td">PF ${esc(String(r.pfBookAgeMs ?? '—'))}ms</span></td>` +
    `</tr>`
  );
}

function pfPairRow(r: PfArbPair): string {
  const upBest = r.buyUp === 'pf' ? r.pf?.up : r.pm?.up;
  const dnBest = r.buyDown === 'pf' ? r.pf?.down : r.pm?.down;
  const status = r.takerExecutable ? '<b class="pd-pos">TAKER</b>' : r.freshExecutable ? '<span style="color:#e0b341">fresh</span>' : '<span class="pd-muted-td">watch</span>';
  return (
    `<tr>` +
    `<td><b>${esc((r.asset ?? '?').toUpperCase())}</b> <span class="pd-muted-td">${esc(r.window ?? '')}</span></td>` +
    `<td>${status}<br><span class="pd-muted-td">${esc(pfTimeLeft(r.secLeft))}</span></td>` +
    `<td>UP ${esc(pfVenue(r.buyUp))} ${esc(pfPrice(upBest))} <span class="pd-muted-td">(${esc(pfQty(pfLegSize(r, 'up', r.buyUp)))})</span><br>` +
    `<span class="pd-muted-td">DOWN ${esc(pfVenue(r.buyDown))} ${esc(pfPrice(dnBest))} (${esc(pfQty(pfLegSize(r, 'down', r.buyDown)))})</span></td>` +
    `<td style="text-align:right">${esc(pfPct(r.grossEdge))}<br><span class="pd-muted-td">${esc(pfUsd(r.grossProfitUsd))}</span></td>` +
    `<td style="text-align:right">${esc(r.depthStatus ?? '—')}</td>` +
    `</tr>`
  );
}

function pfStatsCards(st: PfArbStatus): string {
  const stats = st.stats ?? {};
  const keys = Object.keys(stats).sort();
  if (!keys.length) return `<div class="pd-card"><p class="pd-foot">Статистика ещё не накопилась.</p></div>`;
  return keys.map((k) => {
    const s = stats[k] ?? {};
    return (
      `<div class="pd-stat">` +
      `<div class="pd-stat-val">${esc(String(s.takerExec ?? 0))}</div>` +
      `<div class="pd-stat-lbl">${esc(k)} taker</div>` +
      `<div class="pd-foot">fresh ${esc(String(s.freshExec ?? 0))} · exec ${esc(String(s.exec ?? 0))} · best ${esc(pfPct(s.bestEdge))}</div>` +
      `</div>`
    );
  }).join('');
}

function pfEquitySparkline(port?: PfArbRealPortfolio | null): string {
  const points = (port?.history ?? [])
    .filter((p) => pfN(p.pnlFromBaselineUsd) != null)
    .slice(-120);
  if (points.length < 2) return `<div class="pd-empty-chart">Кривая появится после нескольких equity-снимков.</div>`;
  const W = 720;
  const H = 150;
  const PAD = 18;
  const ys = points.map((p) => pfN(p.pnlFromBaselineUsd) ?? 0);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const line = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0).toFixed(1);
  const last = ys[ys.length - 1] ?? 0;
  const color = last >= 0 ? '#4ad991' : '#e5616c';
  return (
    `<svg viewBox="0 0 ${W} ${H}" class="pd-chart" role="img" aria-label="Arb equity PnL">` +
    `<line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" stroke="#2a313c" stroke-width="1" stroke-dasharray="4 4"/>` +
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${color}"/>` +
    `</svg>`
  );
}

type PfArbAuditSummary = {
  entered: number;
  lockedGrossUsd: number;
  lockedCostUsd: number;
  postGuardEntered: number;
  postGuardLockedGrossUsd: number;
  postGuardCostUsd: number;
  postGuardNegative: number;
  oneLeg: number;
  hedged: number;
  confirmedPairs: number;
  pmOnly: number;
  pfOnly: number;
};

function renderPfArbRealStats(real: PfArbRealStatus | null, audit?: PfArbAuditSummary, recon?: PfArbReconciliation | null): string {
  const port = real?.portfolio ?? null;
  const pAge = pfAge(port?.updatedAt ?? real?.updatedAt);
  const pnl = pfN(recon?.actual?.equityDeltaUsd) ?? pfN(port?.pnlFromBaselineUsd);
  const pnlCls = pnl == null ? 'pd-stat-muted' : pnl >= 0 ? 'pd-stat-pos' : 'pd-stat-neg';
  const cashDelta = pfN(recon?.actual?.cashDeltaUsd);
  const confirmedNet = pfN(recon?.execution?.confirmedNetLockUsd) ?? pfN(audit?.lockedGrossUsd);
  const pfCashFlow = pfN(recon?.venues?.pf?.cashFlowUsd);
  const pmCashFlow = pfN(recon?.venues?.pm?.cashFlowUsd);
  const confirmedPairs = recon?.execution?.confirmedPairs ?? audit?.confirmedPairs ?? 0;
  const pmOnly = recon?.execution?.pmOnly ?? audit?.pmOnly ?? 0;
  const negativeLocks = recon?.execution?.negativeConfirmedLocks ?? audit?.postGuardNegative ?? 0;
  const pfCash = pfN(port?.pf?.cashUsdt);
  const pfPos = pfN(port?.pf?.positions?.valueUsd);
  const pmCash = pfN(port?.pm?.cashUsdc);
  const pmPos = pfN(port?.pm?.positions?.valueUsd);
  const pfTotal = pfCash != null && pfPos != null ? pfCash + pfPos : null;
  const pmTotal = pmCash != null && pmPos != null ? pmCash + pmPos : null;
  const entered = recon?.execution?.confirmedPairs ?? real?.entered ?? 0;
  const attempts = recon?.execution?.results ?? real?.attempts ?? 0;
  const fillRate = attempts > 0 ? entered / attempts : null;
  const last = real?.last;
  const baseAt = port?.baseline?.at ? new Date(port.baseline.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const errVals = Object.values(port?.errors ?? {}).filter(Boolean);
  const sessionPnl = pfN(real?.sessionPnlUsd);
  const sessionPnlCls = sessionPnl == null ? 'pd-stat-muted' : sessionPnl >= 0 ? 'pd-stat-pos' : 'pd-stat-neg';
  const capitalInUse = pfN(real?.capitalInUseUsd);
  const capitalLimit = pfN(real?.capitalLimitUsd);
  const liveBooks = real?.liveBooks;
  const liveReady = !!(liveBooks?.enabled && liveBooks?.pfConnected && liveBooks?.pmConnected);
  const pfWsAge = pfN(liveBooks?.pfMessageAgeMs);
  const pmWsAge = pfN(liveBooks?.pmMessageAgeMs);
  const wsFoot = liveReady
    ? `PF ${pfWsAge == null ? '—' : `${Math.round(pfWsAge)}ms`} · PM ${pmWsAge == null ? '—' : `${Math.round(pmWsAge)}ms`} · книг ${(liveBooks?.pfBooks ?? 0) + (liveBooks?.pmBooks ?? 0)}`
    : [liveBooks?.pfLastError, liveBooks?.pmLastError].filter(Boolean).join(' · ') || 'один из живых стаканов не подключён';
  const lastLine = last?.event
    ? `${last.event}${last.asset ? ` · ${String(last.asset).toUpperCase()} ${last.window ?? ''}` : ''}`
    : (real?.gate ?? 'нет событий');
  return (
    `<div class="pd-card pf-real">` +
    `<div class="pd-head" style="margin-bottom:12px"><h2 style="margin:0">Реальная арбитражная торговля</h2><span class="pd-fresh ${pAge.cls}"><span class="pd-dot"></span>${esc(pAge.label)}</span></div>` +
    `<div class="pd-grid">` +
    `<div class="pd-stat ${real?.halted ? 'pd-stat-neg' : 'pd-stat-pos'}"><div class="pd-stat-val">${real?.halted ? 'STOP' : 'LIVE'}</div><div class="pd-stat-lbl">НОЧНОЙ РЕЖИМ</div><div class="pd-foot">${esc(real?.haltReason ?? real?.gate ?? 'работает')}</div></div>` +
    `<div class="pd-stat ${sessionPnlCls}"><div class="pd-stat-val">${esc(pfUsd(sessionPnl))}</div><div class="pd-stat-lbl">НОЧНАЯ СЕССИЯ</div><div class="pd-foot">от момента запуска защиты</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPlainUsd(capitalInUse))} / ${esc(pfPlainUsd(capitalLimit))}</div><div class="pd-stat-lbl">КАПИТАЛ В РАБОТЕ</div><div class="pd-foot">одновременно не больше лимита</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPct(real?.minNetEdge))}</div><div class="pd-stat-lbl">МИНИМАЛЬНЫЙ NET EDGE</div><div class="pd-foot">после комиссий и допуска цены</div></div>` +
    `<div class="pd-stat ${liveReady ? 'pd-stat-pos' : 'pd-stat-neg'}"><div class="pd-stat-val">${liveReady ? 'PF + PM' : 'WS STOP'}</div><div class="pd-stat-lbl">ЖИВЫЕ СТАКАНЫ</div><div class="pd-foot">${esc(wsFoot)}</div></div>` +
    `<div class="pd-stat ${pnlCls}"><div class="pd-stat-val">${esc(pfUsd(pnl))}</div><div class="pd-stat-lbl">ИТОГ ДЕНЕГ ОТ СТАРТА</div><div class="pd-foot">${pnl == null ? 'нет данных' : pnl >= 0 ? 'мы в плюсе' : 'мы в минусе'} · cash + позиции − старт</div></div>` +
    `<div class="pd-stat ${(cashDelta ?? 0) >= 0 ? 'pd-stat-pos' : 'pd-stat-neg'}"><div class="pd-stat-val">${esc(pfUsd(cashDelta))}</div><div class="pd-stat-lbl">изменение денег</div><div class="pd-foot">вводы исключены baseline</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPlainUsd(port?.totalEquityUsd))}</div><div class="pd-stat-lbl">сейчас на двух биржах</div><div class="pd-foot">всё, что видят API</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPlainUsd(port?.baseline?.totalEquityUsd))}</div><div class="pd-stat-lbl">старт бота</div><div class="pd-foot">${esc(baseAt)}</div></div>` +
    `<div class="pd-stat ${(confirmedNet ?? 0) >= 0 ? 'pd-stat-pos' : 'pd-stat-neg'}"><div class="pd-stat-val">${esc(pfUsd(confirmedNet))}</div><div class="pd-stat-lbl">РЕЗУЛЬТАТ ПАР</div><div class="pd-foot">только FILLED/FILLED · комиссии учтены</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(String(confirmedPairs))}</div><div class="pd-stat-lbl">обе ноги FILLED</div><div class="pd-foot">не accepted, а исполнены</div></div>` +
    `<div class="pd-stat ${pmOnly ? 'pd-stat-neg' : 'pd-stat-pos'}"><div class="pd-stat-val">${esc(String(pmOnly))}</div><div class="pd-stat-lbl">PM-only входов</div><div class="pd-foot">одна нога · не арбитраж</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPlainUsd(port?.cashUsd))}</div><div class="pd-stat-lbl">свободные деньги</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPlainUsd(port?.positionValueUsd))}</div><div class="pd-stat-lbl">позиции / к выплате</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${entered}/${attempts}</div><div class="pd-stat-lbl">входы / попытки</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${fillRate == null ? '—' : `${Math.round(fillRate * 100)}%`}</div><div class="pd-stat-lbl">fill rate</div></div>` +
    `<div class="pd-stat ${negativeLocks ? 'pd-stat-neg' : 'pd-stat-pos'}"><div class="pd-stat-val">${esc(String(negativeLocks))}</div><div class="pd-stat-lbl">минусовых пар старой версии</div><div class="pd-foot">после реальных комиссий</div></div>` +
    `</div>` +
    `<div class="pf-venues">` +
    `<div class="pf-venue"><b>Predict.fun</b><span>${esc(pfPlainUsd(pfTotal))}</span><small>cash ${esc(pfPlainUsd(pfCash))} · positions ${esc(pfPlainUsd(pfPos))} · n=${esc(String(port?.pf?.positions?.count ?? '—'))}</small><small>${esc(pfShortAddr(port?.pf?.wallet))}</small></div>` +
    `<div class="pf-venue"><b>Polymarket</b><span>${esc(pfPlainUsd(pmTotal))}</span><small>cash ${esc(pfPlainUsd(pmCash))} · positions ${esc(pfPlainUsd(pmPos))} · n=${esc(String(port?.pm?.positions?.count ?? '—'))}</small><small>${esc(pfShortAddr(port?.pm?.wallet))}</small></div>` +
    `</div>` +
    pfEquitySparkline(port) +
    `<div class="pd-foot"><b>ИТОГ ДЕНЕГ ОТ СТАРТА</b> — текущие деньги и позиции на двух биржах минус стартовый снимок. Это главный ответ на вопрос «мы в плюсе или в минусе». <b>Результат пар</b> — отдельный журнал только исполненных двухногих сделок; он не включает старые PM-only входы.</div>` +
    `<div class="pd-foot">Исторический поток по площадкам: Predict.fun <span class="${(pfCashFlow ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}">${esc(pfUsd(pfCashFlow))}</span> · Polymarket <span class="${(pmCashFlow ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}">${esc(pfUsd(pmCashFlow))}</span>. ${real?.halted ? `Ночная торговля остановлена: ${esc(real.haltReason ?? 'risk guard')}.` : `Новая версия работает в режиме ${esc(real?.executionMode ?? '—')}, повторно проверяет обе ноги и ограничивает занятый капитал $50.`}</div>` +
    (recon?.reconciled ? `<div class="pd-foot pd-pos">Сверка со сделками площадок сошлась с изменением баланса.</div>` : `<div class="pd-foot pd-neg">Сверка площадок ещё не завершена; не используем цифру для сайзинга.</div>`) +
    `<div class="pd-foot">Сейчас ${esc(pfPlainUsd(port?.totalEquityUsd))} против старта ${esc(pfPlainUsd(port?.baseline?.totalEquityUsd))} (${esc(baseAt)}). Счётчик сделок: today ${esc(String(real?.tradesToday ?? 0))}/${esc(String(real?.maxTradesDay ?? '—'))}, clean rejects ${esc(String(real?.cleanRejects ?? 0))}, one-leg risk ${esc(String(real?.oneLegRisk ?? 0))} (исторический), audit entered ${esc(String(audit?.entered ?? 0))}, hedged ${esc(String(audit?.hedged ?? 0))}. Последнее: ${esc(lastLine)}.</div>` +
    (errVals.length ? `<div class="pd-foot pd-neg">Ошибки портфеля: ${esc(errVals.join(' · '))}</div>` : '') +
    `</div>`
  );
}

type PfArbTrade = {
  ts: number;
  iso: string;
  id: string;
  asset: string;
  window: string;
  slug: string;
  status: 'entered' | 'hedged' | 'pm_only' | 'pf_only';
  edge?: number | null;
  cross?: number | null;
  qty?: number | null;
  pfSide?: string | null;
  pfAvg?: number | null;
  pfCost?: number | null;
  pfMs?: number | null;
  pmSide?: string | null;
  pmAvg?: number | null;
  pmCost?: number | null;
  pmMs?: number | null;
  upShares?: number | null;
  downShares?: number | null;
  lockedGrossUsd?: number | null;
  totalCostUsd?: number | null;
  hedgeReason?: string | null;
};

function tailText(file: string, maxBytes = 3_000_000): string {
  try {
    const st = statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function pfAuditFeeShares(qty: number, price: number, feeRateBps: number): number {
  return qty > 0 && price > 0 && price < 1 ? qty * (feeRateBps / 10000) * Math.min(price, 1 - price) / price : 0;
}

function pmAuditFeeUsd(qty: number, price: number): number {
  return qty > 0 && price > 0 && price < 1 ? qty * 0.07 * price * (1 - price) : 0;
}

function readPfArbTrades(recon: PfArbReconciliation | null = readPfArbReconciliation()): { trades: PfArbTrade[]; byKey: Record<string, { entered: number; hedged: number; notional: number; locked: number }>; summary: PfArbAuditSummary } {
  const txt = tailText(PF_ARB_REAL_AUDIT_FILE);
  const emptySummary: PfArbAuditSummary = { entered: 0, lockedGrossUsd: 0, lockedCostUsd: 0, postGuardEntered: 0, postGuardLockedGrossUsd: 0, postGuardCostUsd: 0, postGuardNegative: 0, oneLeg: 0, hedged: 0, confirmedPairs: 0, pmOnly: 0, pfOnly: 0 };
  if (!txt) return { trades: [], byKey: {}, summary: emptySummary };
  const attempts = new Map<string, PfArbPair>();
  const trades: PfArbTrade[] = [];
  const summary: PfArbAuditSummary = { ...emptySummary };
  for (const line of txt.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = String(r.event ?? '');
    const id = String(r.id ?? '');
    if (!id) continue;
    if (event === 'attempt' && r.sig && typeof r.sig === 'object') {
      attempts.set(id, r.sig as PfArbPair);
      continue;
    }
    if (event !== 'result') continue;
    const ts = pfN(r.ts) ?? (Date.parse(String(r.iso ?? '')) || 0);
    const baselineTs = Date.parse(String(recon?.baseline?.at ?? ''));
    if (Number.isFinite(baselineTs) && ts < baselineTs) continue;
    const pfWrap = r.pf as { ok?: boolean; data?: Record<string, unknown>; error?: string } | undefined;
    const pmWrap = r.pm as { ok?: boolean; data?: Record<string, unknown>; error?: string } | undefined;
    const hedge = r.hedge as { ok?: boolean; venue?: string; reason?: string; hedge?: { data?: Record<string, unknown> } } | null | undefined;
    const pf = pfWrap?.data;
    const pm = pmWrap?.data;
    const hedged = !!hedge?.ok;
    const hedgeLeg = hedge?.hedge?.data;
    const pfHash = String(pf?.hash ?? '');
    const pfOrder = pfHash ? recon?.pfOrders?.[pfHash] : undefined;
    const pfDirectOk = pfOrder
      ? ['FILLED', 'MATCHED'].includes(String(pfOrder.status ?? '').toUpperCase()) && Number(pfOrder.amountFilled ?? 0) > 0
      : r.pfFilled === true && pf?.ok === true;
    const directPmShares = pfN(pm?.matched) ?? pfN(pm?.taking) ?? 0;
    const pmDirectOk = r.pmFilled === true && directPmShares > 0;
    const pfLeg = pfDirectOk ? pf : (hedged && hedge?.venue === 'pf' ? hedgeLeg : pf);
    const pmLeg = pmDirectOk ? pm : (hedged && hedge?.venue === 'pm' ? hedgeLeg : pm);
    const pfOk = pfDirectOk || (hedged && hedge?.venue === 'pf' && pfLeg?.ok === true);
    const pmShares = pfN(pmLeg?.matched) ?? pfN(pmLeg?.taking) ?? 0;
    const pmOk = pmShares > 0;
    if (pfOk && pmOk) summary.confirmedPairs += 1;
    else if (!pfOk && pmOk) { summary.oneLeg += 1; summary.pmOnly += 1; }
    else if (pfOk && !pmOk) { summary.oneLeg += 1; summary.pfOnly += 1; }
    else continue;
    const sig = attempts.get(id);
    const slug = String((sig?.slug ?? pf?.slug ?? pm?.slug ?? id.split('|')[0]) || '');
    const meta = pfTradeSlugMeta(slug);
    const qty = pfN(pfLeg?.qty) ?? pfN(pmLeg?.qty) ?? pfN(sig?.takerPlan?.qty);
    const pfAvg = pfN(pfLeg?.avg);
    const pmAvg = pfN(pmLeg?.avg) ?? pfN(pmLeg?.limitPrice);
    const edge = pfN(sig?.takerPlan?.edge) ?? (pfAvg != null && pmAvg != null ? 1 - pfAvg - pmAvg : null);
    const pfSide = String(pfLeg?.side ?? '').toUpperCase();
    const pmSide = String(pmLeg?.side ?? '').toUpperCase();
    const pfGrossShares = pfOk ? (pfN(pfOrder?.amountFilled) ?? pfN(pfLeg?.filledQty) ?? pfN(pfLeg?.qty) ?? 0) : 0;
    const pfFeeShares = pfN(pfLeg?.feeShares) ?? (pfAvg != null ? pfAuditFeeShares(pfGrossShares, pfAvg, pfN(pfLeg?.feeRateBps) ?? 200) : 0);
    const pfShares = pfOk ? (pfN(pfLeg?.netShares) ?? Math.max(0, pfGrossShares - pfFeeShares)) : 0;
    const upShares = (pfSide === 'UP' ? pfShares : 0) + (pmSide === 'UP' ? pmShares : 0);
    const downShares = (pfSide === 'DOWN' ? pfShares : 0) + (pmSide === 'DOWN' ? pmShares : 0);
    const pfCost = pfOk ? pfN(pfLeg?.cost) : 0;
    const pmFee = pfN(pmLeg?.feeUsd) ?? (pmAvg != null ? pmAuditFeeUsd(pmShares, pmAvg) : 0);
    const pmCost = pfN(pmLeg?.allInCost) ?? ((pfN(pmLeg?.notional) ?? 0) + pmFee);
    const totalCost = (pfCost ?? 0) + (pmCost ?? 0);
    const lockedGross = pfOk && pmOk && upShares > 0 && downShares > 0 ? Math.min(upShares, downShares) - totalCost : null;
    if (lockedGross != null) {
      summary.entered += 1;
      summary.lockedGrossUsd += lockedGross;
      summary.lockedCostUsd += totalCost;
      if (ts >= PF_ARB_CONFIRMED_FILL_CUTOFF_MS) {
        summary.postGuardEntered += 1;
        summary.postGuardLockedGrossUsd += lockedGross;
        summary.postGuardCostUsd += totalCost;
        if (lockedGross < -0.000001) summary.postGuardNegative += 1;
      }
    }
    if (hedged) summary.hedged += 1;
    trades.push({
      ts,
      iso: String(r.iso ?? ''),
      id,
      asset: meta.asset,
      window: meta.window,
      slug,
      status: pfOk && pmOk ? (hedged ? 'hedged' : 'entered') : (pmOk ? 'pm_only' : 'pf_only'),
      edge,
      cross: edge != null ? 1 - edge : null,
      qty,
      pfSide,
      pfAvg,
      pfCost,
      pfMs: pfN(pfLeg?.ms),
      pmSide,
      pmAvg,
      pmCost,
      pmMs: pfN(pmLeg?.ms),
      upShares,
      downShares,
      lockedGrossUsd: lockedGross,
      totalCostUsd: totalCost,
      hedgeReason: hedged ? String(hedge?.reason ?? '') : null,
    });
  }
  trades.sort((a, b) => b.ts - a.ts);
  const byKey: Record<string, { entered: number; hedged: number; notional: number; locked: number }> = {};
  for (const t of trades) {
    if (t.status === 'pm_only' || t.status === 'pf_only') continue;
    const key = `${t.asset}:${t.window}`;
    const row = (byKey[key] ??= { entered: 0, hedged: 0, notional: 0, locked: 0 });
    row.entered += 1;
    if (t.status === 'hedged') row.hedged += 1;
    row.notional += (t.pfCost ?? 0) + (t.pmCost ?? 0);
    row.locked += t.lockedGrossUsd ?? 0;
  }
  return { trades, byKey, summary };
}

function pfTrackedMarketsTable(st: PfArbStatus | null, tradeAgg: Record<string, { entered: number; hedged: number; notional: number; locked: number }>): string {
  const keys = new Set<string>(Object.keys(st?.stats ?? {}));
  for (const p of st?.pairs ?? []) if (p.asset && p.window) keys.add(`${p.asset}:${p.window}`);
  for (const k of Object.keys(tradeAgg)) keys.add(k);
  const rows = [...keys].sort().map((k) => {
    const s = st?.stats?.[k] ?? {};
    const a = tradeAgg[k] ?? { entered: 0, hedged: 0, notional: 0, locked: 0 };
    const live = (st?.pairs ?? []).find((p) => `${p.asset}:${p.window}` === k);
    const status = live
      ? (live.takerExecutable ? '<b class="pd-pos">TAKER сейчас</b>' : live.freshExecutable ? '<span style="color:#e0b341">fresh сейчас</span>' : '<span class="pd-muted-td">live watch</span>')
      : '<span class="pd-muted-td">нет текущего рынка</span>';
    return (
      `<tr>` +
      `<td><b>${esc(k.toUpperCase())}</b></td>` +
      `<td>${status}</td>` +
      `<td style="text-align:right">${esc(String(s.n ?? 0))}</td>` +
      `<td style="text-align:right">${esc(String(s.takerExec ?? 0))}<br><span class="pd-muted-td">fresh ${esc(String(s.freshExec ?? 0))}</span></td>` +
      `<td style="text-align:right">${esc(pfPct(s.bestEdge))}<br><span class="pd-muted-td">${esc(pfUsd(s.sumGrossProfitUsd))}</span></td>` +
      `<td style="text-align:right"><b>${esc(String(a.entered))}</b><br><span class="pd-muted-td">hedge ${esc(String(a.hedged))}</span></td>` +
      `<td style="text-align:right">${esc(pfPlainUsd(a.notional))}<br><span class="${a.locked >= 0 ? 'pd-pos' : 'pd-neg'}">${esc(pfUsd(a.locked))}</span></td>` +
      `</tr>`
    );
  }).join('');
  return (
    `<div class="pd-card"><h2>Все рынки, которые отслеживаем и торгуем</h2>` +
    (rows ? `<div class="pf-table-wrap"><table class="pd-table"><thead><tr><th>Asset/window</th><th>Сейчас</th><th style="text-align:right">сканов</th><th style="text-align:right">taker/fresh</th><th style="text-align:right">best/sum edge</th><th style="text-align:right">реал входы</th><th style="text-align:right">оборот / locked</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="pd-foot">Пока нет накопленной статистики по рынкам.</p>`) +
    `<p class="pd-foot">Если в текущем стакане нет активного рынка по ETH/BNB/etc, он всё равно остаётся в этой таблице по накопленной статистике. Реальные входы появляются только после исполнения обеих ног или hedge.</p>` +
    `</div>`
  );
}

function pfTradeHistoryTable(trades: PfArbTrade[], sessionStartedAt?: string): string {
  const sessionTs = sessionStartedAt ? Date.parse(sessionStartedAt) : NaN;
  const sessionTrades = Number.isFinite(sessionTs) ? trades.filter((t) => t.ts >= sessionTs) : trades;
  const rows = sessionTrades.slice(0, 35).map((t) => {
    const when = t.iso ? new Date(t.iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const edgeCls = (t.edge ?? 0) >= 0 ? 'pd-pos' : 'pd-neg';
    const status = t.status === 'hedged'
      ? '<span style="color:#e0b341">hedge</span>'
      : t.status === 'pm_only'
        ? '<b class="pd-neg">только PM</b>'
        : t.status === 'pf_only'
          ? '<b class="pd-neg">только PF</b>'
          : '<b class="pd-pos">обе FILLED</b>';
    const lockCls = t.lockedGrossUsd == null ? 'pd-stat-muted' : t.lockedGrossUsd >= 0 ? 'pd-pos' : 'pd-neg';
    const market = `${t.asset.toUpperCase()} ${t.window}`;
    return (
      `<tr>` +
      `<td class="pf-col-time"><b>${esc(when)}</b><br><span class="pd-muted-td">${esc(market)}</span></td>` +
      `<td class="pf-leg pf-leg-pf"><b>${pfSideLabel(t.pfSide)}</b><br><span class="pd-muted-td">${esc(pfPrice(t.pfAvg))} · ${esc(pfPlainUsd(t.pfCost))} · ${esc(String(t.pfMs ?? '—'))}ms</span></td>` +
      `<td class="pf-leg pf-leg-pm"><b>${pfSideLabel(t.pmSide)}</b><br><span class="pd-muted-td">${esc(pfPrice(t.pmAvg))} · ${esc(pfPlainUsd(t.pmCost))} · ${esc(String(t.pmMs ?? '—'))}ms</span></td>` +
      `<td class="pf-num">${esc(pfQty(t.qty))}</td>` +
      `<td class="${edgeCls} pf-num"><b>${esc(pfPct(t.edge))}</b><br><span class="pd-muted-td">cross ${esc(pfPrice(t.cross))}</span></td>` +
      `<td class="${lockCls} pf-num"><b>${esc(pfUsd(t.lockedGrossUsd, 4))}</b></td>` +
      `<td>${status}</td>` +
      `</tr>`
    );
  }).join('');
  return (
    `<div class="pd-card"><h2>Сделки новой защищённой версии</h2>` +
    (rows ? `<div class="pf-table-wrap"><table class="pd-table pf-trade-table"><thead><tr><th>Время / рынок</th><th>Predict.fun</th><th>Polymarket</th><th class="pf-num">Qty</th><th class="pf-num">Edge</th><th class="pf-num">Net пары</th><th>Статус</th></tr></thead><tbody>${rows}</tbody></table></div><p class="pd-foot">Net пары показывается с точностью до десятитысячных и только после подтверждения FILLED/FILLED. Старые PM-only сделки до запуска защиты здесь скрыты.</p>` : `<p class="pd-foot">После запуска защищённой версии исполненных сделок пока нет. Старые PM-only сделки намеренно скрыты.</p>`) +
    `</div>`
  );
}

function renderPredictFunArbDashboard(): string {
  const st = readPfArbStatus();
  const real = readPfArbRealStatus();
  const recon = readPfArbReconciliation();
  const realTrades = readPfArbTrades(recon);
  const age = pfAge(st?.updatedAt);
  const nowRows = (st?.takerExecutableNow ?? []).map((r) => pfSignalRow(r, 'now')).join('');
  const freshRows = (st?.freshExecutableNow ?? [])
    .filter((r) => !r.takerExecutable)
    .map((r) => pfSignalRow(r, 'now'))
    .join('');
  const pairRows = (st?.pairs ?? []).map(pfPairRow).join('');
  const recentRows = (st?.recentFreshExecutable ?? []).slice(-12).reverse().map((r) => pfSignalRow(r, 'recent')).join('');
  const taker = st?.taker ?? {};
  const alerts = st?.alerts ?? {};
  const freshness = st?.freshness ?? {};
  const activeNow = st?.takerExecutableNow?.length ?? 0;
  const freshNow = st?.freshExecutableNow?.length ?? 0;
  const pairsNow = st?.pairs?.length ?? 0;
  const mode = st?.mode ?? 'no-data';
  return (
    STYLES +
    `<style>
      .pd-wrap{max-width:1360px}
      .pf-hero{border-color:#2e5a4a;background:linear-gradient(180deg,rgba(74,217,145,.08),rgba(17,21,28,0))}
      .pf-strip{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 18px}
      .pf-pill{font-size:12px;border:1px solid #26313d;background:#0d1117;border-radius:999px;padding:5px 9px;color:#b6bdc8}
      .pf-pill b{color:#fff}
      .pf-table-wrap{overflow-x:auto}
      .pf-trade-table{min-width:920px}
      .pf-trade-table th,.pf-trade-table td{white-space:nowrap;vertical-align:middle}
      .pf-trade-table .pf-col-time{min-width:130px;white-space:normal}
      .pf-trade-table .pf-col-time .pd-muted-td{word-break:normal}
      .pf-leg{min-width:190px;border-left:1px solid rgba(255,255,255,.04)}
      .pf-leg-pf{background:rgba(99,102,241,.035)}
      .pf-leg-pm{background:rgba(74,217,145,.035)}
      .pf-leg .pd-muted-td{font-size:12px}
      .pf-num{text-align:right}
      .pf-live{border-color:#2e5a3a;box-shadow:0 0 0 1px rgba(74,217,145,.08)}
      .pf-real{border-color:#34405a}
      .pf-venues{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:4px 0 14px}
      .pf-venue{background:#0d1117;border:1px solid #1e2530;border-radius:10px;padding:12px}
      .pf-venue b{display:block;color:#cfd6e0;margin-bottom:4px}
      .pf-venue span{display:block;font-size:22px;font-weight:700;color:#fff}
      .pf-venue small{display:block;color:#8b95a4;margin-top:4px;line-height:1.35}
    </style>` +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>Predict.fun ↔ Polymarket · arb scanner</h1><span class="pd-fresh ${age.cls}"><span class="pd-dot"></span>${esc(age.label)}</span></div>` +
    `<p class="pd-sub">Главная панель показывает вилочный сканер и реальное исполнение. Логика входа: Predict.fun <b>MARKET/FOK</b> + Polymarket <b>LIMIT/FAK</b>, клип ${esc(pfQty(taker.qty))} shares, реальный вход только если net edge после комиссий ≥ ${esc(pfPct(real?.minNetEdge ?? real?.minEdge ?? 0.05))}. “Вошёл” в Telegram отправляется только после подтверждения обеих ног.</p>` +
    `<div class="pd-card pf-hero">` +
    `<h2>Режим</h2>` +
    `<div class="pf-strip">` +
    `<span class="pf-pill">mode <b>${esc(mode)}</b></span>` +
    `<span class="pf-pill">API key <b>${st?.hasPredictFunApiKey ? 'есть' : 'нет'}</b></span>` +
    `<span class="pf-pill">PF leg <b>${esc(taker.pfMode ?? 'MARKET_FOK')}</b></span>` +
    `<span class="pf-pill">PM leg <b>${esc(taker.pmMode ?? 'LIMIT_FAK')}</b></span>` +
    `<span class="pf-pill">max clips <b>${esc(String(taker.maxClips ?? 5))}</b></span>` +
    `<span class="pf-pill">fresh PM/PF <b>${esc(String(freshness.pmMaxAgeMs ?? 5000))}/${esc(String(freshness.pfMaxAgeMs ?? 5000))}ms</b></span>` +
    `<span class="pf-pill">Scanner alerts <b>${alerts.enabled ? 'on' : 'off'}</b></span>` +
    `</div>` +
    `<div class="pd-grid" style="margin-bottom:0">` +
    `<div class="pd-stat ${activeNow ? 'pd-stat-pos' : 'pd-stat-muted'}"><div class="pd-stat-val">${activeNow}</div><div class="pd-stat-lbl">taker now</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${freshNow}</div><div class="pd-stat-lbl">fresh exec</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${pairsNow}</div><div class="pd-stat-lbl">pairs watched</div></div>` +
    `<div class="pd-stat"><div class="pd-stat-val">${esc(pfPct(alerts.minEdge ?? taker.minEdge ?? 0.03))}</div><div class="pd-stat-lbl">alert min edge</div></div>` +
    `</div>` +
    `</div>` +
    renderPfArbRealStats(real, realTrades.summary, recon) +
    pfTrackedMarketsTable(st, realTrades.byKey) +
    pfTradeHistoryTable(realTrades.trades, real?.riskSession?.at) +
    `<div class="pd-card ${activeNow ? 'pf-live' : ''}"><h2>Сейчас можно брать taker</h2>` +
    (nowRows ? `<div class="pf-table-wrap"><table class="pd-table"><thead><tr><th>Рынок</th><th>Статус</th><th>Ноги</th><th style="text-align:right">Edge</th><th style="text-align:right">Qty / gross</th><th style="text-align:right">Fresh</th></tr></thead><tbody>${nowRows}</tbody></table></div>` : `<p class="pd-foot">Сейчас нет вилки, проходящей taker-фильтр. Сканер ждёт следующий раунд/движение стакана.</p>`) +
    `</div>` +
    `<div class="pd-card"><h2>Свежие executable, но не taker</h2>` +
    (freshRows ? `<div class="pf-table-wrap"><table class="pd-table"><thead><tr><th>Рынок</th><th>Статус</th><th>Ноги</th><th style="text-align:right">Edge</th><th style="text-align:right">Qty / gross</th><th style="text-align:right">Fresh</th></tr></thead><tbody>${freshRows}</tbody></table></div>` : `<p class="pd-foot">Нет отдельных fresh-вилок вне taker-гейта.</p>`) +
    `</div>` +
    `<div class="pd-grid">${pfStatsCards(st ?? {})}</div>` +
    `<div class="pd-card"><h2>Наблюдаемые пары</h2>` +
    (pairRows ? `<div class="pf-table-wrap"><table class="pd-table"><thead><tr><th>Пара</th><th>Статус</th><th>Лучшие ноги</th><th style="text-align:right">Edge</th><th style="text-align:right">Depth</th></tr></thead><tbody>${pairRows}</tbody></table></div>` : `<p class="pd-foot">Статус-файл пока пустой или сканер не успел записать пары.</p>`) +
    `</div>` +
    `<div class="pd-card"><h2>Последние свежие вилки</h2>` +
    (recentRows ? `<div class="pf-table-wrap"><table class="pd-table"><thead><tr><th>Рынок</th><th>Когда</th><th>Ноги</th><th style="text-align:right">Edge</th><th style="text-align:right">Qty / gross</th><th style="text-align:right">Fresh</th></tr></thead><tbody>${recentRows}</tbody></table></div>` : `<p class="pd-foot">История свежих вилок ещё не набралась.</p>`) +
    `</div>` +
    `<p class="pd-foot">Старые страницы стратегий не удалены: они доступны по прямым ссылкам. Корневой /predict теперь сфокусирован на Predict.fun arb.</p>` +
    `</div>`
  );
}

function renderOverview(): string {
  return (
    renderPredictFunArbDashboard()
  );
}

type HealthReport = {
  updatedAt: string;
  strategies: {
    slug: string; title: string; rounds: number; evaluated?: number;
    winRate?: number; breakeven?: number | null; edge?: number | null; avgCoef?: number | null;
    maxLossStreak?: number; netPnl?: number; maxDrawdown?: number;
    calib?: { predicted: number; actual: number; gap: number } | null;
    recent?: { rounds: number; winRate?: number; edge?: number | null; calib?: { predicted: number; actual: number; gap: number } | null } | null;
    verdict?: string; flag?: string;
  }[];
};
function readReport(): HealthReport | null {
  try {
    const p = join(dataDir, 'predict-report.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as HealthReport;
  } catch {
    /* нет отчёта */
  }
  return null;
}
function renderReport(): string {
  const r = readReport();
  const back = `<a class="pd-back" href="/predict">← раздел /predict</a>`;
  if (!r) {
    return STYLES + `<div class="pd-wrap">${back}<div class="pd-head"><h1>Авто-отчёт</h1></div><p class="pd-sub">Отчёт ещё не сформирован — обновляется автоматически каждые 3 часа.</p></div>`;
  }
  const right = 'style="text-align:right"';
  const edgeCell = (e?: number | null) =>
    e == null ? '<td class="pd-muted-td" style="text-align:right">—</td>' : `<td ${right} class="${e >= 2 ? 'pd-pos' : e <= -2 ? 'pd-neg' : 'pd-muted-td'}">${e >= 0 ? '+' : ''}${e}пп</td>`;
  const rows = r.strategies
    .map((s) => {
      if (!s.rounds) {
        const v = s.verdict ?? 'нет данных';
        const cls = v.includes('НЕ ВХОДИТ') ? 'pd-neg' : '';
        return `<tr><td>${esc(s.title)}</td><td style="text-align:right" class="pd-muted-td">0</td><td class="${cls}" colspan="8" style="font-size:12.5px">${esc(v)}${s.flag ? ` · ${esc(s.flag)}` : ''}</td></tr>`;
      }
      // «Калибровка» — актуальная (свежее окно), с исторической мелким шрифтом.
      const rc = s.recent?.calib ?? null;
      const calib = rc
        ? `${rc.actual}% факт<span class="pd-muted-td"> · модель ${rc.predicted}%${rc.gap > 10 ? ' ⚠️' : ''}</span>`
        : s.calib
          ? `${s.calib.actual}% факт<span class="pd-muted-td"> · модель ${s.calib.predicted}%</span>`
          : '—';
      // Win%: за всё время + «сейчас» (свежее окно), если оно отличается.
      const recW = s.recent && s.recent.rounds >= 10 && typeof s.recent.winRate === 'number' ? s.recent.winRate : null;
      const winCell = recW != null && recW !== s.winRate
        ? `${s.winRate}%<span class="pd-muted-td" style="font-size:11px"> · сейчас ${recW}%</span>`
        : `${s.winRate}%`;
      const vClass = (s.verdict ?? '').includes('✅') ? 'pd-pos' : (s.verdict ?? '').includes('⚠️') ? 'pd-neg' : '';
      return (
        `<tr>` +
        `<td><a href="/predict/${esc(s.slug)}" style="color:#cfd6e0;text-decoration:none">${esc(s.title)}</a></td>` +
        `<td ${right}>${s.rounds}</td>` +
        `<td ${right}>${winCell}</td>` +
        edgeCell(s.edge) +
        `<td ${right}>${s.maxLossStreak}</td>` +
        `<td ${right}>${s.avgCoef ?? '—'}</td>` +
        `<td ${right} class="${(s.netPnl ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}">${fmtUsd(s.netPnl ?? 0)}</td>` +
        `<td ${right}>$${(s.maxDrawdown ?? 0).toFixed(2)}</td>` +
        `<td class="pd-muted-td" style="font-size:12px">${calib}</td>` +
        `<td class="${vClass}" style="font-size:12.5px">${esc(s.verdict ?? '')}${s.flag ? ` · ${esc(s.flag)}` : ''}</td>` +
        `</tr>`
      );
    })
    .join('');
  const updated = new Date(r.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' });
  return (
    STYLES +
    `<div class="pd-wrap">${back}` +
    `<div class="pd-head"><h1>Авто-отчёт здоровья</h1></div>` +
    `<p class="pd-sub">Автоматический разбор всех стратегий каждые 3 часа: реальное преимущество (winrate − точка безубытка), серии проигрышей, калибровка оценки вероятности, просадка и вердикт. Цель — подтверждать стабильность или ловить, что улучшить. Ничего не меняет автоматически — только сигналит.</p>` +
    `<div class="pd-card"><table class="pd-table"><thead><tr>` +
    `<th>Стратегия</th><th ${right}>n</th><th ${right}>Win%</th><th ${right}>Край</th><th ${right}>Серия−</th><th ${right}>Коэф</th><th ${right}>Net PnL</th><th ${right}>Max DD</th><th>Калибровка</th><th>Вердикт</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="pd-foot">«Win%» — за всё время, «сейчас» — по свежему окну последних ${40} сделок (актуальная вероятность). «Край» = реальный % выигрышей минус точка безубытка (= средняя цена входа); положительный край = система в плюсе на дистанции. «Калибровка»: <b>«% факт»</b> — реальная вероятность, по которой система и считает ставку (само-калибрующийся Келли); «модель N%» — внутренняя z-оценка (только отбор сделок). Если модель оптимистичнее факта на >10пп — ⚠️, но на размер ставки это не влияет.</p>` +
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC</p></div>`
  );
}

// Блок «Бумага ↔ Реал» — только для realEligible-стратегий (h5m8/h5m12/h5m20). Показывает рядом
// ключевые цифры shadow и real ОДНОЙ стратегии, чтобы видеть сходимость исполнения. Read-only.
function renderCompareBlock(s: StrategyDef): string {
  if (!(s.standalone && s.realEligible === true)) return '';
  const sh = readDataJson(s.statusFile) as PredictStatus | null;                         // бумага (shadow)
  const re = readDataJson(`predict-${s.slug}real-status.json`) as PredictStatus | null;  // реал
  if (!sh && !re) return '';
  const row = (label: string, st: PredictStatus | null): string => {
    if (!st) return `<tr><td>${label}</td><td colspan="5" class="pd-muted-td" style="text-align:center">нет данных</td></tr>`;
    const pf = st.profitFactor == null ? '—' : st.profitFactor.toFixed(2);
    const acc = st.netPnl > 0 ? 'pd-pos' : st.netPnl < 0 ? 'pd-neg' : 'pd-muted-td';
    return `<tr><td>${label}</td>` +
      `<td style="text-align:right">${st.rounds}</td>` +
      `<td style="text-align:right">${st.winRate}%</td>` +
      `<td class="${acc}" style="text-align:right">${fmtUsd(st.netPnl)}</td>` +
      `<td class="pd-muted-td" style="text-align:right">${pf}</td>` +
      `<td class="pd-muted-td" style="text-align:right">${st.avgCoef != null ? st.avgCoef.toFixed(2) : '—'}</td></tr>`;
  };
  return `<div class="pd-card" style="border-color:#2e4a5a"><h2>Бумага ↔ Реал — сходимость исполнения</h2>` +
    `<table class="pd-table"><thead><tr><th></th><th style="text-align:right">Сделок</th><th style="text-align:right">Win</th><th style="text-align:right">PnL</th><th style="text-align:right">PF</th><th style="text-align:right">Ср.коэф</th></tr></thead><tbody>` +
    row('🟡 Бумага (shadow)', sh) +
    row('🔴 Реал', re) +
    `</tbody></table>` +
    `<div class="pd-foot">Одна стратегия и один сигнал — расхождение = разница ИСПОЛНЕНИЯ (реал наливается по факту стакана, бумага — по котировке). С лимитными ордерами ($5, с 2026-06-23) должны сходиться; статистика сброшена для чистого замера.</div></div>`;
}

function renderStrategy(s: StrategyDef, page = 1, opControl = ''): string {
  const st = readStatus(s);
  const back = `<a class="pd-back" href="/predict">← все стратегии</a>`;
  const descCard = `<div class="pd-card"><h2>Как работает</h2><div class="pd-desc">${s.description.map((p) => `<p>${esc(p)}</p>`).join('')}</div></div>`;
  const retiredBanner = s.retired
    ? `<div class="pd-retired-banner">⏹ Стратегия остановлена — гипотеза не подтвердилась. ` +
      `На выборке оказался отрицательный перевес (угадывание стороны хуже подброса монеты), поэтому торговля прекращена. ` +
      `Итоговые цифры ниже заморожены и оставлены честно, как есть.</div>`
    : '';

  if (!st) {
    return (
      STYLES +
      `<div class="pd-wrap">${back}<div class="pd-head"><h1>${esc(s.title)}</h1></div>` +
      `<p class="pd-sub">${esc(s.tagline)}</p>${descCard}` +
      `<div class="pd-empty">Данные ещё не публикуются — стратегия на ранней фазе.</div>${PAPER_NOTE}</div>`
    );
  }

  const header =
    `<div class="pd-head"><h1>${esc(s.title)}</h1>` +
    (st.phase ? `<span class="pd-badge">Фаза ${st.phase.number} · ${esc(st.phase.label)}</span>` : '') +
    freshnessPill(st.updatedAt) +
    `</div>`;

  // Раньше тут был ранний return для rounds===0 (куцая заглушка без кнопки оператора/банка/объяснения).
  // Убран: основной рендер ниже NaN-безопасен при 0 раундов (pf='—', график→«недостаточно данных»,
  // пустая таблица) и показывает полный вид + баннер «движок работает, ждёт подходящий раунд».
  const pf = st.profitFactor === null ? '—' : st.profitFactor.toFixed(2);
  const updated = new Date(st.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' });
  const netAccent = st.netPnl > 0 ? 'pos' : st.netPnl < 0 ? 'neg' : 'muted';
  // Ключевые метрики для money-management: просадка, серии подряд, средний коэф.
  const ddPctVal = (st as { maxDrawdownPct?: number }).maxDrawdownPct; // у компаунд-стратегий (Кейли) $-просадка несопоставима — показываем и %
  const ddCard = statCard('Max drawdown', `$${st.maxDrawdown.toFixed(2)}${ddPctVal != null ? ` (${ddPctVal}%)` : ''}`, 'muted');
  const lossStreakCard = st.maxLossStreak != null ? statCard('Макс. серия −', String(st.maxLossStreak), 'muted') : '';
  const winStreakCard = st.maxWinStreak != null ? statCard('Макс. серия +', String(st.maxWinStreak), 'muted') : '';
  const coefCard = st.avgCoef != null ? statCard('Ср. коэф.', st.avgCoef.toFixed(2), 'muted') : '';
  const stakeCard = st.avgStake != null ? statCard('Ср. ставка', `$${st.avgStake.toFixed(2)}`, 'muted') : '';
  const bankCard =
    st.bank != null
      ? statCard(
          'Баланс',
          `$${st.bank.toFixed(2)}`,
          st.bank0 != null ? (st.bank > st.bank0 ? 'pos' : st.bank < st.bank0 ? 'neg' : 'muted') : 'muted',
        )
      : '';

  // Винрейт по диапазонам коэффициента входа — видно, на каких коэф модель реально угадывает.
  const coefBucketsCard = (st.coefBuckets && st.coefBuckets.some((b) => b.n > 0))
    ? `<div class="pd-card"><h2>Винрейт по коэффициентам</h2>` +
      `<table class="pd-table"><thead><tr><th>Коэф.</th><th style="text-align:right">Сделок</th><th style="text-align:right">Винрейт</th><th style="text-align:right">Безубыток</th></tr></thead><tbody>` +
      st.coefBuckets
        .map((b) => {
          const edge = b.winRate != null && b.breakeven != null ? b.winRate - b.breakeven : null;
          const cls = b.n === 0 || edge == null ? 'pd-muted-td' : edge > 0 ? 'pd-pos' : 'pd-neg';
          return (
            `<tr><td>${esc(b.range)}</td>` +
            `<td class="pd-muted-td" style="text-align:right">${b.n}</td>` +
            `<td class="${cls}" style="text-align:right">${b.winRate != null ? b.winRate + '%' : '—'}</td>` +
            `<td class="pd-muted-td" style="text-align:right">${b.breakeven != null ? b.breakeven + '%' : '—'}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table><div class="pd-foot">Зелёный = винрейт выше безубытка (на этом коэффициенте есть край), красный = ниже. Безубыток ≈ средняя цена входа в диапазоне.</div></div>`
    : '';

  // Пагинация таблицы раундов: 20 на страницу, новые первыми.
  const PAGE_SIZE = 20;
  const allRounds = st.recentRounds ?? [];
  const totalPages = Math.max(1, Math.ceil(allRounds.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const pageRounds = allRounds.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const roundsTable = recentRoundsTable(pageRounds, {
    title: `Раунды (${allRounds.length})`,
    page: p,
    totalPages,
    baseHref: `/predict/${s.slug}`,
    isTrap: s.isTrap,
  });
  // Для мейкинга — счётчик «обе стороны / одна сторона» (ключ к пониманию статистики).
  const trapCard =
    s.isTrap && st.trapClosed != null
      ? statCard('Замков / одна нога', `${st.trapClosed} / ${st.oneLegged ?? 0}`, 'muted')
      : '';

  return (
    STYLES +
    `<div class="pd-wrap">${back}${header}<p class="pd-sub">${esc(s.tagline)}</p>` +
    retiredBanner +
    (s.standalone && s.realEligible === true
      ? `<div class="pd-card" style="border:2px solid #d83a3a;background:rgba(216,58,58,0.07)">` +
        `<h2 style="color:#ff6b6b;margin-top:0">🔴 Идёт мини-тест на РЕАЛЬНЫЕ ДЕНЬГИ</h2>` +
        `<p class="pd-sub" style="margin:0 0 12px">Эта страница — <b>бумажная (shadow)</b> статистика. Параллельно идёт боевой мини-тест на реальный депозит с жёсткими капами (ставка $1 · авто-стоп −$8) и шлюзом ликвидности (вход только если стакан реально наливает ставку). Его отдельная статистика — на красной странице ниже.</p>` +
        `<a class="pd-back" style="font-size:15px;background:#3a1518;border:1px solid #d83a3a;color:#ff8a8a;padding:9px 16px;border-radius:8px;text-decoration:none" href="/predict/${esc(s.slug)}real">🔴 Реальная торговля — статистика →</a>` +
        `</div>`
      : '') +
    (s.recommendedReal
      ? `<div class="pd-card" style="border-color:#3a5a2e"><h2>💰 Рекомендуемый банк для реала: $${s.recommendedReal}</h2>` +
        `<p class="pd-sub" style="margin:0">${esc(s.recommendedRealNote ?? '')}. Это сумма, которую нужно положить на кошелёк перед включением реала; авто-стоп ограничивает убыток.</p></div>`
      : '') +
    (st.modelOnline
      ? `<div class="pd-card" style="border-color:#2e5a4a"><h2>🧠 Модель учится непрерывно</h2>` +
        `<p class="pd-sub" style="margin:0">Сейчас обучена на <b>${st.modelTrainN ?? '?'}</b> сыгранных раундах` +
        (st.modelTrainedAt ? ` · обновлена ${esc(new Date(st.modelTrainedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }))} МСК` : '') +
        `. Дообучается каждые 30 мин на всех завершённых раундах, ставит только на новые (walk-forward — без заглядывания в будущее). Чем больше число — тем меньше переобучение.</p></div>`
      : '') +
    (s.standalone && st.rounds === 0
      ? `<div class="pd-card" style="border-color:#3a4a5e"><h2>ℹ️ Движок работает — ждёт подходящий раунд</h2>` +
        `<p class="pd-sub" style="margin:0">Сделок пока <b>0</b>, и это НЕ поломка. Движок живой и уже перебрал <b>${st.evaluated ?? 0}</b> раундов, но ни один не попал под условие входа этой стратегии: фильтр срабатывает не каждый раунд (узкая полоса расхождения модель↔рынок ловит сигнал реже — модель часто расходится сильнее, чем диапазон полосы). Первая сделка появится, как только расхождение попадёт в нужный диапазон. Статус обновляется каждую секунду.</p></div>`
      : '') +
    opControl +
    (s.hasLive ? livePanel(s) : '') +
    descCard +
    `<div class="pd-grid">` +
    statCard('Раундов', String(st.rounds)) +
    statCard('Win rate', `${st.winRate}%`) +
    statCard('Profit factor', pf) +
    statCard('Net PnL', fmtUsd(st.netPnl), netAccent) +
    ddCard +
    lossStreakCard +
    winStreakCard +
    coefCard +
    stakeCard +
    bankCard +
    trapCard +
    statCard('Режим', st.mode === 'paper' ? 'Paper' : esc(st.mode), 'muted') +
    `</div>` +
    `<div class="pd-card"><h2>Кривая накопленного PnL</h2>${equitySvg(st.equityCurve ?? equityFromRounds(allRounds, s.slug))}` +
    `<div class="pd-foot">Выигрышей: ${st.wins} · Проигрышей: ${st.losses}` +
    (s.isTrap && st.trapClosed != null ? ` · 🔒 замков: ${st.trapClosed} · одна нога: ${st.oneLegged ?? 0}` : '') +
    (st.marketOutcomes ? ` · Исходы рынка ↑${st.marketOutcomes.up}/↓${st.marketOutcomes.down}` : '') +
    `</div></div>` +
    coefBucketsCard +
    renderCompareBlock(s) +
    edgeSparkline(allRounds) +
    roundsTable +
    (s.lossPatternFile ? lossPatternCard(s.lossPatternFile) : '') +
    PAPER_NOTE +
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC</p>` +
    `</div>`
  );
}

// Страница «доступ только через поддержку» — для незалогиненных и для
// залогиненных без выданного доступа. Раздел виден, но закрыт.
// Гейт ТОЛЬКО для реальной торговли (дашборд /predict открыт всем).
function renderNoAccess(authed: boolean): string {
  const support = 'https://t.me/dboykod';
  const cta = authed
    ? `<p class="pd-sub">Ваш аккаунт авторизован, но доступ к <b>реальной торговле</b> ещё не выдан. Он открывается <b>вручную через поддержку</b> после короткого знакомства.</p>`
    : `<p class="pd-sub">Реальная торговля доступна зарегистрированным пользователям с выданным доступом. Сначала войдите, затем запросите доступ <b>через поддержку</b>.</p>`;
  return (
    STYLES +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>Реальная торговля</h1><span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>доступ по запросу</span></div>` +
    `<div class="pd-card">` +
    `<h2>🔒 Реальная торговля — по запросу</h2>` +
    cta +
    `<p class="pd-sub" style="margin-bottom:6px">Почему так:</p>` +
    `<ul class="pd-desc" style="margin:0 0 14px; padding-left:20px; line-height:1.7">` +
    `<li>Здесь подключается ВАШ кошелёк и идут сделки на РЕАЛЬНЫЕ деньги — поэтому доступ выдаём индивидуально.</li>` +
    `<li>Сам дашборд со всей живой статистикой стратегий <b>открыт всем</b> — смотрите без доступа.</li>` +
    `<li>Реальную торговлю стоит включать только после того, как стратегия подтвердит устойчивый плюс на бумаге.</li>` +
    `</ul>` +
    `<p style="margin-top:14px"><a class="pd-back" style="font-size:15px;background:#16321f;border:1px solid #2e5a3a;padding:9px 16px;border-radius:8px" href="/predict">📊 Открыть дашборд (бесплатно)</a></p>` +
    `<p style="margin-top:10px"><a class="pd-back" style="font-size:15px" href="${support}">→ Запросить доступ к реальной торговле</a></p>` +
    (authed ? '' : `<p style="margin-top:8px"><a class="pd-back" href="/strategies?login=1&next=/predict">→ Войти / зарегистрироваться</a></p>`) +
    `</div></div>`
  );
}

// Баннер для пользователей С доступом — ведёт на страницу реальной торговли.
const REAL_TRADING_NOTE =
  `<div class="pd-card" style="border-color:#2e5a3a">` +
  `<h2>🔴 Реальная торговля — LIVE</h2>` +
  `<p class="pd-sub">Стратегия LagEdge торгует реальными деньгами малым кэпом — каждый движок со своим жёстким авто-стопом. Актуальный состав армленных движков — на главной /predict. Управление (Стоп/Старт) — на странице каждой стратегии.</p>` +
  `<p style="margin-top:12px"><a class="pd-back" style="font-size:15px" href="/predict/real">→ Настройка реальной торговли</a></p>` +
  `</div>`;

// ── Конфиг реальной торговли (оператор-онли). data/predict-real-config.json —
// БЕЗ приватного ключа (только slug, публичный funder, маска ключа). Сам ключ —
// в data/predict-real.key (chmod 600, в .gitignore через data/, не отдаётся роутами).
type RealConfig = {
  stakes: Record<string, number>; // фикс. ставка на сделку по каждой стратегии (slug → USD)
  funderAddress: string | null; // публичный адрес funder/proxy (НЕ ключ)
  keyMask: string | null; // «••••1234» — последние 4 символа сохранённого ключа
  keySavedAt: string | null;
  builderMask?: string | null; // маска relayer/builder API-ключа (key/secret/passphrase сохранены)
  builderSavedAt?: string | null;
  updatedAt: string | null;
};
const REAL_CONFIG_FILE = join(dataDir, 'predict-real-config.json');
const REAL_KEY_FILE = join(dataDir, 'predict-real.key');
// Relayer/builder API-креды Polymarket (BUILDER_KEY/SECRET/PASSPHRASE) — движок
// требует их для боевого режима. Храним в защищённом env-файле (chmod 600),
// который systemd-юнит боевого движка подхватывает через EnvironmentFile.
const REAL_BUILDER_ENV_FILE = join(dataDir, 'predict-real-builder.env');
function readRealConfig(): RealConfig {
  try {
    if (existsSync(REAL_CONFIG_FILE)) return JSON.parse(readFileSync(REAL_CONFIG_FILE, 'utf8')) as RealConfig;
  } catch {
    /* битый файл — дефолт */
  }
  return { stakes: {}, funderAddress: null, keyMask: null, keySavedAt: null, updatedAt: null };
}
function writeRealConfig(cfg: RealConfig): void {
  writeFileSync(REAL_CONFIG_FILE, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2));
}
// Желаемое состояние боевых стратегий (кнопки Запустить/Остановить пишут сюда,
// супервайзер-сервис читает и поднимает/гасит реальные движки). Веб НЕ трогает
// ни systemd, ни ключ — только этот файл намерений.
type RealControl = { running: Record<string, { since: string }> };
const REAL_CONTROL_FILE = join(dataDir, 'predict-real-control.json');
function readRealControl(): RealControl {
  try {
    if (existsSync(REAL_CONTROL_FILE)) return JSON.parse(readFileSync(REAL_CONTROL_FILE, 'utf8')) as RealControl;
  } catch {
    /* дефолт */
  }
  return { running: {} };
}
function writeRealControl(c: RealControl): void {
  writeFileSync(REAL_CONTROL_FILE, JSON.stringify(c, null, 2));
}
// Карта живых боевых сессий (несколько одновременно) — пишет супервайзер.
type RealSession = {
  state: string; fills: number; pnl: number; bank?: number;
  since?: string | null; reason?: string | null; lastTrade?: string | null;
};
type RealSessions = {
  updatedAt?: string; deposit?: number; perShare?: number; activeCount?: number;
  sessions: Record<string, RealSession>;
};
const REAL_SESSIONS_FILE = join(dataDir, 'predict-real-sessions.json');
function readRealSessions(): RealSessions {
  try {
    if (existsSync(REAL_SESSIONS_FILE)) {
      const j = JSON.parse(readFileSync(REAL_SESSIONS_FILE, 'utf8')) as RealSessions;
      if (j && typeof j === 'object') return { ...j, sessions: j.sessions ?? {} };
    }
  } catch {
    /* нет данных */
  }
  return { sessions: {} };
}
/** Личная (боевая) статистика стратегии — пишется боевым инстансом, если запущен. */
function readRealStatus(slug: string): PredictStatus | null {
  // Два контура: Kelly-сессии пишут predict-real-<slug>-status.json; standalone-боевой движок m15live
  // (h5m8real) пишет predict-<slug>real-status.json. Пробуем оба, чтобы обзор видел реал-PnL/капы обоих.
  for (const name of [`predict-real-${slug}-status.json`, `predict-${slug}real-status.json`]) {
    try {
      const p = join(dataDir, name);
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as PredictStatus;
    } catch {
      /* нет данных — пробуем следующий */
    }
  }
  return null;
}
/** Открытая боевая позиция стратегии (live) — пишет движок в PREDICT_LIVE_PATH. */
type RealLive = { position?: { side?: string; stake?: number; entryCoef?: number }; slotEndMs?: number };
function readRealLive(slug: string): RealLive | null {
  try {
    const p = join(dataDir, `predict-real-${slug}-live.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as RealLive;
  } catch {
    /* нет открытой позиции */
  }
  return null;
}

// Баланс боевого депозит-кошелька (USDC) — серверный fetch к локальному движку.
// Только ЧТЕНИЕ: движок отдаёт {ok,usdc}. Падение/таймаут → null (страница покажет «—»).
const REAL_BALANCE_URL = process.env.PREDICT_BALANCE_URL ?? 'http://127.0.0.1:8731/balance';
async function fetchRealBalance(): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    let usdc: number | null = null;
    try {
      const r = await fetch(REAL_BALANCE_URL, { signal: ctrl.signal });
      if (r.ok) {
        const j = (await r.json()) as { ok?: boolean; usdc?: number };
        if (j && j.ok && typeof j.usdc === 'number' && Number.isFinite(j.usdc)) usdc = j.usdc;
      }
    } finally {
      clearTimeout(timer);
    }
    return usdc;
  } catch {
    return null; // сеть недоступна / таймаут — graceful «—»
  }
}

/** Сохранить приватный ключ в защищённый файл (chmod 600). Возвращает маску. */
function saveRealKey(rawKey: string): string {
  const key = rawKey.trim();
  writeFileSync(REAL_KEY_FILE, key, { mode: 0o600 });
  try {
    chmodSync(REAL_KEY_FILE, 0o600);
  } catch {
    /* best-effort на системах без chmod */
  }
  const tail = key.replace(/^0x/, '').slice(-4);
  return `••••${tail}`;
}

/** Сохранить торговый API-ключ аккаунта (раздел «Разработчики» Polymarket) в
 * защищённый env-файл (chmod 600). Пишем POLY_API_* — движок берёт их как L2-креды. */
function saveBuilderCreds(key: string, secret: string, passphrase: string): string {
  const body = `POLY_API_KEY=${key.trim()}\nPOLY_API_SECRET=${secret.trim()}\nPOLY_API_PASSPHRASE=${passphrase.trim()}\n`;
  writeFileSync(REAL_BUILDER_ENV_FILE, body, { mode: 0o600 });
  try {
    chmodSync(REAL_BUILDER_ENV_FILE, 0o600);
  } catch {
    /* best-effort */
  }
  return `••••${key.trim().slice(-4)}`;
}

// Стратегии, доступные для реальной торговли (есть engine + не отключены).
function realEligibleStrategies(): StrategyDef[] {
  return STRATEGIES.filter((s) => s.engine && s.realEligible !== false);
}

// Комфортный минимальный банк под стратегию, чтобы Kelly-ставка не упиралась в пол.
// Бот ставит РЫНОЧНЫЕ ордера → минимум Polymarket = $1 (а не 5 акций). Kelly = ¼·f·банк
// чистит $1 при банке ≥ 4/f: сильный край ~$13, слабый ~$23. $15 — комфортно для большинства.
const MIN_DEPOSIT_BY_SLUG: Record<string, number> = {
  eglate: 15, egedge: 15, egcombo: 15, egcal: 15, egprog: 15,
};
function minDepositOf(s: StrategyDef): number {
  return s.minDeposit ?? MIN_DEPOSIT_BY_SLUG[s.slug] ?? 15;
}

// Рекомендуемый бюджет, при котором Kelly-ставка не падает ниже $1-минимума (рыночный ордер)
// даже на слабом крае: ¼·f·банк ≥ $1 при банке ≥ ~$23 (слабый) / ~$13 (сильный). $30 — с запасом.
// Выше — крупнее ставки и заметнее компаундинг, но жёсткой необходимости нет.
const RECOMMENDED_BUDGET = 30;

// Журнал изменений раздела — хронология, что и зачем меняли (новые сверху).
type ChangeEntry = { date: string; title: string; items: string[] };
const CHANGELOG: ChangeEntry[] = [
  {
    date: '2026-06-13',
    title: 'Расчистка: оставлен единственный верифицированный край (PMOPT)',
    items: [
      'Остановлены и удалены все стратегии/сканеры без доказанного края: DYNPROB (вердикт KILL, юнит −$39 на 311 раундах) и его технический фид egtwo, NRSCAN (0 зачётных за 369 сканов), PMKX и PMLX (нулевая исполнимая прибыль после комиссий). Данные сохранены в архив как датасеты.',
      'Остаётся PMOPT — единственная гипотеза, прошедшая офлайн-бэктест (favorite-longshot bias на крипто-страйках: фейд глубоких лонгшотов +4.6пп, кластерный CI [3.3,5.8], робастно по обоим направлениям и BTC/ETH/SOL). Идёт форвард-подтверждение на живых рынках. Реальных денег нет.',
    ],
  },
  {
    date: '2026-06-12',
    title: 'Карточка «DYNPROB · фикс $5» — контроль без Келли',
    items: [
      'По запросу оператора добавлен контрольный двойник DYNPROB: те же входы (расхождение ≥5пп на T−60) и те же сделки, но фиксированная ставка $5 вместо ¼-Келли. Чистое сравнение манименеджмента на идентичной серии: сайзинг не меняет знак результата, только форму кривой (просадки/волатильность).',
    ],
  },
  {
    date: '2026-06-11',
    title: 'egtwo закрыт досрочно; DYNPROB переведён на ¼-Келли с юнит-контролем',
    items: [
      'egtwo (Коэф-2 · мейкер-тест) закрыт досрочно — вердикт по темпу: за время теста налилось всего 9 филов, набрать 150 независимых раундов к дедлайну 10.07 недостижимо. Вывод: пассивный мейкер-лаг на 5-минутных рынках не ловится — лимитки по best bid почти не наливаются. Карточка снята с дашборда; сам движок остаётся работать как технический фид котировок и резолюций для DYNPROB.',
      'Карточка DYNPROB теперь показывает ¼-Келли-трек от банка $100 (ставка = min(max($1, ¼·f·банк), 10% банка), банк пересобирается хронологически при каждом расчёте) — так виден эффект сайзинга. Параллельный юнит-трек $1 сохранён и остаётся ГЛАВНЫМ для валидации: планка к микро-реалу — юнит-плюс после комиссий на 150+ независимых раундах в обеих половинах выборки.',
    ],
  },
  {
    date: '2026-06-11',
    title: 'DYNPROB вышел в форвард: живой логгер расхождений + бумажные сделки на сайте',
    items: [
      'Сигнал DYNPROB — единственный, прошедший Фазу 0 и контроль скептика, — переведён в форвард-проверку: на сервере живой логгер на каждом раунде в T−60 фиксирует P(UP) модели против цены рынка, а бумажный движок по зафиксированным правилам (расхождение ≥5пп → сторона модели, фикс $1, тейкер-учёт с комиссиями 3%/1.5%, справочный мейкер-вариант) публикует сделки в новую карточку на дашборде.',
      'Правила и планка зафиксированы ДО старта: любой разговор о реале — только после плюса ПОСЛЕ комиссий на 150+ независимых форвард-раундах в обеих половинах выборки. Оговорки честно в карточке: лонгшот-профиль и статистическая незначимость офлайн-результата (t≈1.8). Реальных денег нет.',
    ],
  },
  {
    date: '2026-06-11',
    title: 'Дашборд очищен: остался решающий тест + исследования Фазы 0',
    items: [
      'Удалены все неактивные стратегии (eglate, egcal, udk, мартингейлы 8/3) — их гипотезы статистически закрыты в минус, финальные цифры в журнале. На дашборде остался единственный живой эксперимент: Коэф-2 · мейкер-тест (дедлайн 10 июля).',
      'Добавлена секция «Исследования — Фаза 0»: NRSCAN (сканер перекосов NegRisk-событий, 3 недели наблюдения) и DYNPROB (динамическая вероятность из индикаторов против цены рынка, офлайн-бэктест). Оба — сбор данных без ставок, критерии зафиксированы заранее.',
    ],
  },
  {
    date: '2026-06-11',
    title: 'Большой аудит: остановлен балласт, починен фид, закрыта дыра замка, новая глава',
    items: [
      'Polymarket ~8.06 сменил формат ценового потока — движки слепли при рестарте. Найдено и починено на всех инстансах + поставлен вотчдог (авторестарт при мёртвом фиде).',
      'По аудиту остановлены 5 стратегий со статистически закрытыми гипотезами: eglate (51% vs нужно 62%), udk (края андердога нет), mart/mart3 (мартингейл подтвердил разорительность эмпирикой), egcal (0 входов за 719 раундов). Карточки сохранены с финальными итогами. Остался единственный живой эксперимент — мейкер-тест Коэф-2.',
      'Закрыта критичная дыра: супервайзер реала не взводил PROD-замок стратегий (мартингейл теоретически мог попасть в реал). Теперь PROD=true передаётся всегда — предохранители работают.',
      'Новая глава по итогам научного поиска: документированный край живёт на ДЛИННЫХ событийных рынках (недооценка фаворитов, slope 1.3–1.8 на 292 млн сделок). Стартовала Фаза 0 — холодный бэктест калибровки длинных фаворитов (без денег) + подготовка логгера NegRisk-перекосов.',
    ],
  },
  {
    date: '2026-06-08',
    title: 'Удалены минусовые паузнутые стратегии (egprog, egedge, egcombo)',
    items: [
      'Убрали три endgame-стратегии, стоявшие на паузе и в минусе/без перспективы (egprog −$22, egedge −$15, egcombo — 2 сделки). Дашборд очищен от балласта; остались только живые: udk, egtwo (мейкер-тест), egcal, eglate + мартингейлы 8/3.',
    ],
  },
  {
    date: '2026-06-08',
    title: 'Удалены варианты мартингейла 4/5/6 шагов',
    items: [
      'Убрали mart4, mart5, mart6 (по запросу) — оставили ряд 3/7/8 шагов как достаточный для сравнения длины прогрессии. Заодно освободились слоты биржевых фидов (меньше движков — стабильнее остальные стратегии).',
    ],
  },
  {
    date: '2026-06-08',
    title: 'Полный A/B-ряд мартингейла: 3,4,5,6,7,8 шагов Фибоначчи',
    items: [
      'Добавлены варианты 5 [1,1,2,3,5], 6 [1,1,2,3,5,8] и 7 [1,1,2,3,5,8,13] шагов — теперь на дашборде полный ряд из 6 длин прогрессии (3/4/5/6/7/8). Все с общим ядром: андердог коэф 3, окно входа 60–180с, стоп-серия на 10.',
      'Цель — полноценно сравнить, какая длина прогрессии Фибоначчи даёт лучший баланс между отыгрышем серии и просадкой. Все только бумага, в реал не допускаются.',
    ],
  },
  {
    date: '2026-06-08',
    title: 'Два варианта мартингейла с короткой Фибоначчи (4 и 3 шага)',
    items: [
      'По запросу — две копии улучшенного мартингейла с укороченной прогрессией: «Мартингейл-4 шага» [1,1,2,3] и «Мартингейл-3 шага» [1,1,2]. После исчерпания шагов ставка сбрасывается к базе $1 и серия начинается заново.',
      'Цель — A/B-сравнение длины прогрессии: короче прогрессия = меньше разгон ставки и просадка, но слабее отыгрыш серии. Все три (8/4/3 шага) имеют общую базу: вход на андердога коэф 3, окно входа 60–180с, стоп-серия на 10. Только бумага, в реал не допускаются.',
    ],
  },
  {
    date: '2026-06-08',
    title: 'Мартингейл-Фибоначчи: исправлен по данным + выведен на дашборд',
    items: [
      'Разбор 559 сделок показал: исход определяется временем входа. В окне 60–180с до закрытия андердог выигрывает ~40% (плюс), а при входе раньше 180с — лишь 26% (минус). Старая версия входила слишком рано — отсюда минус. Теперь вход только в окне 60–180с.',
      'Добавлена стоп-серия: после 10 проигрышей подряд — пауза 1 час и сброс ставки к базе (раньше серии доходили до 19). Защита от разгона ставки.',
      'Стратегия выведена на дашборд /predict как эксперимент (только бумага, в реал не допускается — мартингейл разорителен по Монте-Карло). Копит чистую форвард-статистику.',
    ],
  },
  {
    date: '2026-06-08',
    title: 'Новая стратегия «Коэф-2» — вход только на коэффициенте ~2.0 (по данным)',
    items: [
      'Разобрали 1640 наших сделок по цене входа. Нашли резкий край ровно на коэф ~2.0: цена 0.50–0.525 → винрейт 80% при безубытке 51% (+29 пунктов, +$179). На фаворитах (цена 0.80+) — стабильный минус (фаворит-парадокс: высокий винрейт не покрывает высокую цену). Край держится по 5 разным стратегиям — не случайность одной.',
      'Смысл: у дедлайна малый перевес обычно удерживается, а рынок осторожно держит цену у 0.50 — этот разрыв и есть край. Создали стратегию, которая входит ТОЛЬКО в зоне цены 0.45–0.54 с направленным перевесом, консервативные деньги (⅛-Kelly, потолок 10% банка).',
      'Запустили в бумаге на форвард-валидацию. В реал — только после подтверждения: винрейт ≥70% на коэф ≥1.9 на 150+ форвард-сделках. Честно держим планку, чтобы не рисковать реальными деньгами на малой выборке.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'egcal: убрали сессию (24/7) + ослабили жёсткие пороги',
    items: [
      'Стратегия egcal стояла и не торговала: сессионный фильтр (00–13 UTC) блокировал её всю US-сессию, а в разрешённые часы жёсткие пороги (цена≤0.65 + z≥1.5) почти никогда не совпадали.',
      'Убрали сессионный фильтр — egcal работает 24/7. Ослабили ручные пороги (z≥1.0, цена до 0.80), потому что главный фильтр края у egcal — это сам откалиброванный EV-гейт (он отсекает дорогую зону точнее любого ручного порога). Так стратегия начнёт реально входить, сохранив калибровку как источник края.',
      'Сбросили её статистику — копит заново под новой логикой.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Рыночные ордера ($1 минимум) + бумага на $100',
    items: [
      'Главное: бот переведён на РЫНОЧНЫЕ ордера. Раньше мост ставил лимитные (минимум 5 акций ~$3 — поэтому мелкие заявки отклонялись). Теперь рыночные, минимум Polymarket — $1 (как ручные ставки в интерфейсе). Реал теперь работает и с маленьким депозитом.',
      'Пересчитали рекомендацию бюджета: жёсткого $200 больше нет. Kelly не упирается в $1-минимум при банке ~$13 (сильный край) — ~$23 (слабый). Рекомендуемый бюджет снижен до $30, комфортный минимум — $15. Выше — крупнее ставки, но не обязательно.',
      'Бумажным стратегиям выставили стартовый банк $100 и сбросили статистику — копят заново под рыночными ордерами и калибровкой.',
      'Размен рыночного ордера: исполняется по лучшей доступной цене (возможно проскальзывание пары центов), но у нас в гейте запас 10 центов — край не страдает.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Правильная изоляция мультистратегии в реале — ограничение снято',
    items: [
      'Сделали корректную изоляцию: каждая реальная стратегия теперь работает в своей рабочей папке (sessions/<стратегия>/). Код грузится из общей папки, но логи резолюции, прогресс и состояние пишутся в отдельную папку каждой стратегии. Проверено в sim-режиме.',
      'Теперь несколько стратегий на одном кошельке НЕ путают статистику — учёт, Kelly и тормоза считаются по своим сделкам. Ограничение «по одной за раз» снято: можно запускать несколько реальных стратегий безопасно.',
      'Плюс мелочь из аудита: прогресс-состояние стратегий тоже пишется атомарно (temp+rename).',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Повторный аудит: откат хрупкого фикса, возврат к надёжному',
    items: [
      'Повторный аудит выявил, что вчерашний способ изоляции лога резолюции (тег в имени файла) — хрупкий: ядро движка тег не читает, и путь записи/чтения легко рассинхронизировался бы, сломав учёт в реале. Откатили к простому надёжному пути.',
      'Тормоза по просадке вернули к расчёту по реализованному PnL (вычитание открытой ставки давало ложные срабатывания). Добавили проверку свежести live-снимка, чтобы зависший файл не блокировал пересчёт банка.',
      'Известное ограничение: в РЕАЛЕ пока запускайте по ОДНОЙ стратегии за раз — при нескольких на одном кошельке статистика может перепутаться (на деньги не влияет, только на учёт). Правильную изоляцию нескольких реал-стратегий сделаем отдельным шагом.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Полировка по аудиту: тормоза, приор Kelly, надёжность записи',
    items: [
      'Тормоза по просадке теперь учитывают ОТКРЫТУЮ (ещё не закрытую) ставку как риск — раньше они «видели» убыток только после закрытия раунда, теперь реагируют на риск в полёте.',
      'При пересчёте банка (когда добавляешь/убираешь стратегию) больше не рвём стратегию с открытой позицией — ждём её закрытия, чтобы не потерять учёт ставки.',
      'Приор вероятности Kelly снижен с 0.74 до 0.70 — консервативнее на первых 20 сделках (ближе к откалиброванной реальности, меньше риск переставки на старте).',
      'Размер позиции теперь считается по фактически исполненным акциям (а не запрошенным) — точнее при частичном исполнении.',
      'Все статусные JSON пишутся атомарно (temp+rename) — сайт никогда не прочитает наполовину записанный файл.',
      'Пропуск незарезолвленной сделки теперь логируется (раньше «молча забывали»).',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Реал без жёсткого минимума депозита + явная вероятность в расчёте ставки',
    items: [
      'Убрали жёсткий минимум депозита в реальной торговле: стратегия теперь работает при ЛЮБОМ депозите. При малом банке она сама пропускает входы, которые не может оплатить (минимум заявки Polymarket — 5 акций), а не блокируется целиком. Ниже рекомендуемого бюджета — просто предупреждаем (нужно ~$200 для нормального роста по Kelly), но не мешаем торговать.',
      'В основании каждой ставки сделали ВЕРОЯТНОСТЬ явной: было «винрейт W%», стало «вероятность W% (наш винрейт)». Плюс добавили цену входа и саму формулу Kelly: f = p−(1−p)/b. Теперь видно всё, что участвует в расчёте: вероятность, цена/коэф, дробь Kelly f, банк, и итоговая/фактическая ставка.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Аудит кода: исправили 2 бага реальной торговли',
    items: [
      'Провели аудит торгового кода. Нашли и исправили две проблемы, важные для реальной торговли (на бумаге не влияли).',
      'Баг учёта PnL при нескольких реал-стратегиях: они делили один файл резолюции на кошельке → PnL мог приписаться чужой стратегии. Изолировали файл по сессии — теперь учёт, Kelly и тормоза считаются по своим сделкам.',
      'Минимум заявки Polymarket (5 акций) не соблюдался: реал-заявки на 2-3 акции отклонялись биржей. Добавили минимум 5 акций в реал-режиме (с проверкой, что это в пределах риск-лимита 30% банка).',
      'Остальные находки аудита (мелкие, не критичные) — в плане на доработку.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Калибровка вероятности на ВСЕХ стратегиях + чистый перезапуск',
    items: [
      'Применили откалиброванную по нашим данным вероятность (вместо самоуверенной модели Φ(z)) ко всем стратегиям: eglate, egedge, egcombo, egprog (egcal уже была). Теперь гейт входа везде считает EV по реальной вероятности (~78%, а не мнимым 95%) и сам отсекает дорогие убыточные входы.',
      'Так как калибровка меняет отбор входов, старая статистика под прежней моделью стала несравнима. Сбросили статистику всех бумажных стратегий — копят заново под честной вероятностью, чтобы сравнение было чистым. (Это бумага, не реальные деньги; накопленные данные уже дали нам кривую калибровки.)',
      'Уточнение по бюджету: минимум для ЗАПУСКА стратегии в реале — $20 (ниже стратегия ждёт пополнения). $200 — это РЕКОМЕНДУЕМЫЙ бюджет для роста (где Kelly начинает компаундировать), а не обязательный минимум. Реал работает и с $20, просто доход капается малыми суммами.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Инфраструктурный этап: оракул, мульти-CEX консенсус, портфельная защита',
    items: [
      'Проверили идею «считать от настоящей цены расчёта (Chainlink)»: оказалось, движок УЖЕ подписан на Chainlink-оракул и использует именно его как основную цену — то есть мы уже измеряем перевес от правильной цены. Подтверждено в коде.',
      'Добавили в egcal мульти-CEX консенсус: вход только если Binance И Coinbase согласны, какая сторона ведёт. Если биржи расходятся (вик/дислокация одной площадки) — пропуск. Плюс killswitch: при расхождении бирж >$50 рынок считается сломанным.',
      'Добавили портфельную защиту в супервайзер: наши стратегии коррелированы (ставят на один 5-мин исход), поэтому при ≥2 активных просадки складываются — если суммарная просадка достигла −20% общего банка, аварийный стоп ВСЕХ (ловит коррелированный слив раньше индивидуального −30%).',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Новая флагманская стратегия egcal + все улучшения из исследования',
    items: [
      'Провели большое исследование идей (20+ агентов, веб-поиск, адверсариальная проверка). Из 32 идей отобрали реализуемые на наших данных без новой инфраструктуры.',
      'Главное открытие: разбор 407 наших сделок (z → реальный исход) показал, что модель вероятности Φ(z) переоценивает себя на 14–33 процентных пункта (при z≥1.5 говорит 92–100%, по факту винрейт ~78%). Из-за этого фильтр входа пускал в дорогие убыточные сделки.',
      'Собрали флагман egcal со всеми улучшениями: (1) откалиброванная по нашим данным вероятность вместо самоуверенной формулы; (2) фильтры комбо (цена≤0.65, z≥1.5, сессия, f>0); (3) vol-режим (торгуем только в средней полосе волатильности); (4) антизапаздывание (не входим, если стакан уже переоценился). Запущена на бумаге.',
      'Идеи, требующие новой инфраструктуры (свой WS-фид оракула Chainlink для расчёта от настоящей цены расчёта, консенсус нескольких бирж, лимит суммарной экспозиции в супервайзере) — в плане на следующий этап.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Чистка ростера: убрали стратегии без края',
    items: [
      'Удалили 7 стратегий с отрицательным краем (винрейт ниже точки безубыточности на их коэффициентах): «сильный фаворит» и его сессионная версия (−4.4 и −5.2пп на 700+ сделках — «ловушка фаворита» не подтвердилась), а также egsnap, egz2, egsess, egparlay, egoscar.',
      'Оставили только перспективное: eglate и egprog (край в плюсе, базовые), egcombo (строгий фильтр цена≤0.65) и egedge.',
      'Докрутили egedge: раньше фильтр был цена≤0.80 + f>0 и давал минус (−4.7пп) — порог не отсекал убыточную зону 0.76–0.80. Сделали цену ≤0.70 и сбросили статистику. Теперь это «средняя ступень» градиента: eglate ≤0.80 → egedge ≤0.70 → egcombo ≤0.65.',
    ],
  },
  {
    date: '2026-06-07',
    title: 'Серьёзная работа с мани-менеджментом + стратегия egcombo',
    items: [
      'Провели глубокое исследование систем ставок (Kelly, Мартингейл, анти-Мартингейл, Оскар) + Монте-Карло на наших реальных числах. Вывод: мини-Мартингейл при наших коэффициентах ведёт к разорению (37% на симуляции), а постоянный рост даёт только дробный Kelly при реальном крае.',
      'Добавили стратегию «Эндшпиль · комбо»: вход только при цене ≤0.65 + сильном сигнале z≥1.5 + в сессии Азия/Европа (00–13 UTC) + положительном крае f>0. Меньше сделок, но каждая с математическим перевесом.',
      'Добавили аварийный тормоз по просадке: если стратегия теряет −30% своего банка — авто-стоп для защиты бюджета (это не Мартингейл, а защита).',
      'Перевели бумажную торговлю на рекомендуемый бюджет $' + RECOMMENDED_BUDGET + ', чтобы видеть, как Kelly компаундирует при достаточном банке.',
    ],
  },
  {
    date: '2026-06-06',
    title: 'Несколько стратегий сразу, карточки, очистка статистики',
    items: [
      'Разрешили запускать несколько стратегий одновременно на одном кошельке — банк делится поровну, суммарный риск не превышает депозит.',
      'Выбор стратегий переделали в карточки с кнопками Запуск/Стоп: активные сверху, неактивные приглушены, результат прямо в карточке.',
      'Добавили рекомендуемый минимальный депозит под каждую стратегию (минимум $20) — ниже него стратегия ждёт пополнения, чтобы заявки не упирались в минимум биржи (5 акций).',
      'Добавили кнопку «Очистить статистику» и страницу реальной статистики каждой стратегии (график PnL, все сделки).',
      'Стратегия egedge: вход только при положительном крае (f>0), без бесперевесных входов.',
    ],
  },
  {
    date: '2026-06-05',
    title: 'Запуск реальной торговли + расчёт ставки по Kelly от депозита',
    items: [
      'Реализовали панель реальной торговли: ставка считается дробным Kelly от реального депозита, без авто-стопов (до ручной остановки).',
      'В статистике показали честное основание каждой ставки: винрейт, коэффициент, дробь Kelly и фактический размер.',
      'Убрали стратегию favprog (гипотеза «ставка на фаворита» не подтвердилась — край ≈ 0).',
    ],
  },
];

// Карточка стратегии в боевой панели: результат + кнопка Запуск/Стоп.
// Активные — с зелёной рамкой и живым статусом; неактивные — приглушённые (блюр).
const REAL_STATE_RU: Record<string, string> = { running: 'идёт торговля', starting: 'запуск…', low_deposit: 'ждёт пополнения', drawdown_stop: 'стоп по просадке', error: 'ошибка', idle: 'остановлена', done: 'остановлена' };
function realCard(s: StrategyDef, ses: RealSession | null, ts: PredictStatus | null, isActive: boolean, canRun: boolean): string {
  const minDep = minDepositOf(s);
  const np = ts?.netPnl ?? 0;
  const tradeRow = ts && (ts.rounds ?? 0) > 0
    ? `<div class="row">` +
      `<div><b>${ts.rounds}</b>сделок</div>` +
      `<div><b>${ts.winRate}%</b>win rate</div>` +
      `<div><b style="color:${np >= 0 ? '#4ad991' : '#e5616c'}">${fmtUsd(np)}</b>net PnL</div>` +
      (ts.avgStake != null ? `<div><b>$${ts.avgStake.toFixed(2)}</b>ср. ставка</div>` : '') +
      `</div>`
    : `<div class="row"><div style="color:#6b7484">реальных сделок пока нет</div></div>`;
  let live = '';
  let stateBadge = '';
  if (isActive && ses) {
    const low = ses.state === 'low_deposit';
    const dd = ses.state === 'drawdown_stop';
    const badgeWarn = low || dd; // бейдж жёлтый/красный; «running с предупреждением» остаётся зелёным
    stateBadge = `<span class="pd-rstate ${badgeWarn ? 'pd-rstate-low' : 'pd-rstate-on'}">${dd ? '🛑 ' : low ? '⚠ ' : '● '}${esc(REAL_STATE_RU[ses.state] ?? ses.state)}</span>`;
    const pnlCol = (ses.pnl ?? 0) >= 0 ? '#4ad991' : '#e5616c';
    live =
      `<div style="font-size:12.5px;color:#9aa4b2;margin-bottom:8px">` +
      `Сессия: сделок <b style="color:#e6e9ef">${ses.fills ?? 0}</b> · PnL <b style="color:${pnlCol}">${fmtUsd(ses.pnl ?? 0)}</b>` +
      (ses.bank != null ? ` · банк <b style="color:#e6e9ef">$${ses.bank.toFixed(2)}</b>` : '') +
      `</div>` +
      // предупреждение показываем всегда, когда оно есть (в т.ч. «работает, но банк ниже рекомендуемого»)
      (ses.reason ? `<div style="font-size:12px;color:${dd ? '#ff9b9b' : '#e5c061'};margin-bottom:8px">${dd ? '🛑' : '⚠'} ${esc(ses.reason)}</div>` : '');
  }
  const btn = isActive
    ? `<form method="POST" action="/predict/real/stop"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-stop">⏸ Остановить</button></form>`
    : canRun
      ? `<form method="POST" action="/predict/real/start"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-go">▶ Запустить</button></form>`
      : `<button class="pd-rbtn pd-rbtn-off" disabled title="Сначала сохрани ключ и адрес депозита">▶ Запустить</button>`;
  return (
    `<div class="pd-rcard ${isActive ? 'pd-rcard-on' : 'pd-rcard-off'}">` +
    `<h3><a href="/predict/real/${s.slug}">${esc(s.title)}</a>${stateBadge}</h3>` +
    `<div class="tag">${esc(s.tagline)}</div>` +
    live +
    tradeRow +
    `<div class="pd-foot" style="margin:6px 0 2px">Комфортный минимум: <b style="color:#9aa4b2">$${minDep}</b> (ниже — торгует, но пропускает дорогие входы)${isActive && ses?.bank != null && ses.bank < minDep ? ` · <span style="color:#e5c061">доля $${ses.bank.toFixed(2)} ниже</span>` : ''}</div>` +
    `<a class="pd-arrow" href="/predict/real/${s.slug}" style="margin:0 0 8px">Подробная статистика и сделки →</a>` +
    btn +
    `</div>`
  );
}
function renderRealTrading(cfg: RealConfig, ctrl: RealControl, err?: string): string {
  const back = `<a class="pd-back" href="/predict">← раздел /predict</a>`;
  const fieldStyle = 'margin-top:4px;width:360px;max-width:100%;padding:8px 10px;background:#0b0e13;border:1px solid #2a313c;border-radius:7px;color:#e6e9ef';
  const keyStatus = cfg.keyMask
    ? `<span class="pd-pos">✓ ключ сохранён (${esc(cfg.keyMask)})</span>`
    : `<span class="pd-neg">✗ ключ не сохранён</span>`;
  const updated = cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC' : '—';

  // ── Боевые сессии (несколько стратегий одновременно, банк делится поровну) ──
  const funderOk = !!cfg.funderAddress && /^0x[a-fA-F0-9]{40}$/.test(cfg.funderAddress);
  const canRun = !!cfg.keyMask && funderOk;
  const eligible = realEligibleStrategies();
  const activeSet = new Set(Object.keys(ctrl.running ?? {}));
  const sess = readRealSessions();
  const activeCount = activeSet.size;
  const deposit = sess.deposit;
  const perShare = sess.perShare;

  const badge = activeCount > 0
    ? `<span class="pd-fresh"><span class="pd-dot"></span>● активно стратегий: ${activeCount}</span>`
    : `<span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>⏸ ничего не запущено</span>`;
  const errNote = err === 'funder'
    ? `<div class="pd-card" style="border-color:#5a2e2e"><p class="pd-sub" style="color:#ff9b9b">✗ Сначала сохрани корректный адрес депозит-кошелька — без него запуск невозможен.</p></div>`
    : '';

  // Сводные реальные метрики + накопительная кривая по всем стратегиям.
  let totalRealPnl = 0, totalRealTrades = 0;
  const allRealRounds: RecentRound[] = [];
  for (const s of eligible) {
    const ts = readRealStatus(s.slug);
    if (!ts) continue;
    totalRealPnl += ts.netPnl ?? 0;
    totalRealTrades += ts.rounds ?? 0;
    for (const r of ts.recentRounds ?? []) allRealRounds.push({ ...r, _strategy: s.title });
  }
  totalRealPnl = Math.round(totalRealPnl * 100) / 100;

  // Карточки: активные сверху, неактивные (приглушённые) снизу.
  const cards = [...eligible]
    .sort((a, b) => (activeSet.has(b.slug) ? 1 : 0) - (activeSet.has(a.slug) ? 1 : 0))
    .map((s) => realCard(s, sess.sessions[s.slug] ?? null, readRealStatus(s.slug), activeSet.has(s.slug), canRun))
    .join('');

  // Порог теперь информационный (не блокирует): «комфортный минимум» на стратегию и РЕКОМЕНДУЕМЫЙ бюджет для роста.
  const activeStrats = eligible.filter((s) => activeSet.has(s.slug));
  const minComfort = activeStrats.length > 0 ? activeStrats.length * Math.max(...activeStrats.map(minDepositOf)) : null;
  const belowMin = deposit != null && minComfort != null && deposit < minComfort;
  const belowRec = deposit != null && deposit < RECOMMENDED_BUDGET;

  const splitNote = activeCount > 1 && deposit != null && perShare != null
    ? `<p class="pd-foot" style="margin:0 0 14px">Банк делится поровну: депозит $${deposit.toFixed(2)} ÷ ${activeCount} = <b>$${perShare.toFixed(2)}</b> на стратегию. Суммарный риск не превышает кошелёк.</p>`
    : activeCount === 1 && deposit != null
      ? `<p class="pd-foot" style="margin:0 0 14px">Активна одна стратегия — банк Kelly = весь депозит $${deposit.toFixed(2)}.</p>`
      : `<p class="pd-foot" style="margin:0 0 14px">Запускай любое число стратегий при любом депозите — нет жёсткого минимума. При малом банке стратегия сама пропускает входы, которые не может оплатить. Комфортный минимум — ~$${Math.max(...eligible.map(minDepositOf))} на стратегию; для роста по Kelly рекомендуется ~$${RECOMMENDED_BUDGET}.</p>`;

  // Сводка по депозиту/результату — вверху страницы. Депозит ниже рекомендуемого — НЕ блок, а предупреждение.
  const budgetNote = belowMin
    ? `<p class="pd-foot" style="margin:12px 0 0;color:#e5c061">⚠ Депозит $${deposit!.toFixed(2)} мал для ${activeCount} активных (комфортно ~$${minComfort}). Стратегии торгуют, но при малом банке ставка Kelly упирается в минимум $1 (рыночный ордер). Для нормальной работы пополните до ~$${RECOMMENDED_BUDGET}.</p>`
    : belowRec
      ? `<p class="pd-foot" style="margin:12px 0 0;color:#9aa4b2">ℹ Стратегии торгуют. Для <b>реального роста</b> рекомендуется бюджет <b>~$${RECOMMENDED_BUDGET}</b>: при нём ставка по Kelly перестаёт упираться в минимум биржи и начинает компаундировать. Сейчас рост ограничен размером банка — доход капается малыми суммами, это нормально.</p>`
      : `<p class="pd-foot" style="margin:12px 0 0;color:#4ad991">✓ Депозит в рекомендуемом диапазоне — Kelly может компаундировать в полную силу.</p>`;
  const summaryCard =
    `<div class="pd-card"><div class="pd-grid">` +
    statCard('Депозит', deposit != null ? `$${deposit.toFixed(2)}` : '—', deposit != null ? (belowMin ? 'neg' : belowRec ? 'muted' : 'pos') : 'muted') +
    statCard('Активных стратегий', String(activeCount)) +
    statCard('Реком. бюджет', `$${RECOMMENDED_BUDGET}`, deposit != null && !belowRec ? 'pos' : 'muted') +
    statCard('Реальный PnL (всего)', fmtUsd(totalRealPnl), totalRealPnl > 0 ? 'pos' : totalRealPnl < 0 ? 'neg' : 'muted') +
    statCard('Сделок (всего)', String(totalRealTrades)) +
    `</div>` +
    (deposit != null ? budgetNote : '') +
    `</div>`;

  const launchCard = eligible.length === 0 ? '' :
    `<div class="pd-card">` +
    `<h2>Стратегии — реальная торговля</h2>` +
    `<p class="pd-sub">Запускай и останавливай стратегии по отдельности. ⚠️ <b>Авто-стопов нет</b> — каждая работает до ручной остановки. Размер ставки — <b>Kelly от доли депозита</b>.</p>` +
    splitNote +
    `<div class="pd-cards" style="margin-bottom:0">${cards}</div>` +
    (canRun ? '' : `<p class="pd-foot" style="margin-top:14px;color:#caa">Кнопки «Запустить» станут активными после сохранения ключа и адреса депозит-кошелька ниже.</p>`) +
    `</div>`;

  // Standalone-кандидаты в реал (живой движок m15live, НЕ Kelly-движок выше). Сейчас это только
  // h5m8: мини-тест боевого пути с жёсткими капами + шлюзом ликвидности. Управление — на его странице
  // /predict/<slug> («⚙️ Реальная торговля (оператор)»), чтобы не смешивать с Kelly-сессиями выше.
  const standaloneReal = STRATEGIES.filter((s) => s.standalone && s.realEligible === true && !s.engine);
  const standaloneCard = standaloneReal.length === 0 ? '' :
    `<div class="pd-card" style="border-color:#5a2e2e"><h2>🔴 Реальная торговля — LagEdge</h2>` +
    `<p class="pd-sub">Движки шлют <b>реальные ордера малым кэпом</b> с зашитыми капами и ценовым потолком (авто-стоп на флоре). Управление (Стоп/Старт) — на странице каждой монеты.</p>` +
    standaloneReal.map((s) => {
      const on = activeSet.has(s.slug);
      // СПЕЦ-КЕЙС lagedge: своя форма статуса (predict-lagedge-status.json) и нет страницы <slug>real —
      // ссылаемся на /predict/lagedge с собственным рендером, PnL берём из его реал-блока.
      if (s.slug.startsWith('lagedge')) {
        const lag = readDataJson(s.statusFile);
        const rp = lag?.real;
        const lagPnl = rp && typeof rp.netPnl === 'number' ? fmtUsd(rp.netPnl) : '—';
        const lagCap = lag && typeof lag.maxLossUsd === 'number' ? lag.maxLossUsd : 25;
        const cents = lag && typeof lag.ceilSlip === 'number' ? Math.round(lag.ceilSlip * 100) : 10;
        const band = lag && Array.isArray(lag.askBand) ? ` · ask ${lag.askBand[0]}–${lag.askBand[1]}` : '';
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #1e2530">` +
          `<div><b>${esc(s.title)}</b><div class="pd-foot" style="margin-top:2px">Капы: 5 акций (~$3) · авто-стоп −$${lagCap.toFixed(0)} · потолок ask+${cents}¢${band} · ${on ? '<span class="pd-pos">● армлен</span>' : '⏸ shadow'} · реал-PnL ${lagPnl}</div></div>` +
          `<a class="pd-rbtn pd-rbtn-go" style="width:auto;display:inline-block;padding:9px 18px;text-decoration:none" href="/predict/${s.slug}">Открыть статус shadow↔real →</a></div>`;
      }
      const st = readRealStatus(s.slug);
      const pnl = st?.netPnl != null ? fmtUsd(st.netPnl) : '—';
      const cStake = st?.flatStake ?? 1;
      const cLoss = st?.maxLossUsd ?? 8;
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #1e2530">` +
        `<div><b>${esc(s.title)}</b><div class="pd-foot" style="margin-top:2px">Капы: ставка $${cStake.toFixed(0)} · авто-стоп −$${cLoss.toFixed(0)} · шлюз ликвидности · ${on ? '<span class="pd-pos">● активна</span>' : '⏸ не запущена'} · реал-PnL ${pnl}</div></div>` +
        `<a class="pd-rbtn pd-rbtn-go" style="width:auto;display:inline-block;padding:9px 18px;text-decoration:none" href="/predict/${esc(s.slug)}real">Открыть статистику реала →</a></div>`;
    }).join('') +
    `</div>`;

  // Общая кривая накопленного PnL (все реальные сделки всех стратегий).
  const overallChart = allRealRounds.length >= 2
    ? `<div class="pd-card"><h2>Кривая накопленного PnL — все стратегии</h2>${equitySvg(equityFromRounds(allRealRounds, 'real'))}` +
      `<div class="pd-foot">Все реальные сделки по всем стратегиям, накопительно.</div></div>`
    : '';

  // Открытые сделки сейчас — по всем активным стратегиям.
  const liveRows: RecentRound[] = [];
  for (const slug of activeSet) {
    const live = readRealLive(slug);
    const pos = live?.position;
    if (pos && (pos.side === 'UP' || pos.side === 'DOWN')) {
      const secLeft = typeof live?.slotEndMs === 'number' ? Math.round((live.slotEndMs - Date.now()) / 1000) : undefined;
      const title = STRATEGIES.find((x) => x.slug === slug)?.title ?? slug;
      liveRows.push({ t: Date.now(), side: pos.side, stake: pos.stake ?? null, coef: pos.entryCoef ?? null, pnl: 0, win: false, _strategy: title, _live: true, _secLeft: secLeft });
    }
  }
  const openCard = activeCount === 0
    ? ''
    : liveRows.length > 0
      ? recentRoundsTable(liveRows, { title: `Открытые сделки сейчас (${liveRows.length})`, showStrategy: true })
      : `<div class="pd-card"><h2>Открытые сделки сейчас</h2><p class="pd-foot">Открытых позиций нет — активные стратегии ждут подходящий раунд (вход за 45–90с до закрытия).</p></div>`;

  // Подключение к бирже — сворачиваемый блок (свёрнут, если ключ и адрес уже сохранены).
  const walletForm =
    `<form method="POST" action="/predict/real/save" autocomplete="off">` +
    `<details class="pd-card"${canRun ? '' : ' open'}>` +
    `<summary style="cursor:pointer;font-weight:700;color:#e6e9ef;font-size:16px">⚙ Подключение к бирже ${canRun ? '<span class="pd-pos" style="font-size:13px;font-weight:600">✓ настроено — нажми, чтобы изменить</span>' : '<span class="pd-neg" style="font-size:13px;font-weight:600">— требуется настройка</span>'}</summary>` +
    `<div style="margin-top:18px">` +
    `<h3 style="margin:0 0 8px;color:#fff;font-size:16px">Приватный ключ кошелька</h3>` +
    `<label style="display:block;margin-bottom:12px">Хранится на сервере в защищённом файле, обратно не показывается:<br>` +
    `<input type="password" name="privkey" value="" placeholder="${cfg.keyMask ? 'оставь пустым, чтобы не менять' : '0x… приватный ключ'}" autocomplete="new-password" style="${fieldStyle}"></label>` +
    `<div style="margin:6px 0 12px">Статус ключа: ${keyStatus}</div>` +
    `<p class="pd-foot" style="margin-bottom:20px">🔒 Ключ передаётся по HTTPS, кладётся в файл с правами 600, в логи/в git не попадает.</p>` +
    `<h3 style="margin:0 0 8px;color:#fff;font-size:16px">Адрес депозит-кошелька Polymarket</h3>` +
    `<p class="pd-foot" style="margin-bottom:10px">В профиле Polymarket это строка <b>«Адрес … только для использования API»</b> (0x…). <b>API-ключ вводить НЕ нужно</b> — он создаётся автоматически из приватного ключа.</p>` +
    `<label style="display:block;margin-bottom:8px"><input type="text" name="funder" value="${esc(cfg.funderAddress ?? '')}" placeholder="0x… (ровно 0x + 40 hex)" style="${fieldStyle}"></label>` +
    `<div style="margin:6px 0 16px">Статус адреса: ${cfg.funderAddress && /^0x[a-fA-F0-9]{40}$/.test(cfg.funderAddress) ? `<span class="pd-pos">✓ адрес сохранён (${esc(cfg.funderAddress.slice(0, 6))}…${esc(cfg.funderAddress.slice(-4))})</span>` : '<span class="pd-neg">✗ адрес не задан</span>'}</div>` +
    `<button type="submit" class="pd-back" style="font-size:15px;background:#16321f;border:1px solid #2e5a3a;padding:10px 16px;border-radius:8px;cursor:pointer">💾 Сохранить</button>` +
    `<p class="pd-foot" style="margin-top:10px">Обновлено: ${esc(updated)}</p>` +
    `</div></details>` +
    `</form>`;

  return (
    STYLES +
    `<div class="pd-wrap">${back}` +
    `<div class="pd-head"><h1>Реальная торговля</h1>${badge}</div>` +
    `<div class="pd-card" style="border-color:#3a2e2e">` +
    `<p class="pd-sub">⚠️ Реальные деньги. Используй отдельный кошелёк, держи на нём только то, что готов потерять. <b>Авто-стопов нет</b> — стратегии работают до ручной остановки кнопкой «Остановить».</p>` +
    `</div>` +
    summaryCard +
    errNote +
    launchCard +
    standaloneCard +
    overallChart +
    openCard +
    walletForm +
    `</div>`
  );
}

// Страница реальной статистики одной стратегии: живая сессия + агрегаты + кривая + все сделки.
function renderRealStrategy(s: StrategyDef, st: PredictStatus | null, ses: RealSession | null, page: number): string {
  const back = `<a class="pd-back" href="/predict/real">← реальная торговля</a>`;
  const isActive = ses != null;
  const stateBadge = isActive
    ? `<span class="pd-fresh"><span class="pd-dot"></span>● ${esc(REAL_STATE_RU[ses.state] ?? ses.state)}</span>`
    : `<span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>⏸ не запущена</span>`;
  const header = `<div class="pd-head"><h1>${esc(s.title)}</h1>${stateBadge}</div>`;
  const minDep = minDepositOf(s);
  const belowMin = isActive && ses?.bank != null && ses.bank < minDep;
  const minLine = `<p class="pd-foot" style="margin:-6px 0 14px">Комфортный минимум банка: <b style="color:${belowMin ? '#e5c061' : '#9aa4b2'}">$${minDep}</b>${belowMin ? ` · сейчас доля $${ses!.bank!.toFixed(2)} — ниже` : ''}. Жёсткого минимума нет: ниже стратегия торгует, но ставка Kelly упирается в минимум $1 (рыночный ордер). Для роста по Kelly — бюджет ~$${RECOMMENDED_BUDGET}.</p>`;
  const ddStop = isActive && ses.state === 'drawdown_stop';
  const sessionCard = isActive
    ? `<div class="pd-card" style="border-color:${ddStop ? '#5a2e2e' : ses.state === 'low_deposit' ? '#5a4a2e' : '#2e5a3a'}"><h2>Текущая сессия</h2>` +
      `<div style="margin:6px 0">Сделок: <b>${ses.fills ?? 0}</b> · PnL сессии: <b class="${(ses.pnl ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}">${fmtUsd(ses.pnl ?? 0)}</b>` +
      (ses.bank != null ? ` · банк: <b>$${ses.bank.toFixed(2)}</b>` : '') + `</div>` +
      (ses.since ? `<div class="pd-foot">Старт: ${esc(new Date(ses.since).toLocaleString('ru-RU', { timeZone: 'UTC' }))} UTC</div>` : '') +
      (ddStop && ses.reason ? `<div style="color:#ff9b9b;margin-top:8px">🛑 ${esc(ses.reason)}</div>` : '') +
      (ses.state === 'low_deposit' && ses.reason ? `<div style="color:#e5c061;margin-top:8px">💰 ${esc(ses.reason)}</div>` : '') +
      `<form method="POST" action="/predict/real/stop" style="margin-top:14px"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-stop" style="width:auto;display:inline-block;padding:9px 20px">⏸ Остановить</button></form>` +
      `</div>`
    : `<div class="pd-card"><p class="pd-sub">Стратегия сейчас не запущена в реале. ${st && (st.rounds ?? 0) > 0 ? 'Ниже — статистика прошлых реальных сделок.' : 'Реальных сделок пока не было.'}</p>` +
      `<form method="POST" action="/predict/real/start"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-go" style="width:auto;display:inline-block;padding:9px 20px">▶ Запустить</button></form></div>`;

  // Очистка статистики — намерение пишет сайт, обнуляет супервайзер.
  const clearForm =
    `<div class="pd-card" style="border-color:#4a2e2e"><h2>Очистка статистики</h2>` +
    `<p class="pd-foot" style="margin-bottom:12px">Обнулить накопленную статистику этой стратегии (сделки, кривую, винрейт), чтобы начать заново. ${isActive ? '<b>Стратегия запущена</b> — она перезапустится с чистого банка.' : 'Историю сделок не вернуть.'}</p>` +
    `<form method="POST" action="/predict/real/clear" onsubmit="return confirm('Очистить всю статистику этой стратегии? Историю сделок не вернуть.')"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-stop" style="width:auto;display:inline-block;padding:9px 18px">🗑 Очистить статистику</button></form>` +
    `</div>`;

  if (!st || (st.rounds ?? 0) === 0) {
    return STYLES + `<div class="pd-wrap">${back}${header}<p class="pd-sub">${esc(s.tagline)}</p>` + minLine + sessionCard +
      `<div class="pd-card"><p class="pd-foot">Завершённых реальных сделок пока нет — появятся здесь после первых закрытых раундов.</p></div>` + clearForm + `</div>`;
  }

  const netAccent = st.netPnl > 0 ? 'pos' : st.netPnl < 0 ? 'neg' : 'muted';
  const PAGE_SIZE = 20;
  const allRounds = st.recentRounds ?? [];
  const totalPages = Math.max(1, Math.ceil(allRounds.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const pageRounds = allRounds.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const roundsTable = recentRoundsTable(pageRounds, { title: `Реальные сделки (${allRounds.length})`, page: p, totalPages, baseHref: `/predict/real/${s.slug}` });
  const updated = st.updatedAt ? new Date(st.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' }) : '—';

  return (
    STYLES +
    `<div class="pd-wrap">${back}${header}<p class="pd-sub">${esc(s.tagline)}</p>` +
    minLine +
    sessionCard +
    `<div class="pd-grid">` +
    statCard('Реком. минимум', `$${minDep}`, belowMin ? 'neg' : 'muted') +
    statCard('Сделок', String(st.rounds)) +
    statCard('Win rate', `${st.winRate}%`) +
    statCard('Net PnL', fmtUsd(st.netPnl), netAccent) +
    (st.profitFactor != null ? statCard('Profit factor', st.profitFactor.toFixed(2), 'muted') : '') +
    statCard('Max drawdown', `$${st.maxDrawdown.toFixed(2)}`, 'muted') +
    (st.maxLossStreak != null ? statCard('Макс. серия −', String(st.maxLossStreak), 'muted') : '') +
    (st.avgStake != null ? statCard('Ср. ставка', `$${st.avgStake.toFixed(2)}`, 'muted') : '') +
    (st.avgCoef != null ? statCard('Ср. коэф.', st.avgCoef.toFixed(2), 'muted') : '') +
    `</div>` +
    `<div class="pd-card"><h2>Кривая накопленного PnL</h2>${equitySvg(equityFromRounds(allRounds, s.slug))}</div>` +
    roundsTable +
    clearForm +
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC · реальные деньги</p>` +
    `</div>`
  );
}

// ── Боевой мини-тест (h5m8): ОТДЕЛЬНАЯ страница статистики РЕАЛЬНОЙ торговли ──
// ТОЛЬКО отображение готовых данных (status JSON + баланс кошелька). Ничего не
// армит, не шлёт ордера, деньги не трогает. Красный/боевой акцент, явная пометка
// «РЕАЛЬНЫЕ ДЕНЬГИ» — чтобы не спутать с бумажной (shadow) статистикой стратегии.
// Обобщена под любой realEligible-кандидат (сейчас h5m8): капы/порог берутся из статуса/slug.
function renderH5m12Real(
  s: StrategyDef,
  st: PredictStatus | null,
  balance: number | null,
  armed: boolean,
  page: number,
): string {
  const back = `<a class="pd-back" href="/predict/${esc(s.slug)}">← бумажная (shadow) статистика ${esc(s.slug)}</a>`;
  const balStr = balance != null ? `$${balance.toFixed(2)}` : '—';
  const rounds = st?.rounds ?? 0;

  // Капы боевого движка (зашиты в юнит, отражаются в статусе): ставка/стоп/лимит ордеров + шлюз.
  const capStake = st?.flatStake ?? 1;
  const capLoss = st?.maxLossUsd ?? 8;
  const capSlip = st?.maxSlip ?? 0.02;
  const skipped = st?.skipped ?? 0;
  const openCount = st?.openCount ?? 0;
  // Порог расхождения из slug (h5m8 → ≥8пп): для текста «ждём сигнал».
  const thrMatch = /(\d+)$/.exec(s.slug);
  const thrPp = thrMatch ? thrMatch[1] : '8';

  // Заголовок: красный боевой акцент.
  const header =
    `<div class="pd-head"><h1 style="color:#ff6b6b">🔴 Реальная торговля — ${esc(s.slug)} (мини-тест на реальные деньги)</h1>` +
    (st ? freshnessPill(st.updatedAt) : `<span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>статус недоступен</span>`) +
    `</div>`;

  // Громкий красный баннер: РЕАЛЬНЫЕ ДЕНЬГИ.
  const realMoneyBanner =
    `<div class="pd-card" style="border:2px solid #d83a3a;background:rgba(216,58,58,0.08)">` +
    `<h2 style="color:#ff6b6b;margin-top:0">⚠️ РЕАЛЬНЫЕ ДЕНЬГИ — это НЕ бумажная статистика</h2>` +
    `<p class="pd-sub" style="margin:0">Здесь показаны <b style="color:#ff8a8a">боевые сделки на реальный депозит</b> (USDC на Polygon). ` +
    `Это изолированный мини-тест стратегии ${esc(s.slug)} с жёсткими капами и шлюзом ликвидности (вход только если стакан реально наливает ставку). Бумажная (shadow) статистика той же стратегии — на ` +
    `<a class="pd-back" style="font-size:inherit;display:inline" href="/predict/${esc(s.slug)}">отдельной странице</a> и сюда не смешивается. ` +
    `Эта страница — только просмотр; ничего не запускает и денег не двигает.</p></div>`;

  // Верхний блок состояния: баланс кошелька, статус (армлен/боевой), капы.
  const engineReal = st?.engineMode === 'real' || st?.allowReal === true;
  const statusLabel = armed
    ? (engineReal ? '🟢 Реал активен' : '🟢 Армлен')
    : '⏸ Не армлен';
  const statusAccent: 'pos' | 'neg' | 'muted' = armed ? 'pos' : 'muted';
  const stateCard =
    `<div class="pd-card" style="border-color:#5a2e2e"><h2>Состояние боевого контура</h2>` +
    `<div class="pd-grid" style="margin-bottom:8px">` +
    statCard('Баланс кошелька', balStr, balance != null ? (balance > 0 ? 'pos' : 'neg') : 'muted') +
    statCard('Статус движка', statusLabel, statusAccent) +
    statCard('Открытых сейчас', String(openCount), openCount > 0 ? 'neg' : 'muted') +
    `</div>` +
    `<div class="pd-foot" style="margin:0">Капы (зашиты в боевой движок): ставка <b style="color:#ff8a8a">$${capStake.toFixed(0)}</b> · авто-стоп <b style="color:#ff8a8a">−$${capLoss.toFixed(0)}</b> · постоянно. ` +
    `Шлюз ликвидности: вход только если стакан наливает ставку по цене не хуже котировки на <b style="color:#ff8a8a">${(capSlip * 100).toFixed(0)}¢</b>; иначе пропуск (в PnL не идёт; счётчик «Пропущено» — в метриках ниже).` +
    (balance == null ? ' Баланс кошелька временно недоступен (показан «—») — это не влияет на работу движка.' : '') +
    `</div></div>`;

  if (!st) {
    // Статус-файл недоступен — всё равно показываем баланс/капы и честную заглушку.
    return (
      STYLES +
      `<div class="pd-wrap">${back}${header}` +
      `<p class="pd-sub">${esc(s.tagline)}</p>` +
      realMoneyBanner +
      stateCard +
      `<div class="pd-card"><p class="pd-foot">Боевой статус-файл пока не опубликован — данные появятся, как только боевой движок запишет первый снимок.</p></div>` +
      `</div>`
    );
  }

  // Пустое состояние: реальных сделок ещё нет.
  const emptyBanner = rounds === 0
    ? `<div class="pd-card" style="border-color:#5a4a2e"><h2>⏳ Реальных сделок пока нет</h2>` +
      `<p class="pd-sub" style="margin:0">Движок активен и ждёт первый сигнал <b>≥${thrPp}пп</b> (расхождение модели с рынком), который при этом реально наливается на стакане. ` +
      `Баланс кошелька <b style="color:#ffd27a">${balStr}</b>. Как появится подходящее расхождение с ликвидностью — поставит реальный <b>$${capStake.toFixed(0)}</b>. ` +
      `Движок уже перебрал <b>${st.evaluated ?? 0}</b> раундов, из них пропустил по тонкому стакану <b>${skipped}</b>; подходящие сигналы редки, поэтому пауза — это норма, а не поломка.</p></div>`
    : '';

  const pf = st.profitFactor == null ? '—' : st.profitFactor.toFixed(2);
  const netAccent = st.netPnl > 0 ? 'pos' : st.netPnl < 0 ? 'neg' : 'muted';
  const updated = new Date(st.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' });

  // Сетка метрик — как у shadow, но РЕАЛ.
  const metrics =
    `<div class="pd-grid">` +
    statCard('Реал-сделок', String(st.rounds)) +
    statCard('Win rate', `${st.winRate}%`) +
    statCard('Реальный PnL', fmtUsd(st.netPnl), netAccent) +
    statCard('Profit factor', pf, 'muted') +
    statCard('Max drawdown', `$${st.maxDrawdown.toFixed(2)}`, 'muted') +
    statCard('Пропущено (тонкий стакан)', String(skipped), 'muted') +
    (st.maxLossStreak != null ? statCard('Макс. серия −', String(st.maxLossStreak), 'muted') : '') +
    (st.maxWinStreak != null ? statCard('Макс. серия +', String(st.maxWinStreak), 'muted') : '') +
    (st.avgCoef != null ? statCard('Ср. коэф.', st.avgCoef.toFixed(2), 'muted') : '') +
    (st.avgStake != null ? statCard('Ср. ставка', `$${st.avgStake.toFixed(2)}`, 'muted') : '') +
    `</div>`;

  // График: кривая накопленного РЕАЛЬНОГО PnL.
  const allRounds = st.recentRounds ?? [];
  const equityChart =
    `<div class="pd-card"><h2>Кривая накопленного РЕАЛЬНОГО PnL</h2>` +
    equitySvg(st.equityCurve && st.equityCurve.length >= 2 ? st.equityCurve : equityFromRounds(allRounds, s.slug)) +
    `<div class="pd-foot">Выигрышей: ${st.wins} · Проигрышей: ${st.losses} · реальные деньги.</div></div>`;

  // Таблица реальных сделок (пагинация 20/стр).
  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(allRounds.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const pageRounds = allRounds.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const roundsTable = recentRoundsTable(pageRounds, {
    title: `Реальные сделки (${allRounds.length})`,
    page: p,
    totalPages,
    baseHref: `/predict/${s.slug}real`,
  });

  return (
    STYLES +
    `<div class="pd-wrap">${back}${header}` +
    `<p class="pd-sub">${esc(s.tagline)}</p>` +
    realMoneyBanner +
    stateCard +
    emptyBanner +
    metrics +
    renderCompareBlock(s) +
    (rounds > 0 ? equityChart + roundsTable : '') +
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC · 🔴 реальные деньги · только отображение</p>` +
    `</div>`
  );
}

// Журнал изменений — публичная страница с хронологией того, что и зачем меняли.
function renderChangelog(): string {
  const back = `<a class="pd-back" href="/predict">← песочница стратегий</a>`;
  const entries = CHANGELOG.map((e) =>
    `<div class="pd-card">` +
    `<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px">` +
    `<span style="font-size:13px;color:#4ad991;font-weight:700;font-variant-numeric:tabular-nums">${esc(e.date)}</span>` +
    `<h2 style="margin:0;font-size:18px">${esc(e.title)}</h2></div>` +
    `<ul style="margin:0;padding-left:20px;color:#cdd3dc;font-size:14px;line-height:1.6">` +
    e.items.map((it) => `<li style="margin-bottom:6px">${esc(it)}</li>`).join('') +
    `</ul></div>`
  ).join('');
  return (
    STYLES +
    `<div class="pd-wrap">${back}` +
    `<div class="pd-head"><h1>Журнал изменений</h1></div>` +
    `<p class="pd-sub">Что и зачем мы меняем в стратегиях и системе — честная хронология. Новые изменения сверху.</p>` +
    entries +
    `<p class="pd-foot" style="margin-top:8px">Это раздел в активной разработке — стратегии и правила управления капиталом улучшаются по мере накопления данных.</p>` +
    `</div>`
  );
}

// ── LagEdge: СВОЙ рендер статуса shadow↔real (формат отличается от m15live) ──
// st = readDataJson('predict-lagedge-status.json'); armed = !!readRealControl().running?.['lagedge'].
// Полностью read-only: ставок/ордеров не делает, namерение пишут только POST-роуты по кнопке.
// showArm=false (shadow-варианты lagedge-tw/lagedge-imb) → вместо формы Арм/Стоп показываем плашку
// «только тень». По умолчанию true → поведение боевого lagedge без изменений.
function renderLagedge(st: any, armed: boolean, showArm: boolean = true, slug: string = 'lagedge'): string {
  const back = `<a class="pd-back" href="/predict/real">← реальная торговля</a>`;
  // Кнопка Арм/Стоп — общая для любого состояния данных; ТОЛЬКО у боевого lagedge (showArm).
  // У shadow-вариантов (showArm=false) — view-only плашка, никаких POST-форм арма.
  const ctrlCard = !showArm
    ? `<div class="pd-card" style="border-color:#3a3422">` +
      `<h2>⚙️ Управление реал-тестом</h2>` +
      `<p class="pd-sub" style="margin:0">🟡 Только тень (shadow) — арм недоступен, это исследовательский вариант. Движок считает теневой результат и не шлёт реальных ордеров.</p>` +
      `</div>`
    : `<div class="pd-card" style="border-color:${armed ? '#5a2e2e' : '#3a3422'}">` +
    `<h2>⚙️ Управление реал-тестом (оператор)</h2>` +
    (armed
      ? `<p class="pd-sub" style="margin-bottom:14px;color:#ff9b9b">🔴 РЕАЛ АРМЛЕН — движок шлёт реальные тестовые ордера (5 акций, ~$3/ордер) с жёсткими капами. «Остановить» вернёт в shadow.</p>` +
        `<form method="POST" action="/predict/real/stop"><input type="hidden" name="slug" value="${esc(slug)}"><button type="submit" class="pd-rbtn pd-rbtn-stop" style="width:auto;display:inline-block;padding:9px 20px">⏸ Остановить реал</button></form>`
      : `<p class="pd-sub" style="margin-bottom:14px">🟡 Сейчас shadow (ноль денег). Кнопка ставит намерение running.${esc(slug)}; движок начнёт слать РЕАЛЬНЫЕ тестовые сделки с капами.</p>` +
        `<form method="POST" action="/predict/real/start" onsubmit="return confirm('Армить РЕАЛЬНЫЕ тестовые сделки ${esc(slug)}?');"><input type="hidden" name="slug" value="${esc(slug)}"><button type="submit" class="pd-rbtn pd-rbtn-go" style="width:auto;display:inline-block;padding:9px 20px">▶ Армить реал</button></form>`) +
    `</div>`;

  if (!st || typeof st !== 'object') {
    return (
      STYLES +
      `<div class="pd-wrap">${back}` +
      `<div class="pd-head"><h1>🟡 ${esc(slug)} · эндшпильный лаг</h1></div>` +
      `<div class="pd-card"><p class="pd-sub" style="margin:0">Нет данных — движок ещё не писал статус (<code>predict-${esc(slug)}-status.json</code>). Запусти движок или подожди первого снимка.</p></div>` +
      ctrlCard +
      `</div>`
    );
  }

  const num = (x: any): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const pct = (x: any): string => (num(x) != null ? `${(x as number).toFixed(1)}%` : '—');
  const usd = (x: any): string => (num(x) != null ? fmtUsd(x as number) : '—');
  const pf = (x: any): string => (num(x) != null ? (x as number).toFixed(2) : '—');
  const n0 = (x: any): string => (num(x) != null ? String(Math.round(x as number)) : '0');
  const g4 = (x: any): string => (num(x) != null ? (x as number).toFixed(4) : '—');
  const cls = (n: number | null): string => (n == null ? 'pd-muted-td' : n > 0 ? 'pd-pos' : n < 0 ? 'pd-neg' : 'pd-muted-td');

  // Шапка: бэйдж арм + label/mode.
  const armBadge = armed
    ? `<span class="pd-fresh" style="background:rgba(229,97,108,.16);color:#ff8a8a">🔴 АРМЛЕН</span>`
    : `<span class="pd-fresh pd-fresh-stale">🟡 не армлен</span>`;
  const ageBits: string[] = [];
  if (num(st.snapAgeMs) != null) ageBits.push(`снапшот ${Math.round((st.snapAgeMs as number) / 1000)}с назад`);
  if (num(st.spotAgeMs) != null) ageBits.push(`спот ${Math.round((st.spotAgeMs as number) / 1000)}с назад`);

  const banners: string[] = [];
  if (st.degraded) banners.push(`<div class="pd-retired-banner" style="border-color:rgba(229,97,108,.5);color:#ffb3b3">⚠ DEGRADED — сверь /openorders + /balance, реал-данные могут быть неполными.</div>`);
  if (num(st.snapAgeMs) != null && (st.snapAgeMs as number) > 10000) banners.push(`<div class="pd-retired-banner" style="border-color:rgba(229,180,97,.5);color:#e5c061;background:rgba(229,180,97,.08)">⚠ Данные коллектора задерживаются (снимок ${Math.round((st.snapAgeMs as number) / 1000)}с назад).</div>`);

  // Баннер реал-теста (капы).
  const bandPair = Array.isArray((st as any).askBand) ? `${(st as any).askBand[0]}–${(st as any).askBand[1]}` : '0.35–0.72';
  const ceilC = typeof (st as any).ceilSlip === 'number' ? Math.round((st as any).ceilSlip * 100) : 10;
  const distBase = num((st as any).distMin);
  const volFrac = num((st as any).volDistFrac);
  const distRule = distBase != null
    ? (volFrac != null && volFrac > 0 ? `dist ≥ max(${distBase.toFixed(1)}, ${volFrac.toFixed(1)}×vol15m)` : `dist ≥ ${distBase.toFixed(1)} bp`)
    : 'dist —';
  const testBanner =
    `<div class="pd-card" style="border-color:#3a3422">` +
    `<h2>Реал-тест — капы</h2>` +
    `<p class="pd-sub" style="margin:0">5 акций (~$3/ордер) · ask ${bandPair} · потолок ask+${ceilC}¢ · ` +
    `${esc(distRule)} · ` +
    `MAX_ORDERS=<b>${n0(st.maxOrders)}</b>, осталось <b>${n0(st.ordersLeft)}</b> · ` +
    `стоп −$<b>${n0(st.maxLossUsd)}</b> · floor $<b>${n0(st.realFloor)}</b> · ` +
    `макс. риск $<b>${n0(st.maxPossibleLoss)}</b></p>` +
    ((volFrac != null && volFrac > 0) || num((st as any).spotStaleSkips) != null
      ? `<p class="pd-foot" style="margin-top:8px">адаптивный порог: в спокойном рынке берём базовый dist, в шумном требуем движение сильнее текущей 15м-волатильности; stale-spot скипы: ${n0(st.spotStaleSkips)}</p>`
      : '') +
    (st.realFillPriceSource ? `<p class="pd-foot" style="margin-top:8px">источник цены реал-fill: ${esc(String(st.realFillPriceSource))}</p>` : '') +
    `</div>`;

  // Таблица shadow↔real бок-о-бок.
  const sh = st.shadow ?? {};
  const rl = st.real ?? {};
  const sideBySide =
    `<div class="pd-card"><h2>Теневой ↔ Реальный</h2>` +
    `<table class="pd-table"><thead><tr><th>метрика</th><th>🟡 shadow</th><th>🔴 real</th></tr></thead><tbody>` +
    `<tr><td>сделок (n)</td><td>${n0(sh.n)}</td><td>${n0(rl.n)}</td></tr>` +
    `<tr><td>винрейт</td><td>${pct(sh.winRatePct)}</td><td>${pct(rl.winRatePct)}</td></tr>` +
    `<tr><td>netPnl</td><td class="${cls(num(sh.netPnl))}">${usd(sh.netPnl)}</td><td class="${cls(num(rl.netPnl))}">${usd(rl.netPnl)}</td></tr>` +
    `<tr><td>profit factor</td><td>${pf(sh.profitFactor)}</td><td>${pf(rl.profitFactor)}</td></tr>` +
    `<tr><td>накопит. PnL (моно)</td><td class="${cls(num(st.shadowNetPnlCum))}">${usd(st.shadowNetPnlCum)}</td><td class="${cls(num(st.realNetPnlCum))}">${usd(st.realNetPnlCum)}</td></tr>` +
    `</tbody></table>`;
  const gap = st.gap ?? {};
  const gapBlock =
    `<div class="pd-foot" style="margin-top:12px">Зазор (на ${n0(gap.onFilledRounds)} филл-раундах): ` +
    `netPnl shadow−real = <b class="${cls(num(gap.netPnlShadowMinusReal))}">${usd(gap.netPnlShadowMinusReal)}</b> · ` +
    `Δвинрейт = <b>${num(gap.winRateDelta) != null ? pct(gap.winRateDelta) : '—'}</b></div>` +
    `</div>`;

  // Исполнение.
  const pg = st.priceGap ?? {};
  const execCard =
    `<div class="pd-card"><h2>Исполнение</h2>` +
    `<div class="pd-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">` +
    statCard('Fill-rate', st.fillRatePct != null ? pct(st.fillRatePct) : '—', num(st.fillRatePct) != null && (st.fillRatePct as number) >= 50 ? 'pos' : 'muted') +
    statCard('филлов / чистых', `${n0(st.filledSignals)} / ${n0(st.sentClean)}`) +
    statCard('сырой fill-rate', st.fillRatePctRaw != null ? pct(st.fillRatePctRaw) : '—', 'muted') +
    statCard('uncertain', n0(st.uncertainFills), num(st.uncertainFills) ? 'neg' : 'muted') +
    statCard('partial', n0(st.partialFills), num(st.partialFills) ? 'neg' : 'muted') +
    statCard('zero', n0(st.zeroFills), num(st.zeroFills) ? 'neg' : 'muted') +
    statCard('fee-tier флипы', n0(st.feeTierFlips), num(st.feeTierFlips) ? 'neg' : 'muted') +
    `</div>` +
    `<p class="pd-foot" style="margin-top:6px">Зазор реал−shadow по цене (≤0 = налил по ask-или-лучше), n=${n0(pg.n)}: ` +
    `mean ${g4(pg.mean)} · p50 ${g4(pg.p50)} · p90 ${g4(pg.p90)} · max ${g4(pg.max)}</p>` +
    `<p class="pd-foot" style="margin-top:4px">Скипы: тонкий стакан ${n0(st.thinSkips)} · протухший снапшот ${n0(st.staleSkips)} · протухший спот ${n0(st.spotStaleSkips)}</p>` +
    // orderflow-гейт imb20 (вариант lagedge-imb): показываем только если поля присутствуют.
    ((st.imbConfirm != null || num(st.imbSkips) != null)
      ? `<p class="pd-foot" style="margin-top:4px">orderflow-гейт imb20: ${st.imbConfirm ? '<span class="pd-pos">подтверждение ВКЛ</span>' : 'подтверждение выкл'} · пропущено по гейту ${n0(st.imbSkips)}</p>`
      : '') +
    `</div>`;

  // bySec.
  const bySec: any[] = Array.isArray(st.bySec) ? st.bySec : [];
  const bySecCard = bySec.length === 0 ? '' :
    `<div class="pd-card"><h2>По окну (сек до закрытия)</h2>` +
    `<table class="pd-table"><thead><tr><th>окно</th><th>nSh</th><th>винр.Sh</th><th>PnL Sh</th><th>nReal</th><th>винр.Real</th><th>PnL Real</th><th>зазор¢ mean</th></tr></thead><tbody>` +
    bySec.map((r: any) =>
      `<tr><td>${esc(String(r.range ?? '—'))}</td>` +
      `<td>${n0(r.nShadow)}</td><td>${pct(r.winRateShadow)}</td><td class="${cls(num(r.shadowPnl))}">${usd(r.shadowPnl)}</td>` +
      `<td>${n0(r.nRealFilled)}</td><td>${pct(r.winRateReal)}</td><td class="${cls(num(r.realPnl))}">${usd(r.realPnl)}</td>` +
      `<td>${g4(r.priceGapMean)}</td></tr>`).join('') +
    `</tbody></table></div>`;

  // Лента трейдов (первые ~40).
  const trades: any[] = Array.isArray(st.trades) ? st.trades.slice(0, 40) : [];
  const fmtTs = (ts: any): string => {
    const n = num(ts);
    if (n == null) return '—';
    const d = new Date(n + 3 * 3600_000); // МСК
    return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  const tradesCard = trades.length === 0 ? '' :
    `<div class="pd-card"><h2>Последние сделки (${trades.length})</h2>` +
    `<table class="pd-table"><thead><tr><th>время МСК</th><th>сек</th><th>сигнал</th><th>сторона</th><th>ЦЕНА ВХОДА</th><th>shadow</th><th>real fill?</th><th>акций</th><th>ср.цена</th><th>real PnL</th><th>зазор¢</th><th>флаги</th></tr></thead><tbody>` +
    trades.map((t: any) => {
      const shWin = t.shadowWin === true;
      const shPnl = num(t.shadowPnl);
      const rPnl = num(t.realPnl);
      const filled = t.realFilled === true;
      const fillCell = filled
        ? `<span class="pd-pos">да</span>`
        : (t.rejectReason ? `<span class="pd-muted-td">нет (${esc(String(t.rejectReason))})</span>` : `<span class="pd-muted-td">нет</span>`);
      const flags: string[] = [];
      if (t.realUncertain === true) flags.push('?uncert');
      if (t.realPartial === true) flags.push('partial');
      if (t.feeTierFlipped === true) flags.push('feeFlip');
      const sideCls = t.side === 'UP' ? 'pd-up' : t.side === 'DOWN' ? 'pd-down' : '';
      const dv = num(t.distVolRatio);
      const sigBits = [
        `dist ${g4(t.dist)}`,
        num(t.distMinEff) != null ? `min ${g4(t.distMinEff)}` : '',
        num(t.vol15mBp) != null ? `vol ${g4(t.vol15mBp)}` : '',
        dv != null ? `x${dv.toFixed(2)}` : '',
      ].filter(Boolean).join(' · ');
      return `<tr style="${shWin ? '' : 'opacity:.82'}">` +
        `<td class="pd-muted-td">${fmtTs(t.ts)}</td>` +
        `<td>${num(t.effSec) != null ? n0(t.effSec) : '—'}</td>` +
        `<td style="font-size:12px;white-space:nowrap" title="dist = движение BTC от открытия раунда; min = фактический порог после волатильности; vol = реализованная 15м волатильность; x = |dist|/vol">${esc(sigBits || '—')}</td>` +
        `<td class="${sideCls}">${esc(String(t.side ?? '—'))}</td>` +
        `<td>${num(t.shadowAsk) != null ? (t.shadowAsk as number).toFixed(2) : '—'}</td>` +
        `<td class="${shWin ? 'pd-pos' : 'pd-neg'}">${shWin ? '✓' : '✗'} ${usd(shPnl)}</td>` +
        `<td>${fillCell}</td>` +
        `<td>${num(t.realShares) != null ? n0(t.realShares) : '—'}</td>` +
        `<td>${num(t.realAvgPrice) != null ? (t.realAvgPrice as number).toFixed(3) : '—'}</td>` +
        `<td class="${cls(rPnl)}">${rPnl != null ? usd(rPnl) : '—'}</td>` +
        `<td>${g4(t.priceGap)}</td>` +
        `<td class="pd-muted-td" style="font-size:12px">${esc(flags.join(' '))}</td>` +
        `</tr>`;
    }).join('') +
    `</tbody></table>` +
    `<p class="pd-foot" style="font-size:12px;margin-top:8px">СЕК — секунд до конца раунда на входе · СИГНАЛ — dist/min/vol/x после адаптации к волатильности · СТОРОНА — UP/DOWN (куда ушёл спот от open) · ЦЕНА ВХОДА — ask дешёвого фаворита (полоса ${bandPair}) · SHADOW — теневой исход (✓/✗) и теневой PnL · REAL FILL? — налился ли реальный ордер (иначе причина: disarmed/shadow-mode/token-uncached/clean-reject/zero-fill/spot-stale) · АКЦИЙ — реально налито (size_matched) · СР.ЦЕНА — фактическая средняя цена реального филла · REAL PNL — реальный PnL · ЗАЗОР¢ — реал.цена минус ЦЕНА ВХОДА (≤0 = налил по ask или лучше) · ФЛАГИ — partial/неподтв/смена-fee-тира.</p></div>`;

  return (
    STYLES +
    `<div class="pd-wrap">${back}` +
    `<div class="pd-head"><h1>${esc(String(st.label ?? slug))} · эндшпильный лаг</h1>${armBadge}</div>` +
    `<p class="pd-sub">${esc(String(st.label ?? '—'))}${st.mode ? ` · режим: ${esc(String(st.mode))}` : ''}${ageBits.length ? ` · ${ageBits.join(' · ')}` : ''}</p>` +
    banners.join('') +
    testBanner +
    sideBySide + gapBlock +
    execCard +
    bySecCard +
    tradesCard +
    ctrlCard +
    `</div>`
  );
}

// «Хакерский терминал» — read-only живой фид журнала всех predict-сервисов.
// Вся раскраска/авто-скролл/тикер — на клиенте; данные приходят по SSE и из ticker.json.
function renderConsole(): string {
  return `
<style>
  :root { --crt:#00ff66; }
  .term-wrap{max-width:1180px;margin:0 auto;padding:0 6px 24px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
  .term-top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:6px 0 12px}
  .term-title{font-size:22px;font-weight:800;letter-spacing:2px;color:#e8fff0;
    text-shadow:0 0 6px rgba(0,255,102,.55),0 0 18px rgba(0,255,102,.25);text-transform:uppercase}
  .term-title b{color:#00ff66}
  .term-sub{font-size:12px;color:#5f7a68;letter-spacing:1px}
  .blink{animation:blink 1s steps(2,start) infinite}
  @keyframes blink{to{opacity:0}}
  /* Бегущая неоновая шапка-тикер */
  .ticker{position:relative;overflow:hidden;border:1px solid #143b24;border-radius:8px;
    background:linear-gradient(180deg,#06140c,#040a07);box-shadow:0 0 24px rgba(0,255,102,.08) inset;height:34px}
  .ticker-track{position:absolute;white-space:nowrap;will-change:transform;display:inline-block;
    padding-left:100%;animation:scroll 38s linear infinite;line-height:34px;font-size:13px;letter-spacing:.5px}
  .ticker:hover .ticker-track{animation-play-state:paused}
  @keyframes scroll{from{transform:translateX(0)}to{transform:translateX(-100%)}}
  .tk{margin:0 20px;color:#9fffc6}
  .tk .lab{color:#4f6a5a}
  .tk .pos{color:#00ff66}
  .tk .neg{color:#ff4d4d}
  .tk .amp{color:#ffd24a}
  .tk-sep{color:#1f5234}
  /* ── Дата-дождь (узкая бегущая строка синтетических тиков) ── */
  .drain{position:relative;overflow:hidden;height:20px;margin-top:6px;border:1px solid #0d2a1a;border-radius:6px;
    background:#03070500;opacity:.8}
  .drain-track{position:absolute;white-space:nowrap;will-change:transform;display:inline-block;padding-left:100%;
    animation:scroll 22s linear infinite;line-height:20px;font-size:11px;letter-spacing:.5px;color:#2f6a48}
  .drain-track .up{color:#00ff66}.drain-track .dn{color:#ff5a5a}.drain-track .dim{color:#244a34}
  /* ── Грид спарклайнов цен ── */
  .spk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px}
  .spk{position:relative;border:1px solid #0f3320;border-radius:8px;background:linear-gradient(180deg,#06130c,#040a07);
    padding:7px 9px 4px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,255,102,.03) inset}
  .spk canvas{display:block;width:100%;height:34px;margin-top:3px}
  .spk-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:12px}
  .spk-sym{color:#6f8f7a;font-weight:700;letter-spacing:1px}
  .spk-px{font-variant-numeric:tabular-nums;font-weight:700;color:#cfeede;transition:color .12s}
  .spk-arr{font-size:11px;margin-left:3px;opacity:.9}
  .flash-up{color:#04140a!important;background:#00ff66;border-radius:3px;padding:0 3px;box-shadow:0 0 12px rgba(0,255,102,.7)}
  .flash-dn{color:#1a0606!important;background:#ff5a5a;border-radius:3px;padding:0 3px;box-shadow:0 0 12px rgba(255,60,60,.6)}
  /* ── Грид тайлов движков ── */
  .eng-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;margin-top:8px}
  .eng{position:relative;border:1px solid #123322;border-radius:8px;background:linear-gradient(180deg,#07150d,#04090700);
    padding:8px 9px 7px;overflow:hidden}
  .eng.armed{border-color:#1f7a44;box-shadow:0 0 14px rgba(0,255,102,.14),0 0 0 1px rgba(0,255,102,.06) inset;
    animation:engpulse 2.4s ease-in-out infinite}
  @keyframes engpulse{0%,100%{box-shadow:0 0 10px rgba(0,255,102,.10),0 0 0 1px rgba(0,255,102,.05) inset}
    50%{box-shadow:0 0 22px rgba(0,255,102,.26),0 0 0 1px rgba(0,255,102,.12) inset}}
  .eng.degraded{border-color:#7a2e2e;animation:engbad 1.3s ease-in-out infinite}
  @keyframes engbad{0%,100%{box-shadow:0 0 8px rgba(255,60,60,.10)}50%{box-shadow:0 0 20px rgba(255,60,60,.30)}}
  .eng-name{font-size:11px;font-weight:800;letter-spacing:1px;color:#9fffc6;display:flex;align-items:center;gap:5px}
  .eng-name .dot{width:7px;height:7px;border-radius:50%;background:#2e5a3a;display:inline-block;flex:0 0 auto}
  .eng.armed .eng-name .dot{background:#00ff66;box-shadow:0 0 8px rgba(0,255,102,.9);animation:blink 1.1s steps(2,start) infinite}
  .eng.degraded .eng-name .dot{background:#ff5a5a;box-shadow:0 0 8px rgba(255,60,60,.9)}
  .eng-row{display:flex;justify-content:space-between;font-size:11px;color:#5f7a68;margin-top:5px;font-variant-numeric:tabular-nums}
  .eng-row b{color:#cfeede;font-weight:700}
  .eng-row .pos{color:#00ff66}.eng-row .neg{color:#ff5a5a}.eng-row .amp{color:#ffd24a}
  .eng-fresh{position:relative;height:4px;border-radius:3px;background:#0c2417;margin-top:7px;overflow:hidden}
  .eng-fresh i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:linear-gradient(90deg,#00ff66,#0a3);
    box-shadow:0 0 8px rgba(0,255,102,.6)}
  .eng-fresh.flash i{animation:freshflash .8s ease-out}
  @keyframes freshflash{0%{opacity:.4}30%{opacity:1;filter:brightness(1.6)}100%{opacity:.85}}
  /* Сам терминал */
  .crt{position:relative;margin-top:12px;height:60vh;min-height:380px;background:#050807;
    border:1px solid #11331f;border-radius:10px;overflow:hidden;
    box-shadow:0 0 40px rgba(0,255,102,.06),0 0 0 1px rgba(0,255,102,.04) inset;transition:box-shadow .25s}
  .crt.breathe{box-shadow:0 0 60px rgba(0,255,102,.16),0 0 0 1px rgba(0,255,102,.10) inset}
  #matrix{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.16}
  .crt::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:3;
    background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.18) 3px,rgba(0,0,0,0) 4px);
    mix-blend-mode:multiply;opacity:.5}
  .crt::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:4;
    background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.45) 100%);animation:flick 5.5s infinite}
  @keyframes flick{0%,97%,100%{opacity:1}98%{opacity:.86}99%{opacity:.97}}
  /* Бегущая сканлайн-полоса поверх терминала — постоянное движение */
  .scanbar{position:absolute;left:0;right:0;height:64px;z-index:3;pointer-events:none;
    background:linear-gradient(180deg,rgba(0,255,102,0),rgba(0,255,102,.05),rgba(0,255,102,0));
    animation:scanmove 6.5s linear infinite}
  @keyframes scanmove{from{top:-64px}to{top:100%}}
  .scroll{position:absolute;inset:0;overflow-y:auto;padding:12px 14px 26px;z-index:2;
    font-size:13.5px;line-height:1.5;scrollbar-width:thin;scrollbar-color:#1d5234 #050807}
  .scroll::-webkit-scrollbar{width:8px}
  .scroll::-webkit-scrollbar-thumb{background:#1d5234;border-radius:8px}
  .ln{white-space:pre-wrap;word-break:break-word;color:#bfe9cf;animation:in .18s ease-out}
  @keyframes in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
  .ln.glow{animation:in .18s ease-out, lnglow .9s ease-out}
  @keyframes lnglow{0%{background:rgba(0,255,102,.16)}100%{background:transparent}}
  .ln.glow.lose{animation:in .18s ease-out, lnglowR .9s ease-out}
  @keyframes lnglowR{0%{background:rgba(255,60,60,.16)}100%{background:transparent}}
  .ln .ts{color:#3f5a4a;margin-right:8px}
  .ln .svc{color:#6f8f7a;margin-right:8px}
  .ln .svc.lagedge{color:#7fd0ff}
  .ln.win{color:#00ff66;text-shadow:0 0 8px rgba(0,255,102,.35)}
  .ln.lose{color:#ff5a5a;text-shadow:0 0 8px rgba(255,60,60,.25)}
  .ln.signal{color:#39e6ff}
  .ln.real{color:#ffd24a}
  .ln.reso{color:#ff7af0}
  .ln.warn{color:#ffae3b}
  .ln.sys{color:#4f6a5a;font-style:italic}
  .cursor{display:inline-block;width:9px;height:15px;background:#00ff66;vertical-align:-2px;
    box-shadow:0 0 8px rgba(0,255,102,.7);animation:blink 1s steps(2,start) infinite;margin-left:2px}
  .pill{position:absolute;top:10px;right:12px;z-index:5;font-size:11px;letter-spacing:1px;
    color:#0a0a0a;background:#00ff66;padding:3px 9px;border-radius:20px;font-weight:800;
    box-shadow:0 0 14px rgba(0,255,102,.55);animation:pillpulse 2s ease-in-out infinite}
  @keyframes pillpulse{0%,100%{box-shadow:0 0 10px rgba(0,255,102,.45)}50%{box-shadow:0 0 22px rgba(0,255,102,.8)}}
  .pill.off{background:#ff4d4d;box-shadow:0 0 14px rgba(255,60,60,.5);animation:none}
  .bar{display:flex;gap:16px;flex-wrap:wrap;margin:10px 2px 0;font-size:11.5px;color:#5f7a68;letter-spacing:.5px}
  .bar b{color:#9fffc6;font-variant-numeric:tabular-nums;display:inline-block;transition:transform .18s,color .18s}
  .bar b.roll{animation:roll .4s ease-out}
  @keyframes roll{0%{transform:translateY(-7px);color:#fff;text-shadow:0 0 10px rgba(0,255,102,.9)}100%{transform:none}}
  .back{color:#4f6a5a;text-decoration:none;font-size:12px;margin-left:auto}
  .back:hover{color:#00ff66}
  .sect{font-size:10px;letter-spacing:2px;color:#2e5a3a;margin:12px 2px 2px;text-transform:uppercase}
</style>
<div class="term-wrap">
  <div class="term-top">
    <div class="term-title"><b>ROBOT</b> CLAUDE <span style="color:#2e5a3a">·</span> LIVE SYSTEM FEED</div>
    <span class="term-sub">predict-* · journalctl -f<span class="blink">_</span></span>
    <a class="back" href="/predict">← дашборд</a>
  </div>
  <div class="ticker"><div class="ticker-track" id="tkTrack"><span class="tk"><span class="lab">подключение к фиду…</span></span></div></div>
  <div class="drain"><div class="drain-track" id="drainTrack"><span class="dim">инициализация дата-потока…</span></div></div>

  <div class="sect">▸ markets · live price tape</div>
  <div class="spk-grid" id="spkGrid"></div>

  <div class="sect">▸ engines · live tiles</div>
  <div class="eng-grid" id="engGrid"></div>

  <div class="sect">▸ system feed · journalctl -f predict-*</div>
  <div class="crt" id="crt">
    <canvas id="matrix"></canvas>
    <div class="scanbar"></div>
    <div class="pill" id="pill">● LIVE</div>
    <div class="scroll" id="scroll"></div>
  </div>
  <div class="bar">
    <span>строк: <b id="cLines">0</b></span>
    <span>сигналов: <b id="cSig">0</b></span>
    <span>филлов: <b id="cFill">0</b></span>
    <span>резолюций: <b id="cReso">0</b></span>
    <span id="cConn" style="color:#00ff66">● stream connected</span>
  </div>
</div>
<script>
(function(){
  var scroll=document.getElementById('scroll');
  var crt=document.getElementById('crt');
  var pill=document.getElementById('pill');
  var elLines=document.getElementById('cLines'),elSig=document.getElementById('cSig'),
      elFill=document.getElementById('cFill'),elReso=document.getElementById('cReso'),
      elConn=document.getElementById('cConn'),tkTrack=document.getElementById('tkTrack'),
      drainTrack=document.getElementById('drainTrack'),spkGrid=document.getElementById('spkGrid'),
      engGrid=document.getElementById('engGrid');
  var nLines=0,nSig=0,nFill=0,nReso=0,MAX=900;
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';});}
  function setCount(el,n){var prev=el.textContent;el.textContent=n;if(prev!==String(n)){el.classList.remove('roll');void el.offsetWidth;el.classList.add('roll');}}

  function classify(m){
    var s=m.toLowerCase();
    if(/\\bwin\\b|выигр|shadow win|реал \\$|net\\+|roi=\\+|\\+\\$/i.test(m)) return 'win';
    if(/\\blose\\b|проигр|zero-?fill|zerofill|degraded|деград|stuck|застрял|-\\$|убыт/i.test(m)) return 'lose';
    if(/резолюц|resolut/i.test(s)) return 'reso';
    if(/\\bреал\\b|\\breal\\b|филл|fill/i.test(s)) return 'real';
    if(/сигнал|signal|eval|оценк/i.test(s)) return 'signal';
    if(/lock|reconcil|реконсил|warn|warning|retry|повтор/i.test(s)) return 'warn';
    return '';
  }
  function bump(cls,m){
    var s=m.toLowerCase();
    if(/сигнал|signal/i.test(s)){nSig++;setCount(elSig,nSig);}
    if(/филл|\\bfill\\b/i.test(s)){nFill++;setCount(elFill,nFill);}
    if(/резолюц|resolut/i.test(s)){nReso++;setCount(elReso,nReso);}
  }
  function breathe(){crt.classList.remove('breathe');void crt.offsetWidth;crt.classList.add('breathe');setTimeout(function(){crt.classList.remove('breathe');},260);}
  function add(o){
    var cls=classify(o.m||'');
    bump(cls,o.m||'');
    var atBottom=(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight)<60;
    var div=document.createElement('div');
    div.className='ln glow'+(cls?' '+cls:'');
    var svcCls='svc'+(/lagedge/.test(o.u||'')?' lagedge':'');
    div.innerHTML='<span class="ts">'+esc(o.t||'')+'</span><span class="'+svcCls+'">'+esc(o.u||'?')+'</span>'+esc(o.m||'');
    scroll.appendChild(div);
    nLines++;setCount(elLines,nLines);
    breathe();
    while(scroll.childNodes.length>MAX){scroll.removeChild(scroll.firstChild);}
    if(atBottom){scroll.scrollTop=scroll.scrollHeight;}
  }
  function sys(m){add({u:'sys',t:'',m:m});}

  // ── SSE-стрим журнала (ЯДРО — не трогаем) ──
  var es;
  function connect(){
    es=new EventSource('/predict/admin/logs/stream');
    es.addEventListener('log',function(ev){try{add(JSON.parse(ev.data));}catch(e){}});
    es.addEventListener('sys',function(ev){try{sys(JSON.parse(ev.data).m||'');}catch(e){}});
    es.onopen=function(){pill.textContent='● LIVE';pill.className='pill';elConn.textContent='● stream connected';elConn.style.color='#00ff66';};
    es.onerror=function(){pill.textContent='● RECONNECT';pill.className='pill off';elConn.textContent='● reconnecting…';elConn.style.color='#ffae3b';};
  }
  connect();

  function fmtNum(n){if(n==null)return '—';var a=Math.abs(n);return a>=1000?n.toLocaleString('en-US',{maximumFractionDigits:0}):a>=1?n.toFixed(a>=100?1:2):n.toFixed(4);}

  // ── MATRIX RAIN фон в терминале (canvas, дешёвый) ──
  (function(){
    var cv=document.getElementById('matrix');if(!cv)return;var ctx=cv.getContext('2d');
    var glyphs='01<>{}[]/$#%&λΔΣ∑BTCETHSOLXRP+-▲▼';var cols=0,drops=[],fs=14,W=0,H=0,dpr=Math.min(window.devicePixelRatio||1,2);
    function resize(){var r=crt.getBoundingClientRect();W=r.width;H=r.height;cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';ctx.setTransform(dpr,0,0,dpr,0,0);cols=Math.floor(W/fs);drops=[];for(var i=0;i<cols;i++)drops[i]=Math.random()*-H/fs;}
    resize();window.addEventListener('resize',resize);
    var last=0;
    function draw(t){
      if(t-last>55){last=t;
        ctx.fillStyle='rgba(5,8,7,0.22)';ctx.fillRect(0,0,W,H);
        ctx.font=fs+'px ui-monospace,monospace';
        for(var i=0;i<cols;i++){
          var ch=glyphs.charAt(Math.floor(Math.random()*glyphs.length));
          var x=i*fs,y=drops[i]*fs;
          ctx.fillStyle=Math.random()<0.04?'#aaffcc':'#0a8f44';
          ctx.fillText(ch,x,y);
          if(y>H&&Math.random()>0.975)drops[i]=0;else drops[i]+=1;
        }
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  })();

  // ── Спарклайны цен: история на клиенте, canvas, цвет по тику ──
  var SPK_ORDER=['BTC','ETH','SOL','XRP','DOGE','BNB'];
  var spk={}; // sym -> {hist:[], canvas, ctx, pxEl, arrEl, last}
  function ensureSpk(sym){
    if(spk[sym])return spk[sym];
    var card=document.createElement('div');card.className='spk';
    card.innerHTML='<div class="spk-head"><span class="spk-sym">'+sym+'</span><span><span class="spk-px" id="px_'+sym+'">—</span><span class="spk-arr" id="ar_'+sym+'"></span></span></div><canvas id="cv_'+sym+'"></canvas>';
    spkGrid.appendChild(card);
    var cv=card.querySelector('canvas');var dpr=Math.min(window.devicePixelRatio||1,2);
    var o={hist:[],canvas:cv,ctx:cv.getContext('2d'),pxEl:card.querySelector('.spk-px'),arrEl:card.querySelector('.spk-arr'),last:null,dpr:dpr,up:true};
    spk[sym]=o;return o;
  }
  function drawSpk(o){
    var cv=o.canvas,ctx=o.ctx,dpr=o.dpr;var w=cv.clientWidth||150,h=34;
    if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
    ctx.clearRect(0,0,w,h);
    var hist=o.hist;if(hist.length<2)return;
    var mn=Math.min.apply(null,hist),mx=Math.max.apply(null,hist),rng=(mx-mn)||1;
    var col=o.up?'#00ff66':'#ff5a5a';
    var grad=ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0,o.up?'rgba(0,255,102,.28)':'rgba(255,90,90,.26)');grad.addColorStop(1,'rgba(0,0,0,0)');
    var n=hist.length,stepX=w/(n-1);
    ctx.beginPath();ctx.moveTo(0,h-((hist[0]-mn)/rng)*(h-4)-2);
    for(var i=1;i<n;i++){ctx.lineTo(i*stepX,h-((hist[i]-mn)/rng)*(h-4)-2);}
    ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
    ctx.beginPath();ctx.moveTo(0,h-((hist[0]-mn)/rng)*(h-4)-2);
    for(var j=1;j<n;j++){ctx.lineTo(j*stepX,h-((hist[j]-mn)/rng)*(h-4)-2);}
    ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.shadowColor=col;ctx.shadowBlur=6;ctx.stroke();ctx.shadowBlur=0;
    // головная точка
    var lx=w,ly=h-((hist[n-1]-mn)/rng)*(h-4)-2;
    ctx.beginPath();ctx.arc(lx-1,ly,2.2,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
  }
  function pushSpot(sym,v){
    var o=ensureSpk(sym);
    var prev=o.last;
    if(prev!=null&&v!==prev)o.up=v>=prev;
    o.last=v;o.hist.push(v);if(o.hist.length>60)o.hist.shift();
    o.pxEl.textContent=fmtNum(v);
    if(prev!=null&&v!==prev){
      var up=v>prev;
      o.arrEl.textContent=up?'▲':'▼';o.arrEl.style.color=up?'#00ff66':'#ff5a5a';
      o.pxEl.classList.remove('flash-up','flash-dn');void o.pxEl.offsetWidth;
      o.pxEl.classList.add(up?'flash-up':'flash-dn');
      setTimeout(function(){o.pxEl.classList.remove('flash-up','flash-dn');},320);
    }
    drawSpk(o);
  }

  // ── Тайлы движков ──
  var engEls={};
  function engTile(e){
    var el=engEls[e.slug];
    if(!el){
      el=document.createElement('div');el.className='eng';el.id='eng_'+e.slug;
      el.innerHTML='<div class="eng-name"><span class="dot"></span><span class="nm"></span></div>'+
        '<div class="eng-row"><span>fills</span><b class="f"></b></div>'+
        '<div class="eng-row"><span>sig</span><b class="s"></b></div>'+
        '<div class="eng-row"><span>pnl</span><b class="p"></b></div>'+
        '<div class="eng-row"><span>WR</span><b class="w"></b></div>'+
        '<div class="eng-fresh"><i></i></div>';
      engGrid.appendChild(el);engEls[e.slug]=el;
    }
    var armed=!!e.armed,degr=!!e.degraded;
    el.className='eng'+(degr?' degraded':(armed?' armed':''));
    el.querySelector('.nm').textContent=e.slug.replace(/^lagedge-?/,'').toUpperCase()||'CORE';
    el.querySelector('.f').textContent=e.fills;
    el.querySelector('.s').textContent=e.signals;
    var pEl=el.querySelector('.p');
    if(e.pnl==null){pEl.textContent='—';pEl.className='p';}
    else{pEl.textContent=(e.pnl>=0?'+':'')+fmtNum(e.pnl);pEl.className='p '+(e.pnl>=0?'pos':'neg');}
    var wEl=el.querySelector('.w');
    if(e.winRate==null){wEl.textContent='—';wEl.className='w';}
    else{wEl.textContent=e.winRate.toFixed(0)+'%';wEl.className='w '+(e.winRate>=53?'pos':'neg');}
    // свежесть: snapAge мал → бар полный + вспышка при обновлении
    var age=e.snapAgeSec;var fresh=el.querySelector('.eng-fresh');var bar=fresh.querySelector('i');
    var pct=age==null?0:Math.max(0,Math.min(100,100-(age/180)*100));
    bar.style.width=pct+'%';
    bar.style.background=age!=null&&age<10?'linear-gradient(90deg,#00ff66,#0a3)':(age!=null&&age<60?'linear-gradient(90deg,#9fffc6,#2e7a4a)':'linear-gradient(90deg,#ffae3b,#7a4a1a)');
    if(el._age!==age){fresh.classList.remove('flash');void fresh.offsetWidth;if(age!=null&&age<15)fresh.classList.add('flash');el._age=age;}
  }
  function renderEngines(list){(list||[]).forEach(engTile);}

  // ── Тикер шапки (как было) ──
  function renderTicker(d){
    var parts=[];
    var spots=d.spots||{};var order=['BTC','ETH','SOL','XRP','DOGE','BNB'];
    order.forEach(function(k){if(spots[k]!=null)parts.push('<span class="tk"><span class="lab">'+k+'</span> '+fmtNum(spots[k])+'</span>');});
    if(d.balance!=null)parts.push('<span class="tk"><span class="lab">WALLET</span> <span class="amp">$'+fmtNum(d.balance)+'</span></span>');
    (d.engines||[]).forEach(function(e){
      var pnl=e.pnl;var pc=pnl==null?'':(pnl>=0?'pos':'neg');
      var stale=e.snapAgeSec!=null&&e.snapAgeSec>180;
      parts.push('<span class="tk"><span class="lab">'+e.slug.toUpperCase()+'</span>'+(e.armed?' <span class="pos">●</span>':'')+' fills:'+e.fills+
        (pnl!=null?' <span class="'+pc+'">pnl '+(pnl>=0?'+':'')+fmtNum(pnl)+'</span>':'')+
        (e.winRate!=null?' <span class="'+(e.winRate>=53?'pos':'neg')+'">wr '+e.winRate.toFixed(0)+'%</span>':'')+
        (stale?' <span class="neg">⚠snap '+e.snapAgeSec+'s</span>':'')+'</span>');
    });
    parts.push('<span class="tk"><span class="lab">'+new Date(d.ts||Date.now()).toLocaleTimeString('ru-RU',{hour12:false})+'</span></span>');
    var html=parts.join('<span class="tk-sep">│</span>');
    tkTrack.innerHTML=html+'<span class="tk-sep">│</span>'+html;
  }

  // ── Дата-дождь: синтетические бегущие тики из spots ──
  function renderDrain(d){
    var spots=d.spots||{};var seg=[];var order=['BTC','ETH','SOL','XRP','DOGE','BNB'];
    for(var r=0;r<3;r++){
      order.forEach(function(k){
        if(spots[k]==null)return;
        var o=spk[k];var up=o?o.up:true;
        var dist=(Math.random()*40-20).toFixed(1);
        seg.push('<span class="dim">'+k+'</span> <span class="'+(up?'up':'dn')+'">'+fmtNum(spots[k])+(up?'▲':'▼')+'</span> <span class="dim">dist'+(dist>=0?'+':'')+dist+'bp</span>');
      });
    }
    var html=seg.join('  <span class="dim">·</span>  ');
    drainTrack.innerHTML=html+'  <span class="dim">·</span>  '+html;
  }

  var firstTick=true;
  function applyTick(d){
    var spots=d.spots||{};
    SPK_ORDER.forEach(function(k){if(spots[k]!=null)pushSpot(k,spots[k]);});
    Object.keys(spots).forEach(function(k){if(SPK_ORDER.indexOf(k)<0&&spots[k]!=null)pushSpot(k,spots[k]);});
    renderEngines(d.engines);
    renderTicker(d);
    if(firstTick){renderDrain(d);firstTick=false;}else if(Math.random()<0.5)renderDrain(d);
  }
  function pollTicker(){
    fetch('/predict/admin/ticker.json',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;})
      .then(function(d){if(d&&d.ok)applyTick(d);}).catch(function(){});
  }
  pollTicker();setInterval(pollTicker,600);
})();
</script>`;
}

export async function predictRoute(app: FastifyInstance): Promise<void> {
  // Гейт раздела: только залогиненные пользователи с выданным админом доступом.
  // Возвращает user при доступе, либо null (вызывающий показывает «через поддержку»).
  const gate = (req: Parameters<typeof getAuthedUser>[0]) => {
    const u = getAuthedUser(req);
    return u && u.predictAccess ? u : null;
  };

  // Карта slug→engine доступных для реала стратегий — читает супервайзер на VPS.
  // Пишется при старте сайта, поэтому новые стратегии подхватываются автоматически.
  try {
    const list = realEligibleStrategies().map((s) => ({ slug: s.slug, engine: s.engine, title: s.title, minDeposit: minDepositOf(s) }));
    writeFileSync(join(dataDir, 'predict-real-strategies.json'), JSON.stringify({ updatedAt: new Date().toISOString(), strategies: list }, null, 2));
    // Полный манифест (все активные, не-retired) — единый источник правды для анализатора отчёта.
    const all = STRATEGIES.filter((s) => s.engine && !s.retired).map((s) => ({ slug: s.slug, engine: s.engine, title: s.title, dir: 'predict-' + s.slug }));
    writeFileSync(join(dataDir, 'predict-strategies-all.json'), JSON.stringify({ updatedAt: new Date().toISOString(), strategies: all }, null, 2));
  } catch {
    /* не критично — супервайзер использует встроенный дефолт */
  }

  // Публичный лендинг раздела (описание + hero-шейдер). Без гейта — индексируется.
  app.get('/predict/about', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    const u = getAuthedUser(req);
    return pageShell('Predict — что это и зачем · Robot Claude', renderAbout(), {
      lang: 'ru',
      robots: 'index, follow',
      loginNext: '/predict',
      authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
    });
  });

  // Журнал изменений — ПУБЛИЧНЫЙ (хронология правок раздела).
  app.get('/predict/changelog', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    const u = getAuthedUser(req);
    return pageShell('Журнал изменений — /predict', renderChangelog(), {
      lang: 'ru',
      robots: 'index, follow',
      loginNext: '/predict',
      authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
    });
  });

  app.get('/predict/arb', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const u = getAuthedUser(req);
    return pageShell('Вилки и расхождения — /predict', renderArb(), {
      lang: 'ru',
      autoRefreshSec: 60,
      robots: 'noindex, nofollow',
      loginNext: '/predict',
      authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
    });
  });

  // Дашборд /predict — ПУБЛИЧНЫЙ (открыт всем). Реальная торговля остаётся за доступом.
  app.get('/predict', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const u = getAuthedUser(req);
    return pageShell('/predict — Robot Claude', REAL_TRADING_NOTE + renderOverview(), {
      lang: 'ru',
      autoRefreshSec: 60,
      robots: 'index, follow',
      loginNext: '/predict',
      authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
    });
  });

  // Авто-отчёт здоровья стратегий — ПУБЛИЧНЫЙ (обновляется systemd-таймером каждые 3ч).
  app.get('/predict/learning', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const u = getAuthedUser(req);
    return pageShell('Обучение модели — /predict', renderLearning(), {
      lang: 'ru',
      autoRefreshSec: 300,
      robots: 'noindex, nofollow',
      loginNext: '/predict',
      authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
    });
  });

  app.get('/predict/report', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const u = getAuthedUser(req);
    return pageShell('Авто-отчёт — /predict', renderReport(), {
      lang: 'ru',
      autoRefreshSec: 300,
      robots: 'index, follow',
      loginNext: '/predict',
      authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
    });
  });

  // Страница реальной торговли (оператор-онли, гейт). Пока НИЧЕГО не исполняет —
  // только выбор стратегии и параметров. Ключ сюда не вводится.
  app.get('/predict/real', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const u = gate(req);
    if (!u) {
      return pageShell('/predict — закрытый раздел', renderNoAccess(!!getAuthedUser(req)), { lang: 'ru', robots: 'noindex, nofollow', loginNext: '/predict' });
    }
    const q = (req.query as { err?: string; page?: string } | undefined) ?? {};
    return pageShell('Реальная торговля — /predict', renderRealTrading(readRealConfig(), readRealControl(), q.err), {
      lang: 'ru',
      robots: 'noindex, nofollow',
      autoRefreshSec: 30,
      authed: { displayName: u.displayName, phone: u.phone },
    });
  });

  // Страница реальной статистики одной стратегии (живая сессия + агрегаты + кривая + сделки).
  app.get('/predict/real/:slug', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const u = gate(req);
    if (!u) {
      return pageShell('/predict — закрытый раздел', renderNoAccess(!!getAuthedUser(req)), { lang: 'ru', robots: 'noindex, nofollow', loginNext: '/predict' });
    }
    const slug = String((req.params as { slug?: string }).slug ?? '');
    const s = STRATEGIES.find((x) => x.slug === slug && x.engine && x.realEligible !== false);
    if (!s) {
      reply.code(303).header('location', '/predict/real').send();
      return;
    }
    const pageRaw = (req.query as { page?: string } | undefined)?.page;
    const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
    const ses = readRealSessions().sessions[slug] ?? null;
    return pageShell(`${s.title} — реальная торговля`, renderRealStrategy(s, readRealStatus(slug), ses, page), {
      lang: 'ru',
      robots: 'noindex, nofollow',
      autoRefreshSec: 30,
      authed: { displayName: u.displayName, phone: u.phone },
    });
  });

  // Запуск/остановка боевой стратегии — пишет ТОЛЬКО желаемое состояние (намерение).
  // Реальное исполнение делает супервайзер на сервере; веб systemd/ключ не трогает.
  app.post('/predict/real/start', async (req, reply) => {
    if (!gate(req)) {
      reply.code(403);
      return { ok: false, error: 'forbidden' };
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const slug = String(b.slug ?? '');
    const cfg = readRealConfig();
    const funderOk = !!cfg.funderAddress && /^0x[a-fA-F0-9]{40}$/.test(cfg.funderAddress);
    if (!funderOk || !cfg.keyMask) {
      reply.code(303).header('location', '/predict/real?err=funder').send();
      return;
    }
    // Только eligible-стратегия: engine-движок ИЛИ standalone живой движок, явно помеченный realEligible.
    // Гард сужен под инвариант «в реал идёт только h5m12»: standalone-стратегия без realEligible:true
    // (11 shadow-кандидатов) НЕ может записать намерение running.<slug> — реал-путь для неё закрыт.
    const elig = STRATEGIES.find((s) => s.slug === slug && ((s.engine && s.realEligible !== false) || (s.standalone && s.realEligible === true)));
    if (!elig) {
      reply.code(303).header('location', '/predict/real').send();
      return;
    }
    const c = readRealControl();
    // Несколько стратегий одновременно: добавляем slug в карту (банк делит супервайзер).
    if (!c.running) c.running = {};
    if (!c.running[slug]) c.running[slug] = { since: new Date().toISOString() };
    writeRealControl(c);
    reply.code(303).header('location', '/predict/real').send();
  });

  app.post('/predict/real/stop', async (req, reply) => {
    if (!gate(req)) {
      reply.code(403);
      return { ok: false, error: 'forbidden' };
    }
    const slug = String((req.body as { slug?: string } | undefined)?.slug ?? '');
    const c = readRealControl();
    if (c.running[slug]) {
      delete c.running[slug];
      writeRealControl(c);
    }
    reply.code(303).header('location', '/predict/real').send();
  });

  // Очистка статистики стратегии: пишем намерение в predict-real-clear.json.
  // Супервайзер обнулит логи/статус/стейт (и перезапустит сессию, если она идёт),
  // чтобы статистика накапливалась заново. Веб сам файлы движка не трогает.
  app.post('/predict/real/clear', async (req, reply) => {
    if (!gate(req)) {
      reply.code(403);
      return { ok: false, error: 'forbidden' };
    }
    const slug = String((req.body as { slug?: string } | undefined)?.slug ?? '');
    const elig = STRATEGIES.find((s) => s.slug === slug && s.engine && s.realEligible !== false);
    if (elig) {
      const f = join(dataDir, 'predict-real-clear.json');
      let cur: Record<string, string> = {};
      try {
        if (existsSync(f)) cur = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>;
      } catch {
        cur = {};
      }
      cur[slug] = new Date().toISOString();
      writeFileSync(f, JSON.stringify(cur));
    }
    reply.code(303).header('location', `/predict/real/${slug}`).send();
  });

  app.post('/predict/real/save', async (req, reply) => {
    if (!gate(req)) {
      reply.code(403);
      return { ok: false, error: 'forbidden' };
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const funderRaw = typeof b.funder === 'string' ? b.funder.trim() : '';
    const funderValid = /^0x[a-fA-F0-9]{40}$/.test(funderRaw);
    // Строго: валидный адрес храним; пусто = очистить; невалидное НЕ сохраняем
    // (раньше клали мусор через slice — так в конфиг попал «xb985…36b-<timestamp>»).
    const funder = funderValid ? funderRaw : null;
    const funderBad = funderRaw !== '' && !funderValid;
    const prev = readRealConfig();
    // Ключ: если поле непустое — сохраняем в защищённый файл и обновляем маску.
    // Пустое поле = не менять существующий ключ. НЕ логируем сам ключ.
    let keyMask = prev.keyMask;
    let keySavedAt = prev.keySavedAt;
    const rawKey = typeof b.privkey === 'string' ? b.privkey.trim() : '';
    if (rawKey.length >= 16) {
      keyMask = saveRealKey(rawKey);
      keySavedAt = new Date().toISOString();
    }
    // Relayer/builder креды: сохраняем только если ВСЕ ТРИ непустые.
    let builderMask = prev.builderMask ?? null;
    let builderSavedAt = prev.builderSavedAt ?? null;
    const bk = typeof b.builder_key === 'string' ? b.builder_key.trim() : '';
    const bs = typeof b.builder_secret === 'string' ? b.builder_secret.trim() : '';
    const bp = typeof b.builder_passphrase === 'string' ? b.builder_passphrase.trim() : '';
    if (bk && bs && bp) {
      builderMask = saveBuilderCreds(bk, bs, bp);
      builderSavedAt = new Date().toISOString();
    }
    writeRealConfig({ stakes: prev.stakes, funderAddress: funder, keyMask, keySavedAt, builderMask, builderSavedAt, updatedAt: null });
    reply.code(303).header('location', funderBad ? '/predict/real?err=funder' : '/predict/real').send();
  });

  // ── Боевая статистика мини-теста h5m12 (РЕАЛЬНЫЕ ДЕНЬГИ) — только отображение ──
  // Публичная страница (как и shadow-страница /predict/h5m12): читает готовый боевой
  // статус-файл + баланс кошелька (серверный fetch). Не армит, ордеров не шлёт, деньги
  // не трогает. Зарегистрирована для standalone-стратегии, помеченной realEligible (h5m12).
  for (const s of STRATEGIES.filter((x) => x.standalone && x.realEligible === true && !x.engine)) {
    app.get(`/predict/${s.slug}real`, async (req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      const u = getAuthedUser(req);
      const pageRaw = (req.query as { page?: string } | undefined)?.page;
      const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
      // Боевой статус движка m15live(real): data/predict-<slug>real-status.json.
      const realStatus = readDataJson(`predict-${s.slug}real-status.json`) as PredictStatus | null;
      const armed = !!readRealControl().running?.[s.slug];
      const balance = await fetchRealBalance(); // серверный fetch к localhost:8731 — graceful null
      return pageShell(`🔴 ${s.title} — реальная торговля`, renderH5m12Real(s, realStatus, balance, armed, page), {
        lang: 'ru',
        autoRefreshSec: 30,
        robots: 'noindex, nofollow', // боевой контур — не индексируем
        loginNext: `/predict/${s.slug}real`,
        authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
      });
    });
  }

  for (const s of STRATEGIES) {
    app.get(`/predict/${s.slug}`, async (req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      const u = getAuthedUser(req);
      // СПЕЦ-КЕЙС lagedge (+ shadow-варианты lagedge-tw / lagedge-imb): статус другой формы (shadow↔real)
      // → свой рендер renderLagedge, а не m15live-метрики renderStrategy. Кнопка Арм/Стоп — внутри
      // renderLagedge, и ТОЛЬКО у боевого lagedge (showArm). Варианты tw/imb — view-only (shadow-only).
      if (s.slug.startsWith('lagedge')) {
        const stLag = readDataJson(s.statusFile);
        const armedLag = !!readRealControl().running?.[s.slug];
        const showArm = s.realEligible === true;
        return pageShell(`${s.title} — /predict`, renderLagedge(stLag, armedLag, showArm, s.slug), {
          lang: 'ru',
          autoRefreshSec: 30,
          robots: 'noindex, nofollow',
          loginNext: '/predict',
          authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
        });
      }
      const pageRaw = (req.query as { page?: string } | undefined)?.page;
      const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
      let opControl = '';
      // Операторский блок реал-кнопки — ТОЛЬКО для standalone-стратегии, явно помеченной realEligible
      // (сейчас это только h5m8). Остальные shadow-кандидаты реал-кнопки не показывают: их движки
      // в MODE=shadow ордеров не шлют, а намерение running.<slug> для них теперь и не принимается роутом.
      if (s.standalone && s.realEligible === true && gate(req)) {
        const running = !!readRealControl().running?.[s.slug];
        const wr = (readDataJson(s.statusFile) as { winRate?: number } | null)?.winRate;
        const warn = wr != null ? `Живой винрейт сейчас ${wr}% — ${wr > 53 ? 'выше безубытка' : 'НИЖЕ безубытка, ожидаемый минус'}. ` : '';
        // h5m8 — ЕДИНСТВЕННЫЙ реал-кандидат: боевой движок m15live(real)+шлюз ликвидности с МИНИ-капами
        // (ставка $1, авто-стоп −$8) поднимает супервайзер по этой кнопке (predict-h5m8real.service).
        // Деньги двигает оператор сам (пополнение депозит-кошелька USDC на Polygon).
        const opMsg = `${warn}🔴 МИНИ-ТЕСТ РЕАЛА. Капы (зашиты в боевой движок): ставка <b>$1</b>, авто-стоп <b>−$8</b>, постоянно. Шлюз ликвидности: входим только если стакан реально наливает ставку (иначе пропуск, в PnL не идёт) — так реал не проскальзывает по плохой цене. Перед запуском пополни депозит-кошелёк (USDC на сети Polygon) — без баланса ордера просто пропускаются. Кнопка ставит намерение; супервайзер поднимет боевой движок (m15live в режиме real). «Остановить» — глушит его.`;
        opControl =
          `<div class="pd-card" style="border-color:#5a2e2e"><h2>⚙️ Реальная торговля (оператор)</h2>` +
          `<p class="pd-sub">${opMsg}</p>` +
          (running
            ? `<form method="POST" action="/predict/real/stop"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-stop" style="width:auto;display:inline-block;padding:9px 20px">⏸ Остановить реал</button></form>`
            : `<form method="POST" action="/predict/real/start"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-go" style="width:auto;display:inline-block;padding:9px 20px">▶ Запустить в реал</button></form>`) +
          `<p style="margin-top:14px"><a class="pd-back" style="font-size:15px;background:#3a1518;border:1px solid #d83a3a;color:#ff8a8a;padding:9px 16px;border-radius:8px" href="/predict/${esc(s.slug)}real">🔴 Статистика реальной торговли →</a></p>` +
          `</div>`;
      }
      return pageShell(`${s.title} — /predict`, renderStrategy(s, page, opControl), {
        lang: 'ru',
        autoRefreshSec: 60,
        robots: 'index, follow',
      loginNext: '/predict',
        authed: u ? { displayName: u.displayName, phone: u.phone } : undefined,
      });
    });
    app.get(`/predict/${s.slug}/status.json`, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const st = readStatus(s);
      if (!st) {
        reply.code(503);
        return { ok: false, error: 'no_data_yet' };
      }
      return st;
    });
    app.get(`/predict/${s.slug}/live.json`, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const live = readLive(s);
      if (!live) {
        reply.code(503);
        return { ok: false, error: 'no_live_yet' };
      }
      return live;
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  app.get('/predict/btc-orderbook.json', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ob = obReadStatus();
    if (!ob) {
      reply.code(503);
      return { ok: false, error: 'no_data_yet' };
    }
    return ob;
  });

  // LIVE SYSTEM CONSOLE — «хакерский терминал» для сторис (READ-ONLY дисплей).
  // Стримит объединённый journalctl всех predict-* сервисов через SSE.
  // НЕ управляет движками, НЕ шлёт ордера — только показывает журнал.
  // Доступ — тот же гейт, что у реальной торговли (operator-only).
  // ──────────────────────────────────────────────────────────────────────────

  // Защитный скруббер: вырезаем всё, что выглядит как ключ/токен/секрет.
  // Журнал predict-* их не содержит (только публичные 0x-id ордеров — они ок),
  // но фильтр стоит как страховка, чтобы в кадр сторис ничего не утекло.
  const scrubSecrets = (s: string): string =>
    s
      .replace(/(?:0x)?[a-fA-F0-9]{40}(?![a-fA-F0-9])/g, (m) => (m.length > 50 ? m : m)) // адреса оставляем — публичны
      .replace(/\b(sk|pk|api[_-]?key|secret|token|bearer|priv(?:ate)?[_-]?key|mnemonic|seed|passphrase|password|authorization)\b\s*[:=]\s*\S+/gi, '$1=***')
      .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}/g, 'Bearer ***')
      .replace(/\b[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{12,}\.[A-Za-z0-9_\-]{8,}\b/g, '***jwt***'); // JWT-подобные

  // Короткое имя сервиса для префикса в терминале: predict-lagedge-tw.service → lagedge-tw
  const shortUnit = (u: string): string =>
    String(u || '')
      .replace(/\.service$/, '')
      .replace(/^predict-/, '');

  // Раскраска по содержимому делается на клиенте; сервер шлёт {u,t,m}.
  const fmtTs = (microStr: string): string => {
    const us = Number(microStr);
    if (!Number.isFinite(us) || us <= 0) return '';
    const d = new Date(us / 1000);
    // HH:MM:SS в локали сервера (МСК)
    return d.toLocaleTimeString('ru-RU', { hour12: false, timeZone: 'Europe/Moscow' });
  };

  // ── Тикер: живые данные для неоновой шапки (цены/баланс/счётчики) ──
  type EngineTick = { slug: string; fills: number; signals: number; pnl: number | null; snapAgeSec: number | null; armed: boolean; degraded: boolean; mode: string | null; winRate: number | null };
  const readJsonSafe = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const buildTicker = async (): Promise<Record<string, unknown>> => {
    // Цены BTC/ETH/SOL/XRP/DOGE из статус-файлов коллекторов.
    const spots: Record<string, number> = {};
    const m15 = readJsonSafe(join(dataDir, 'predict-5m15m-status.json'));
    if (m15) {
      const sp = (m15.spots ?? m15.spot ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(sp)) {
        const n = num(v);
        if (n != null) spots[k.toUpperCase()] = n;
      }
      const btc = num((m15 as Record<string, unknown>).btc ?? (m15 as Record<string, unknown>).price);
      if (btc != null && spots.BTC == null) spots.BTC = btc;
    }
    const alt = readJsonSafe(join(dataDir, 'predict-alt-collect-status.json'));
    if (alt) {
      const sp = (alt.spots ?? alt.prices ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(sp)) {
        const n = num(v);
        if (n != null) spots[k.toUpperCase()] = n;
      }
    }

    // Счётчики движков из *-status.json (fills/signals/pnl/snapAge — best-effort).
    const engineSlugs = ['lagedge', 'lagedge-tw', 'lagedge-sol', 'lagedge-xrp', 'lagedge-early', 'lagedge-eth', 'lagedge-doge', 'lagedge-bnb', 'lagedge-imb'];
    const engines: EngineTick[] = [];
    const now = Date.now();
    for (const slug of engineSlugs) {
      const j = readJsonSafe(join(dataDir, `predict-${slug}-status.json`));
      if (!j) continue;
      const tr = (j.trades as unknown[]) ?? [];
      const real = (j.real ?? {}) as Record<string, unknown>;
      const shadow = (j.shadow ?? {}) as Record<string, unknown>;
      const fills = num(j.filledSignals) ?? num(real.n) ?? (Array.isArray(tr) ? tr.length : 0);
      const signals = num(j.sentSignals) ?? num(j.qualifiedSignals) ?? num(shadow.n) ?? (Array.isArray(tr) ? tr.length : 0);
      const pnl = num(real.netPnl) ?? num(shadow.netPnl) ?? null;
      const winRate = num((shadow as Record<string, unknown>).winRatePct) ?? num((real as Record<string, unknown>).winRatePct) ?? num(j.winRatePct) ?? null;
      const armed = j.armed === true || (j.mode === 'real' && j.armed !== false);
      const degraded = j.degraded === true;  // ТОЛЬКО реальный halt; collectorStale (гэп между раундами) — свежесть в snapAge-баре, не красный алярм
      const mode = typeof j.mode === 'string' ? j.mode : null;
      // snapAgeMs (свежий, пишется движком) предпочтительнее, чем разница updatedAt.
      let snapAgeSec: number | null = null;
      const snapMs = num(j.snapAgeMs);
      if (snapMs != null) {
        snapAgeSec = Math.max(0, Math.round(snapMs / 1000));
      } else {
        const upd = j.updatedAt ?? j.ts ?? j.lastTs;
        if (typeof upd === 'string') {
          const t = Date.parse(upd);
          if (Number.isFinite(t)) snapAgeSec = Math.max(0, Math.round((now - t) / 1000));
        } else if (typeof upd === 'number') {
          const t = upd > 1e12 ? upd : upd * 1000;
          snapAgeSec = Math.max(0, Math.round((now - t) / 1000));
        }
      }
      engines.push({ slug, fills: fills ?? 0, signals: signals ?? 0, pnl, snapAgeSec, armed, degraded, mode, winRate });
    }

    // Баланс кошелька (localhost-only мост). Тайм-аут короткий, ошибки молчим.
    let balance: number | null = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 1200);
      const r = await fetch('http://127.0.0.1:8731/balance', { signal: ctrl.signal });
      clearTimeout(to);
      if (r.ok) {
        const jb = (await r.json()) as { usdc?: number };
        if (typeof jb.usdc === 'number') balance = jb.usdc;
      }
    } catch {
      /* мост недоступен — баланс просто скрыт */
    }

    return { ts: now, spots, engines, balance };
  };

  // Тикер-JSON — поллится шапкой страницы.
  app.get('/predict/admin/ticker.json', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const u = gate(req);
    if (!u) {
      reply.code(403);
      return { ok: false, error: 'forbidden' };
    }
    try {
      return { ok: true, ...(await buildTicker()) };
    } catch {
      reply.code(503);
      return { ok: false, error: 'ticker_failed' };
    }
  });

  // SSE-стрим объединённого журнала predict-*: настоящий «летящий tail -f».
  app.get('/predict/admin/logs/stream', async (req, reply) => {
    const u = gate(req);
    if (!u) {
      reply.code(403).header('content-type', 'text/plain; charset=utf-8').send('forbidden');
      return;
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 2000\n');
    raw.write(': live system feed\n\n');
    reply.hijack();

    const sse = (event: string, dataObj: unknown) => {
      try {
        raw.write(`event: ${event}\n`);
        raw.write(`data: ${JSON.stringify(dataObj)}\n\n`);
      } catch {
        /* соединение закрыто */
      }
    };

    // journalctl -f всех predict-* как trader (сайт = trader, видит свои сервисы).
    // Глоб 'predict-*' journalctl разбирает сам; spawn без шелла — без инъекций.
    const child = spawn(
      'journalctl',
      ['-u', 'predict-*', '-f', '-n', '120', '-o', 'json', '--no-pager', '-q'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const msgRaw = d.MESSAGE;
        const msg = typeof msgRaw === 'string' ? msgRaw : Array.isArray(msgRaw) ? msgRaw.map(String).join(' ') : '';
        if (!msg) continue;
        sse('log', {
          u: shortUnit(String(d._SYSTEMD_UNIT ?? d.SYSLOG_IDENTIFIER ?? '?')),
          t: fmtTs(String(d.__REALTIME_TIMESTAMP ?? '')),
          m: scrubSecrets(msg),
        });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', () => sse('sys', { m: 'journalctl error' }));
    child.on('close', () => {
      sse('sys', { m: 'log stream ended' });
      try {
        raw.end();
      } catch {
        /* noop */
      }
    });

    // Heartbeat-комментарий, чтобы прокси не рвал «тихое» соединение.
    const hb = setInterval(() => {
      try {
        raw.write(': hb\n\n');
      } catch {
        /* closed */
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(hb);
      try {
        child.stdout.off('data', onData);
      } catch {
        /* noop */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
    };
    req.raw.on('close', cleanup);
    raw.on('close', cleanup);
  });

  // Страница-терминал: тёмный CRT, авто-скролл, неоновая шапка с тикером.
  app.get('/predict/admin/console', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const u = gate(req);
    if (!u) {
      return pageShell('/predict — закрытый раздел', renderNoAccess(!!getAuthedUser(req)), {
        lang: 'ru',
        robots: 'noindex, nofollow',
        loginNext: '/predict/admin/console',
      });
    }
    return pageShell('LIVE SYSTEM FEED — Robot Claude', renderConsole(), {
      lang: 'ru',
      robots: 'noindex, nofollow',
      authed: { displayName: u.displayName, phone: u.phone },
    });
  });

  // ── LuxAlgo webhook receiver для /predict (ИЗОЛИРОВАН от боевого Track C) ──
  // TradingView LuxAlgo-алерт шлёт сюда POST с маленьким JSON {ind,sig,tf,price,time}.
  // Мы НЕ торгуем по нему здесь — только записываем последний сигнал + кольцо
  // последних в data/predict-lux-signal.json. Его читает изолированный движок
  // predict-lux (своя стратегия luxalgo-signal). Секрет — общий WEBHOOK_SECRET
  // в пути (как у боевого роута), сверка constant-time.
  const LUX_SIGNAL_FILE = join(dataDir, 'predict-lux-signal.json');
  const SIG_DIR: Record<string, 1 | -1> = {
    buy: 1, 'buy+': 1, bull: 1, bullish: 1, long: 1, up: 1,
    sell: -1, 'sell+': -1, bear: -1, bearish: -1, short: -1, down: -1,
  };
  app.post<{ Params: { secret: string }; Body: unknown }>(
    '/predict/lux/:secret',
    { bodyLimit: 8 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const a = Buffer.from(req.params.secret);
      const b = Buffer.from(config.WEBHOOK_SECRET);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ind = String(body.ind ?? '').toLowerCase().slice(0, 16);
      const sigRaw = String(body.sig ?? '').toLowerCase().slice(0, 16);
      const dir = SIG_DIR[sigRaw];
      if (!ind || dir === undefined) {
        return reply.code(400).send({ ok: false, error: 'bad_signal', got: { ind, sig: sigRaw } });
      }
      const tf = String(body.tf ?? '').slice(0, 8);
      const price = Number(body.price);
      const ev = {
        ts: Date.now(),
        ind,
        sig: sigRaw,
        dir,
        tf,
        price: Number.isFinite(price) ? price : null,
      };
      // read-modify-write кольца последних 40 (переживает рестарт сайта).
      let recent: unknown[] = [];
      try {
        if (existsSync(LUX_SIGNAL_FILE)) {
          const prev = JSON.parse(readFileSync(LUX_SIGNAL_FILE, 'utf8')) as { recent?: unknown[] };
          if (Array.isArray(prev.recent)) recent = prev.recent;
        }
      } catch {
        /* битый файл — начинаем кольцо заново */
      }
      recent.push(ev);
      if (recent.length > 40) recent = recent.slice(-40);
      try {
        writeFileSync(LUX_SIGNAL_FILE, JSON.stringify({ updatedAt: ev.ts, last: ev, recent }));
      } catch {
        reply.code(500);
        return { ok: false, error: 'write_failed' };
      }
      return { ok: true, stored: ev };
    },
  );

  // Диагностика: что движок прочитает. Публично (read-only данные сигналов).
  app.get('/predict/lux/feed.json', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (existsSync(LUX_SIGNAL_FILE)) return JSON.parse(readFileSync(LUX_SIGNAL_FILE, 'utf8'));
    } catch {
      /* ignore */
    }
    reply.code(503);
    return { ok: false, error: 'no_signals_yet' };
  });
}

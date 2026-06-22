import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
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
    slug: 'm15live',
    realEligible: false,
    title: '🔵 5M→15M · ЭТАЛОН (заморожена) — контроль',
    tagline: 'ЭТАЛОН: модель обучена ОДИН раз на ранних раундах и заморожена — больше не меняется. Держим её как точку отсчёта: на её фоне видно, помогает ли непрерывное обучение (см. обучающиеся версии). На 111 сделках края нет — монетка (−1пп). Механика входа та же (T-600, ≥8пп, плоско $5).',
    statusEnv: 'PREDICT_M15LIVE_STATUS',
    statusFile: 'predict-m15live-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку (без Кейли). Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'НА ЧЁМ ИГРАЕМ (простыми словами). На Polymarket есть рынок «Будет ли биткоин через 15 минут выше, чем сейчас?». Можно купить «UP» (вырастет) или «DOWN» (упадёт). Цена доли = оценка вероятности рынком: доля UP за $0.55 значит «рынок считает рост на 55%». Угадал — доля гасится за $1 (то есть $0.55 → $1, прибыль ~82%); не угадал — доля сгорает в $0. Раунды идут каждые 15 минут, круглые сутки.',
      'ЧТО ДЕЛАЕТ НАША МОДЕЛЬ. Это формула, обученная на прошлых раундах. За 10 минут до конца раунда она смотрит, как биткоин двигался в последние минуты (на 15-минутном и 5-минутном графиках: скорость, размах, насколько ушёл от стартовой цены) и выдаёт СВОЮ оценку вероятности, что раунд закроется ростом. По сути — «второе мнение» против цены рынка.',
      'КОГДА СТАВИМ. Сравниваем нашу оценку с ценой рынка. Совпадают — пропускаем (преимущества нет, играть не на чем). Если модель считает какую-то сторону заметно вероятнее, чем заложено в цене (расхождение ≥8 процентных пунктов), — покупаем именно её: рынок её «недооценил». То есть ставим только тогда, когда думаем, что рынок ошибается.',
      'КОГДА ВХОДИМ. Ровно за 10 минут до закрытия раунда (колонка «Вход (до конца)» показывает «за 10:00»). Это компромисс: ещё не поздно — исход не предрешён; и уже не рано — свежее поведение цены успело о чём-то сказать.',
      'СКОЛЬКО СТАВИМ — ПЛОСКАЯ СТАВКА. Каждая сделка — фиксированные $5 (без Кейли). Просто и предсказуемо: серия из N проигрышей = N × $5, без раздувания. «Баланс» на карточке показывает накопленный результат, но на размер ставки не влияет.',
      'ЧТО ЗНАЧИТ SHADOW (сейчас именно он). Движок принимает все решения вживую и записывает «я бы поставил столько-то», но РЕАЛЬНЫЙ ОРДЕР НЕ ОТПРАВЛЯЕТ — денег ноль. Это репетиция, которая считает ровно то же, что считала бы реальная торговля: тот же код, те же ставки, тот же банк. Поэтому цифры здесь — 1:1 с реалом, и при переводе в реал ничего не «съедет». Лента наполняется только вперёд, по мере прохождения новых раундов.',
      'ЗАЧЕМ ОНА ЗАМОРОЖЕНА (это ЭТАЛОН, а не боевой кандидат). Мы нарочно держим эту модель неизменной — как измерительную линейку. Сравнивая её с обучающимися версиями, видно, помогает ли непрерывное обучение. На 111 сделках замороженная даёт −1пп (монетка). Поэтому в реал смотрим на обучающиеся версии, а не на этот эталон; в реал вообще переводим только то, что устойчиво выше безубытка (~53%), и только руками оператора с жёсткими капами и авто-стопом −$15.',
    ],
  },
  {
    slug: 'm15band',
    realEligible: false,
    title: '🟢 5M→15M · ОБУЧАЕТСЯ + полоса 3–6пп',
    tagline: 'Обучающаяся модель с фильтром: входит при расхождении с рынком 3–6пп — умеренные сигналы (калиброванная модель редко расходится сильнее). Тест: есть ли край в среднем диапазоне уверенности.',
    statusEnv: 'PREDICT_M15BAND_STATUS',
    statusFile: 'predict-m15band-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку (без Кейли). Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'КОРОТКО. Тот же живой движок и обучающаяся модель (как у m15e4 и охотников; полная механика на карточке m15live — 15-минутный рынок «вверх/вниз», вход за 10 минут до конца, плоская ставка $5). Отличие ОДНО: фильтр на то, НАСКОЛЬКО модель расходится с рынком.',
      'ИДЕЯ ПРОСТЫМИ СЛОВАМИ. Калиброванная модель обычно расходится с рынком на ~3–4 пункта. Этот движок берёт умеренные расхождения 3–6пп: отсекает и совсем мелкие (≈шум, рынок прав), и редкие крупные. Проверяем, есть ли край именно в среднем диапазоне.',
      'ЧЕМ ПОЛЕЗНО. Честная проверка: если преимущество живёт именно в умеренных расхождениях, у этой полосы винрейт будет выше, чем у m15e4 (та же модель, мягкий порог ≥4пп без верхней границы). Если разницы нет — значит срезать верх диапазона не помогает. Всё считается тем же кодом, что реал (1:1), лента — только вперёд.',
      'Деньги: ноль (shadow). Один из набора живых кандидатов; включается в реал кнопкой оператора (с капами и авто-стопом), если докажет винрейт выше безубытка.',
    ],
  },
  {
    slug: 'm15e4',
    realEligible: false,
    title: '🟢 5M→15M · ОБУЧАЕТСЯ + порог ≥4пп',
    tagline: 'Обучающаяся модель с более МЯГКИМ порогом входа: ставим уже при расхождении с рынком ≥4пп (а не ≥8пп). Сделок больше — проверяем, не размывает ли это край. Ставка — плоско $5.',
    statusEnv: 'PREDICT_M15E4_STATUS',
    statusFile: 'predict-m15e4-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку (без Кейли). Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'КОРОТКО. Тот же живой движок и обучающаяся модель (полная механика на карточке m15live — 15-минутный рынок «вверх/вниз», вход за 10 минут до конца, плоско $5). Особенность: самый МЯГКИЙ порог входа — ставим уже при расхождении модели с рынком от 4 пунктов (у полос/охотников пороги другие). Поэтому входов много — это активная обучающаяся версия.',
      'ЗАЧЕМ. Мягкий порог даёт БОЛЬШЕ сделок (быстрее копятся данные), но может разбавлять край более слабыми сигналами. Сравнение с полосами (3–6, 2–4) и охотниками покажет, где баланс «активность vs качество» лучше.',
      'ЧЕМ ПОЛЕЗНО. Это часть «лесенки порогов»: ≥4пп (этот) / полосы 3–6 и 2–4 / охотники. Все на одной обучающейся модели — сравнивая их живой PnL, увидим оптимальную настройку отбора. Деньги: ноль (shadow), флипается в реал кнопкой оператора при доказанном крае.',
    ],
  },
  {
    slug: 'h5m',
    realEligible: false,
    title: '🟣 5-МИНУТНЫЙ рынок · ОХОТНИК',
    tagline: 'Охотник на БЫСТРОМ 5-минутном рынке (не 15-минутном). Своя модель на 5m-раундах. ВПЕРВЫЕ модель обогнала рынок на свежих данных (+2пп) — самый интересный кандидат. Вход по расхождению, коэф 1.5–5, плоско $5 на сделку.',
    statusEnv: 'PREDICT_H5M_STATUS',
    statusFile: 'predict-h5m-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Минимум $1. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Все остальные стратегии — на 15-минутном рынке. Этот — на 5-МИНУТНОМ (раунд каждые 5 минут, втрое чаще). Своя отдельная модель, обученная на 5m-раундах (2100+ раундов, снимки со всего раунда). Охотится: входит в любой момент 5-минутки, когда видит расхождение цены со своей оценкой.',
      'ПОЧЕМУ ИНТЕРЕСНЫЙ. Это ПЕРВАЯ модель, которая на свежих (не виденных) раундах обогнала рынок: 72.3% против 70.3% (+2пп) на большой выборке. На 15m модели были на уровне рынка или ниже. Похоже, на коротком горизонте помогает дисбаланс стакана (кого больше — покупателей или продавцов). И 5m даёт втрое больше данных.',
      'ЧЕСТНО. +2пп точности над рынком — лучшее, что мы видели, но это ещё НЕ доказанная прибыль: чтобы зарабатывать, надо перебить спред и комиссии (на быстром рынке они кусачее). Живой замер в shadow покажет реальный PnL. Деньги: ноль. Если PnL устойчиво плюсовой на дистанции — это первый реальный кандидат в реал.',
    ],
  },
  {
    slug: 'h5m8',
    realEligible: true, // ЕДИНСТВЕННЫЙ кандидат в реал: боевой движок m15live(real)+шлюз ликвидности через systemd-юнит predict-h5m8real (старт по кнопке оператора). Остальные — realEligible:false.
    title: '🔴 5m · ОХОТНИК ≥8пп (крупное расхождение)',
    tagline: 'Тот же 5-минутный охотник, но входит ТОЛЬКО когда расхождение модели и рынка ≥8 проц. пунктов (а не ≥4, как h5m). Гипотеза: чем сильнее модель не согласна с рынком, тем надёжнее сигнал. Один вход за раунд, коэф 1.5–5, плоско $5.',
    statusEnv: 'PREDICT_H5M8_STATUS',
    statusFile: 'predict-h5m8-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Один вход за раунд. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Это та же 5-минутная модель и тот же охотник, что у h5m, с ОДНИМ изменением: порог входа поднят с ≥4пп до ≥8пп. То есть мы входим, только когда наша оценка расходится с ценой рынка минимум на 8 процентных пунктов. Один вход за раунд — как только в окне появляется расхождение ≥8пп, заходим.',
      'ЗАЧЕМ. Проверяем простую гипотезу: «большое расхождение модели и рынка = более сильный сигнал». Если рынок ошибается, то чем дальше его цена от честной оценки — тем больше мы должны зарабатывать. Лесенка — чистое сравнение «порог против порога»: все три (≥4пп h5m, ≥8пп этот, ≥12пп h5m12) входят по одному разу за раунд, отличается только порог. Сравним их винрейт и край.',
      'ЧЕСТНО. На 5-минутном рынке модель калибрована и редко расходится с рынком СИЛЬНО — поэтому входов тут будет МАЛО (возможно, единицы за часы, или почти ноль). Это и есть смысл теста: посмотреть, бывают ли вообще такие расхождения и угадывает ли модель, когда они есть. Может оказаться, что ≥8пп — это уже «шум модели», а не реальная ошибка рынка. Деньги: ноль (shadow).',
    ],
  },
  {
    slug: 'h5m12',
    realEligible: true, // h5m12 — ВТОРОЙ боевой кандидат (2026-06-22): свой реал-движок predict-h5m12real (EDGE>=12пп, $1, стоп -$15), стат /predict/h5m12real.
    title: '🔴 5m · ОХОТНИК ≥12пп (очень крупное расхождение)',
    tagline: 'Самый строгий порог: входим, только когда расхождение модели и рынка ≥12 проц. пунктов. Самые редкие, но самые «уверенные» сигналы. Один вход за раунд, коэф 1.5–5, плоско $5. Проверяем, есть ли край на экстремальных расхождениях.',
    statusEnv: 'PREDICT_H5M12_STATUS',
    statusFile: 'predict-h5m12-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Один вход за раунд. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же 5-минутная модель и охотник, но порог входа ещё выше — ≥12пп. Берём только случаи, когда модель ОЧЕНЬ сильно не согласна с ценой рынка. Один вход за раунд, коэф 1.5–5, ставка $5.',
      'ЗАЧЕМ. Верхняя ступень лесенки порогов ≥4 / ≥8 / ≥12. Если у большого расхождения есть край — он должен быть виден здесь ярче всего (либо его нет вообще). Это прямой тест «крайних» сигналов модели.',
      'ЧЕСТНО. Тут входов будет ЕЩЁ МЕНЬШЕ, чем у ≥8пп — возможно, за смену не наберётся ни одного. Большое расхождение на калиброванной 5m-модели чаще означает «модель переуверена на этом раунде», чем «рынок ошибся». Поэтому вполне реальный исход — ноль сделок или минус. Это честная проверка, а не обещание. Деньги: ноль (shadow).',
    ],
  },
  {
    slug: 'h5m20',
    realEligible: false,
    title: '🔴 5m · ОХОТНИК ≥20пп (экстремальное расхождение)',
    tagline: 'Вершина лесенки порогов: входим, только когда расхождение модели и рынка ≥20 проц. пунктов — самые редкие, экстремальные случаи несогласия. Один вход за раунд, коэф 1.5–5, плоско $5. Крайний тест: есть ли вообще край на таких больших расхождениях.',
    statusEnv: 'PREDICT_H5M20_STATUS',
    statusFile: 'predict-h5m20-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Один вход за раунд. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же 5-минутная модель и охотник, что у h5m/h5m8/h5m12, но порог поднят до самого верха — ≥20пп. Берём ТОЛЬКО случаи, когда модель крайне сильно не согласна с ценой рынка. Один вход за раунд, коэф 1.5–5, ставка $5.',
      'ЗАЧЕМ. Достраиваем лесенку порогов ≥4 / ≥8 / ≥12 / ≥20. На предыдущих ступенях винрейт рос с порогом (49% → 52% → 56%). Вопрос: продолжается ли рост на экстремальных расхождениях, или там уже один шум? Это самый строгий тест гипотезы «больше расхождение = надёжнее».',
      'ЧЕСТНО. Входов тут будет совсем мало — расхождение ≥20пп редкое даже у самоуверенной 5m-модели. Чем крупнее разрыв, тем выше шанс, что это просто «модель сильно переоценила свою уверенность на этом раунде», а не реальная грубая ошибка рынка. Поэтому вполне реальный исход — единицы сделок и/или минус. Это честная проверка края, а не обещание. Деньги: ноль (shadow).',
    ],
  },
  {
    slug: 'h15m8',
    realEligible: false,
    title: '🔵 15m · ОХОТНИК ≥8пп (крупное расхождение)',
    tagline: 'Тот же 15-минутный охотник, что и m15hunter, но входит ТОЛЬКО когда расхождение модели и рынка ≥8 проц. пунктов. Достраиваем лесенку порогов и на 15-минутном рынке — параллельно 5m-лесенке. Один вход за раунд, коэф 1.5–5, плоско $5.',
    statusEnv: 'PREDICT_H15M8_STATUS',
    statusFile: 'predict-h15m8-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Один вход за раунд. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Это та же 15-минутная модель-охотник, что у m15hunter (вход в любой момент раунда по расхождению цены с оценкой), с ОДНИМ изменением: порог входа поднят до ≥8пп. То есть заходим, только когда наша оценка расходится с ценой рынка минимум на 8 процентных пунктов. Один вход за раунд.',
      'ЗАЧЕМ. Достраиваем лесенку порогов и на 15-минутном рынке — параллельно 5m-лесенке (≥8 / ≥12 / ≥20пп). Проверяем ту же гипотезу: помогает ли требование БОЛЬШЕГО расхождения модели с рынком. Чистое сравнение «порог против порога»: у всех трёх 15m-ступеней отличается только порог входа.',
      'ЧЕСТНО. 15-минутный рынок исторически ЭФФЕКТИВНЕЕ: наша 15m-модель-охотник по точности ≈ рынок, отдельного края не показывала. Поэтому ожидания тут СКРОМНЕЕ, чем у 5m-лесенки. Чем выше порог — тем меньше входов. Вполне реальный исход — мало сделок и/или минус. Деньги: ноль (shadow). Это честная проверка, а не обещание прибыли.',
    ],
  },
  {
    slug: 'h15m12',
    realEligible: false,
    title: '🔵 15m · ОХОТНИК ≥12пп (очень крупное расхождение)',
    tagline: 'Та же 15-минутная модель-охотник (m15hunter), но порог входа выше — ≥12пп. Более редкие, более «уверенные» сигналы. Один вход за раунд, коэф 1.5–5, плоско $5. Средняя ступень 15m-лесенки порогов.',
    statusEnv: 'PREDICT_H15M12_STATUS',
    statusFile: 'predict-h15m12-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Один вход за раунд. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же 15-минутная модель-охотник, что у m15hunter, но порог входа ещё выше — ≥12пп. Берём только случаи, когда модель сильно не согласна с ценой рынка. Один вход за раунд, коэф 1.5–5, ставка $5.',
      'ЗАЧЕМ. Средняя ступень 15m-лесенки порогов (≥8 / ≥12 / ≥20пп), которую мы строим параллельно 5m-лесенке. Проверяем, помогает ли требование БОЛЬШЕГО расхождения модели с рынком именно на 15-минутном рынке — там, где он исторически крепче.',
      'ЧЕСТНО. 15-минутный рынок исторически ЭФФЕКТИВНЕЕ, и наша 15m-модель-охотник по точности ≈ рынок (отдельного края не показывала). Чем выше порог — тем меньше входов: тут их будет ещё меньше, чем у ≥8пп. Вполне реальный исход — мало сделок и/или минус. Деньги: ноль (shadow). Это честная проверка, а не обещание прибыли.',
    ],
  },
  {
    slug: 'h15m20',
    realEligible: false,
    title: '🔵 15m · ОХОТНИК ≥20пп (экстремальное расхождение)',
    tagline: 'Вершина 15m-лесенки порогов: входим, только когда расхождение модели и рынка ≥20 проц. пунктов — самые редкие, экстремальные случаи несогласия. Один вход за раунд, коэф 1.5–5, плоско $5. Крайний тест края на 15-минутном рынке.',
    statusEnv: 'PREDICT_H15M20_STATUS',
    statusFile: 'predict-h15m20-status.json',
    liveFile: '',
    showStakeCol: true,
    hasLive: false,
    recommendedReal: 100,
    recommendedRealNote: 'плоская ставка $5 на сделку. Один вход за раунд. Авто-стоп −$15, до ~12 ордеров за сессию',
    standalone: true,
    description: [
      'ЧЕМ ОТЛИЧАЕТСЯ. Та же 15-минутная модель-охотник, что у m15hunter/h15m8/h15m12, но порог поднят до самого верха — ≥20пп. Берём ТОЛЬКО случаи, когда модель крайне сильно не согласна с ценой рынка. Один вход за раунд, коэф 1.5–5, ставка $5.',
      'ЗАЧЕМ. Вершина 15m-лесенки порогов (≥8 / ≥12 / ≥20пп), достраиваемой параллельно 5m-лесенке. Если у большого расхождения есть край — на 15-минутном рынке он должен быть виден здесь ярче всего (либо его нет вообще). Прямой тест «экстремальных» сигналов модели.',
      'ЧЕСТНО. 15-минутный рынок исторически ЭФФЕКТИВНЕЕ, чем 5-минутный, а наша 15m-модель-охотник по точности ≈ рынок — отдельного края не показывала. Расхождение ≥20пп тут совсем редкое: за смену может не набраться ни одной сделки. Чем крупнее разрыв, тем выше шанс, что это «модель переуверена на этом раунде», а не ошибка рынка. Вполне реальный исход — мало сделок и/или минус. Деньги: ноль (shadow). Это честная проверка, а не обещание прибыли.',
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
  const stat = st
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
  const rows = STRATEGIES.filter((s) => s.standalone).map((s) => {
    const st = readStatus(s); const rounds = st?.rounds ?? 0; const wr = st?.winRate ?? 0;
    const netPnl = st?.netPnl ?? 0;
    let be: number | null = null;
    if (st?.coefBuckets) { let sn = 0, sb = 0; for (const b of st.coefBuckets) if (b.n > 0 && b.breakeven != null) { sn += b.n; sb += b.breakeven * b.n; } be = sn > 0 ? sb / sn : null; }
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

// Таблица кандидатов («система поощрения»): ранжируем живые движки по КРАЮ (винрейт − безубыток).
// Кто устойчиво обгоняет безубыток на достаточной выборке — лидер 🏆, он и идёт в реал.
function leaderboard(): string {
  const MIN_SAMPLE = 30;
  const rows = STRATEGIES.filter((s) => s.standalone).map((s) => {
    const st = readStatus(s);
    const rounds = st?.rounds ?? 0;
    const winRate = st?.winRate ?? 0;
    let be: number | null = null;
    if (st?.coefBuckets) {
      let sn = 0, sb = 0;
      for (const b of st.coefBuckets) if (b.n > 0 && b.breakeven != null) { sn += b.n; sb += b.breakeven * b.n; }
      be = sn > 0 ? sb / sn : null;
    }
    const edge = be != null && rounds > 0 ? winRate - be : null;
    const netPnl = st?.netPnl ?? 0;
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

function renderOverview(): string {
  const cards = STRATEGIES.map((s) => strategyCard(s, readStatus(s))).join('');
  return (
    STYLES +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>Песочница стратегий</h1><span class="pd-fresh pd-fresh-stale" style="font-size:13px;padding:3px 10px">📄 Бумажная торговля</span></div>` +
    `<p class="pd-sub">Здесь мы тестируем торговые гипотезы на реальных рынках Polymarket (BTC Up/Down, 5 мин) без реальных денег. ` +
    `Каждая стратегия — отдельная идея со своей честной статистикой: показываем всё как есть, включая убытки. ` +
    `После ригорной проверки восьми гипотез осталась одна с доказанным на истории краем — <b>PMOPT</b> (переоценка хвостов крипто-страйков). Она проходит форвард-подтверждение ниже. Реальных денег нет до подтверждения.</p>` +
    `<p style="margin:-8px 0 20px">` +
    `<a class="pd-arrow" href="/predict/arb">🎯 Вилки и расхождения →</a>&nbsp;&nbsp;` +
    `<a class="pd-arrow" href="/predict/learning">🧠 Обучение модели (учится ли) →</a>&nbsp;&nbsp;` +
    `<a class="pd-arrow" href="/predict/report">📊 Авто-отчёт здоровья стратегий →</a>&nbsp;&nbsp;` +
    `<a class="pd-arrow" href="/predict/changelog">📝 Журнал изменений →</a>&nbsp;&nbsp;` +
    `<a class="pd-arrow" href="/predict/about">✨ О разделе →</a>&nbsp;&nbsp;` +
    `<a class="pd-arrow" href="https://t.me/dboykod" target="_blank" rel="noopener">💡 Предложить идею или стратегию →</a>` +
    `</p>` +
    leaderboard() +
    `<div class="pd-cards">${cards}</div>` +
    globalFeed() +
    `</div>`
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
  `<div class="pd-card" style="border-color:#2e3a2e">` +
  `<h2>⚙️ Реальная торговля</h2>` +
  `<p class="pd-sub">Сейчас всё в режиме симуляции (paper). Когда будешь готов — настрой подключение и выбери стратегию для боевого режима на отдельной странице.</p>` +
  `<p style="margin-top:12px"><a class="pd-back" style="font-size:15px" href="/predict/real">→ Перейти к настройке реальной торговли</a></p>` +
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

  const launchCard =
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
    `<div class="pd-card" style="border-color:#5a2e2e"><h2>Боевой кандидат — мини-тест (отдельный движок)</h2>` +
    `<p class="pd-sub">Эти стратегии запускают <b>боевой движок m15live</b> с зашитыми мини-капами и шлюзом ликвидности (не Kelly-делёж банка). Управление — на странице самой стратегии.</p>` +
    standaloneReal.map((s) => {
      const on = activeSet.has(s.slug);
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

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
};

const STRATEGIES: StrategyDef[] = [
  {
    slug: 'eglate',
    engine: 'endgame-late',
    realEligible: true,
    title: 'Эндшпиль · Келли (60с)',
    tagline: 'Тот же эндшпиль, но входим только в последние 60 секунд раунда',
    statusEnv: 'PREDICT_EGLATE_STATUS_PATH',
    statusFile: 'predict-eglate-status.json',
    liveFile: 'predict-eglate-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Это «эндшпиль (z-оценка)» с единственным изменением: входим только когда до закрытия раунда осталось ≤ 60 секунд (обычный эндшпиль начинает искать вход уже за 90с). Всё остальное — оценка вероятности, фильтры цены и дисконта — идентично. Это честный A/B-тест одной гипотезы.',
      'Откуда гипотеза. Разбор 111 входов обычного эндшпиля показал: единственный признак, который отличает выигрыши от проигрышей, — это МОМЕНТ входа. Входы более чем за минуту до закрытия в среднем почти ничего не приносили (а самая ранняя зона, >75с, вообще работала в ноль) и держали бо́льшую часть проигрышей. Чем раньше входим — тем больше времени у цены успеть развернуться, и тем чаще «почти решённый» исход всё-таки переворачивается.',
      'Что проверяем. Срезав раннюю зону, мы должны получить меньше входов, но выше процент выигрышей и ровнее кривую. Сравниваем напрямую с вариантом «90с» и с «прайм»-вариантом (45с) на тех же самых рынках. Честно: это всё ещё та же гипотеза лага тонкого стакана, преимущество не гарантировано — судим по статистике на достаточной выборке.',
      'Размер ставки — дробный Келли (1/4): ставка = ¼ · f · банк (старт банка $100), где f = p − (1−p)/b, b — коэффициент входа. Ключевое: p — это НЕ оценка модели, а ФАКТИЧЕСКИЙ процент выигрышей самой стратегии (само-калибровка: после 20 сделок берём wins/total, до этого — осторожный приор 0.74). Потолок ставки — доля банка (~30%), а не фикс-сумма, поэтому ставка реально компаундит вместе с банком и меняется от сигнала к сигналу (дешевле фаворит и больше запас — больше ставка; нет перевеса f≤0 — минимум). Келли не создаёт преимущества, лишь превращает уже имеющееся в плавный рост и страхует от разорения.',
    ],
  },
  {
    slug: 'egsnap',
    engine: 'endgame-snap',
    realEligible: true,
    title: 'Эндшпиль · Келли (45с)',
    tagline: 'Эндшпиль с входом только в последние 45 секунд — там, где сидит весь плюс',
    statusEnv: 'PREDICT_EGSNAP_STATUS_PATH',
    statusFile: 'predict-egsnap-status.json',
    liveFile: 'predict-egsnap-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Самый узкий из вариантов эндшпиля: входим только в последние 45 секунд раунда. По разбору прошлых входов именно окно ~15–45 секунд до закрытия дало лучший результат (доля выигрышей 86–88% против ~78% на ранних входах), тогда как входы раньше минуты практически не приносили прибыли. Логика входа та же, что у обычного эндшпиля, — отличается только окно времени.',
      'Это вторая точка в A/B-лесенке: обычный эндшпиль ищет вход за 90с, «поздний» — за 60с, этот — за 45с. Три стратегии торгуют одни и те же рынки, разница только в моменте входа — так мы чисто измеряем, насколько позднее окно действительно снижает проигрыши.',
      'Честно: чем уже окно, тем меньше входов — возможно, прибыльных сделок станет совсем мало, и тогда выигрыш в проценте не окупит редкость. Это и проверяем. Преимущество не гарантировано; вывод — по статистике, параметры не публикуем.',
      'Размер ставки — дробный Келли (1/4): ставка = ¼ · f · банк (старт банка $100), где f = p − (1−p)/b, b — коэффициент входа. Ключевое: p — это НЕ оценка модели, а ФАКТИЧЕСКИЙ процент выигрышей самой стратегии (само-калибровка: после 20 сделок берём wins/total, до этого — осторожный приор 0.74). Потолок ставки — доля банка (~30%), а не фикс-сумма, поэтому ставка реально компаундит вместе с банком и меняется от сигнала к сигналу (дешевле фаворит и больше запас — больше ставка; нет перевеса f≤0 — минимум). Келли не создаёт преимущества, лишь превращает уже имеющееся в плавный рост и страхует от разорения.',
    ],
  },
  {
    slug: 'egprog',
    engine: 'endgame-prog',
    realEligible: true,
    title: 'Эндшпиль · Келли (90с)',
    tagline: 'Эндшпиль + размер ставки по дробному Келли (1/4) от банка $100 — плавный рост без разгона',
    statusEnv: 'PREDICT_EGPROG_STATUS_PATH',
    statusFile: 'predict-egprog-status.json',
    liveFile: 'predict-egprog-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Вход — как у обычного эндшпиля (недооценённая почти решённая сторона в последние секунды, окно ≤90с). Отличие — в РАЗМЕРЕ ставки. Раньше тут был «догон» (повышали ставку при просадке) — мы его убрали: догон раздувает риск и ничего не чинит. Теперь размер считается по критерию Келли.',
      'Как считается ставка (дробный Келли 1/4). Стартовый банк — $100; банк = старт + накопленный PnL. Формула Келли даёт оптимальную долю банка f = p − (1−p)/b, где p — вероятность выигрыша, b = (1−цена)/цена — коэффициент. Ставим ЧЕТВЕРТЬ от этой доли (1/4 Келли — чтобы сгладить колебания), умноженную на текущий банк. Чем сильнее перевес и выгоднее коэффициент — тем больше ставка; нет перевеса (f≤0) — минимум. Потолок ставки — ДОЛЯ банка (~30%), а не фикс-сумма: поэтому ставка компаундит вместе с банком (банк растёт → ставка растёт; банк просел → ставка САМА уменьшается) и реально варьируется от раунда к раунду.',
      'Само-калибровка вероятности. Вместо «книжной» оценки z-модели (она оказалась завышенной) для p берём ФАКТИЧЕСКИЙ процент выигрышей этой стратегии на накопленной выборке (после 20 раундов; до этого — осторожный прайор 0.74). То есть Келли опирается на реальную статистику входов, а не на самоуверенную модель.',
      'Честно: рост будет ТОЛЬКО если у самого входа эндшпиля реально положительное преимущество. Келли НЕ создаёт преимущества — он лишь превращает уже существующее преимущество в плавный геометрический рост и страхует от разорения (ставка не разгоняется в серию проигрышей). Если преимущества нет — капитал стоит на месте (а не сливается догоном). Это эксперимент в симуляции; вывод — по статистике.',
    ],
  },
  {
    slug: 'egz2',
    engine: 'endgame-z2',
    realEligible: true,
    title: 'Эндшпиль · Келли (сильный сигнал z≥2)',
    tagline: 'egprog, но вход только при сильном сигнале (z≥2) — концентрируем преимущество',
    statusEnv: 'PREDICT_EGZ2_STATUS_PATH',
    statusFile: 'predict-egz2-status.json',
    liveFile: 'predict-egz2-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Прямая копия «Эндшпиль · Келли (90с)» с одним изменением: входим ТОЛЬКО при сильном сигнале z ≥ 2.0 (обычный egprog входит уже при z ≥ 1.0). Окно 90с, Kelly, банк $100 — идентичны.',
      'Откуда гипотеза. Разбор 213 входов egprog по корзинам: при слабом сигнале (z<1.5, 150 входов) край около нуля/минус; при сильном (z≥2, 25 входов) винрейт ~88% при средней цене 65–70 → край +18–23пп. Когда наш сигнал говорит «исход почти решён», а цена ещё не поднялась — это лаг тонкого стакана, наша точка преимущества.',
      'Что проверяем: держит ли фильтр z≥2 это преимущество ВНЕ прошлой выборки (чтобы не было подгонки под историю). Меньше входов (~12% слотов), но выше качество. Подтвердится край — кандидат №1 на реальный запуск. Paper, банк $100.',
      'Размер ставки — дробный Келли (1/4) от банка $100, p — фактический винрейт стратегии (само-калибровка), потолок 30% банка.',
    ],
  },
  {
    slug: 'egsess',
    engine: 'endgame-sess',
    realEligible: true,
    title: 'Эндшпиль · Келли (Азия+Европа)',
    tagline: 'egprog, но торгуем только в прибыльные сессии (00–13 UTC), без US-сессии',
    statusEnv: 'PREDICT_EGSESS_STATUS_PATH',
    statusFile: 'predict-egsess-status.json',
    liveFile: 'predict-egsess-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Прямая копия «Эндшпиль · Келли (90с)» с одним фильтром: торгуем ТОЛЬКО в 00:00–13:00 UTC (азиатская и европейская сессии). US-сессию (13:00–21:00) и вечер пропускаем.',
      'Откуда гипотеза. Разбор 225 входов egprog по часам: Азия (00–07) дала край +12пп, Европа (07–13) +6пп (+$92 вместе), а US-сессия (13–21) — край −11пп (−$13). Вероятная причина: US — пик активности Polymarket, быстрые боты мгновенно переоценивают цену → наш «лаг тонкого стакана» исчезает, плюс выше волатильность. В Азию/Европу стакан тоньше и медленнее — лаг работает.',
      'Что проверяем: держится ли сессионный перевес ВНЕ исходной выборки (на новых данных, чтобы не было подгонки под историю). Если да — это самый сильный из найденных рычагов, и его можно совмещать с фильтром по силе сигнала (z≥2). Paper, банк $100, размер по Kelly.',
    ],
  },
  {
    slug: 'egfav',
    engine: 'favorite-strong',
    realEligible: true,
    title: 'Сильный фаворит (0.82–0.92) + Kelly',
    tagline: 'Чистый тест: покупаем только сильного фаворита, ставку адаптирует Kelly',
    statusEnv: 'PREDICT_EGFAV_STATUS_PATH',
    statusFile: 'predict-egfav-status.json',
    liveFile: 'predict-egfav-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Самая простая гипотеза без z-сигнала: каждый раунд покупаем сторону-фаворита, чья цена в узкой полосе 0.82–0.92 (сильный, но не «почти 1.0»), и держим до конца. Размер ставки полностью отдан дробному Kelly от банка $100.',
      'Зачем. На рынках ставок есть известный перекос favorite-longshot: сильных фаворитов толпа слегка НЕ-дооценивает, и они выигрывают чуть чаще своей цены. Намёк в наших данных: входы egprog по 0.80–0.90 давали винрейт 88% при цене 80 → край +8пп. Здесь проверяем это ЧИСТО, без сигнала.',
      'Как это сочетается с Kelly. Если перекос реален (фактический винрейт > цены) — после 20 сделок Kelly начнёт увеличивать ставку и капитал пойдёт в рост. Если винрейт ≈ цене (перекоса нет) — Kelly честно держит минимум, кривая стоит на месте. То есть это одновременно тест гипотезы и проверка идеи «коэффициент + Kelly». Paper, банк $100.',
    ],
  },
  {
    slug: 'egfavs',
    engine: 'favorite-strong-sess',
    realEligible: true,
    title: 'Сильный фаворит · Азия+Европа',
    tagline: 'Комбо: сильный фаворит (0.82–0.92) + только прибыльные сессии (00–13 UTC) + Kelly',
    statusEnv: 'PREDICT_EGFAVS_STATUS_PATH',
    statusFile: 'predict-egfavs-status.json',
    liveFile: 'predict-egfavs-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Комбинация двух наших гипотез сразу: покупаем только сильного фаворита 0.82–0.92 (возможный favorite-longshot bias) И только в азиатскую/европейскую сессию 00:00–13:00 UTC (где у эндшпиля жил +край), размер — дробный Kelly.',
      'Идея: если оба перекоса реальны, их сложение должно дать более чистый и устойчивый рост, чем каждый по отдельности. Это самый «нагруженный» фильтрами тест.',
      'Честно: это стекинг ДВУХ пока неподтверждённых фильтров — есть риск подгонки под прошлое. Поэтому смотрим его в связке с «чистыми» одиночными тестами (egfav — только фаворит, egsess — только сессия): если комбо растёт, а одиночные нет, к выводам относимся осторожно. Paper, банк $100.',
    ],
  },
  {
    slug: 'egparlay',
    engine: 'endgame-parlay',
    realEligible: true,
    title: 'Эндшпиль · парлей',
    tagline: 'Анти-мартингейл: растём на сериях выигрышей, проигрыш стоит мало',
    statusEnv: 'PREDICT_EGPARLAY_STATUS_PATH',
    statusFile: 'predict-egparlay-status.json',
    liveFile: 'predict-egparlay-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Вход — эндшпиль в прайм-окне (последние 45с, где по отчёту живёт преимущество). Система ставки — анти-мартингейл (парлей) с капом: после выигрыша поднимаем ставку (×2), и так до 3 побед подряд — затем фиксируем прибыль и возвращаемся к базе $1. После ЛЮБОГО проигрыша — сразу база.',
      'Смысл: ставка раздувается только на удаче (когда играем «деньгами рынка» на серии), а проигрыш всегда стоит мало. Жёсткий потолок ставки $8 — без разгона. На высоком проценте выигрышей эндшпиля серии случаются часто, поэтому кривая должна расти ступеньками, а просадки — оставаться мелкими.',
      'Честно: система ставок не создаёт преимущества, она задаёт форму кривой. Это эксперимент по money-management; рост на дистанции возможен, только если у входа эндшпиля есть реальное преимущество. Paper, база $1.',
    ],
  },
  {
    slug: 'egoscar',
    engine: 'endgame-oscar',
    realEligible: true,
    title: 'Эндшпиль · Oscar’s Grind',
    tagline: 'Классика: цель +$1 за серию, ставку поднимаем только после выигрыша',
    statusEnv: 'PREDICT_EGOSCAR_STATUS_PATH',
    statusFile: 'predict-egoscar-status.json',
    liveFile: 'predict-egoscar-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Вход — эндшпиль в прайм-окне (последние 45с, где по отчёту живёт преимущество). Система ставки — Oscar’s Grind (известная низковолатильная прогрессия). Цель — заработать +$1 за «серию». Ставку повышаем (+$1) ТОЛЬКО после выигрыша; после проигрыша оставляем как есть (не догоняем). Как только серия вышла в +$1 — сброс к базе $1.',
      'Смысл: «медленно затягиваем» прибыль по чуть-чуть, не разгоняя ставку на проигрышах. Это одна из самых аккуратных классических систем по соотношению ровности и риска. Жёсткий потолок ставки снят — рост естественно ограничивается сбросом при достижении цели +$1.',
      'Честно: матожидание система не меняет — она сглаживает кривую. Стабильный рост на дистанции возможен только при реальном преимуществе входа. Paper, база $1.',
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
  maxLossStreak?: number; // макс. серия проигрышей подряд (риск для прогрессий)
  maxWinStreak?: number; // макс. серия выигрышей подряд
  avgCoef?: number | null; // средний коэффициент входа (1/цена)
  trapClosed?: number; // dual-leg-trap: раундов с захлопнутой ловушкой
  oneLegged?: number; // dual-leg-trap: раундов с одной ногой
  marketOutcomes: { up: number; down: number };
  lastRoundAt?: number | null;
  recentRounds?: RecentRound[];
  equityCurve: { t: number | null; slug: string; pnl: number; cumulative: number }[];
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
    `var p=d.position;if(!p){$('pl-pos').innerHTML='⚪ Открытой позиции нет — ждём сигнал';}else if(p.side==='BOTH'){$('pl-pos').innerHTML='🟢 Ловушка: обе ноги набраны · вложено '+usd(p.stake)+(d.lockedProfit!=null?(' · заперта прибыль +$'+d.lockedProfit+'/акция'):'');}else{$('pl-pos').innerHTML='🟢 В сделке: <b class=\"'+(p.side==='UP'?'pd-up':'pd-down')+'\">'+p.side+'</b> · ставка '+usd(p.stake)+(p.entryCoef?(' · коэф '+p.entryCoef):'');}` +
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
function equitySvg(points: PredictStatus['equityCurve']): string {
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
function equityFromRounds(rounds: RecentRound[], slug: string): PredictStatus['equityCurve'] {
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
  const hasEdge = showMetric && rounds.some((r) => r.edge != null);
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
    (hasEntry ? `<th ${right}>Вход</th>` : '') +
    `<th>Исход</th><th ${right}>PnL</th><th ${right}>Когда</th></tr>`;
  const rows = rounds
    .map((r) => {
      const stratCell = showStrategy ? `<td class="pd-muted-td">${esc(r._strategy ?? '')}</td>` : '';
      const edgeCells = hasEdge ? `<td ${right}>${r.prob != null ? r.prob + '%' : '—'}</td>` : '';
      const coefCell = hasCoef ? `<td class="pd-muted-td" ${right}>${r.coef != null ? r.coef.toFixed(2) : '—'}</td>` : '';
      const entryCell = hasEntry
        ? `<td class="pd-muted-td" ${right}>${r.entrySecLeft != null ? mmss(r.entrySecLeft) : '—'}</td>`
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
  `Параметры стратегии не публикуются.</div>`;

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
  return (
    `<a class="pd-scard${s.retired ? ' pd-scard-off' : ''}" href="/predict/${s.slug}">` +
    `<h3>${esc(s.title)}${retiredBadge}</h3>` +
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

function renderOverview(): string {
  const cards = STRATEGIES.map((s) => strategyCard(s, readStatus(s))).join('');
  return (
    STYLES +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>/predict</h1></div>` +
    `<p class="pd-sub">Экспериментальные стратегии на prediction-маркете Polymarket (BTC Up/Down, 5 мин). ` +
    `Каждая стратегия — отдельная гипотеза со своей честной статистикой (убытки тоже показываем). ` +
    `Всё в paper-режиме и изолировано от основного бота — это только просмотр.</p>` +
    `<p style="margin:-8px 0 20px"><a class="pd-arrow" href="/predict/report">📊 Авто-отчёт здоровья стратегий →</a>&nbsp;&nbsp;<a class="pd-arrow" href="/predict/about">✨ О разделе →</a></p>` +
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

function renderStrategy(s: StrategyDef, page = 1): string {
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
    `<span class="pd-badge">Фаза ${st.phase.number} · ${esc(st.phase.label)}</span>` +
    freshnessPill(st.updatedAt) +
    `</div>`;

  if (st.rounds === 0) {
    return (
      STYLES +
      `<div class="pd-wrap">${back}${header}<p class="pd-sub">${esc(s.tagline)}</p>` +
      (s.hasLive ? livePanel(s) : '') +
      descCard +
      `<div class="pd-empty"><b style="color:#cfd6e0">Накапливаем статистику.</b><br>` +
      `Движок работает в paper-режиме. Завершённые раунды и кривая PnL появятся здесь по мере накопления.</div>` +
      PAPER_NOTE +
      `</div>`
    );
  }

  const pf = st.profitFactor === null ? '—' : st.profitFactor.toFixed(2);
  const updated = new Date(st.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' });
  const netAccent = st.netPnl > 0 ? 'pos' : st.netPnl < 0 ? 'neg' : 'muted';
  // Ключевые метрики для money-management: просадка, серии подряд, средний коэф.
  const ddCard = statCard('Max drawdown', `$${st.maxDrawdown.toFixed(2)}`, 'muted');
  const lossStreakCard = st.maxLossStreak != null ? statCard('Макс. серия −', String(st.maxLossStreak), 'muted') : '';
  const winStreakCard = st.maxWinStreak != null ? statCard('Макс. серия +', String(st.maxWinStreak), 'muted') : '';
  const coefCard = st.avgCoef != null ? statCard('Ср. коэф.', st.avgCoef.toFixed(2), 'muted') : '';
  const stakeCard = st.avgStake != null ? statCard('Ср. ставка', `$${st.avgStake.toFixed(2)}`, 'muted') : '';

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
    trapCard +
    statCard('Режим', st.mode === 'paper' ? 'Paper' : esc(st.mode), 'muted') +
    `</div>` +
    `<div class="pd-card"><h2>Кривая накопленного PnL</h2>${equitySvg(st.equityCurve)}` +
    `<div class="pd-foot">Выигрышей: ${st.wins} · Проигрышей: ${st.losses}` +
    (s.isTrap && st.trapClosed != null ? ` · 🔒 замков: ${st.trapClosed} · одна нога: ${st.oneLegged ?? 0}` : '') +
    ` · Исходы рынка ↑${st.marketOutcomes.up}/↓${st.marketOutcomes.down}</div></div>` +
    roundsTable +
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
  try {
    const p = join(dataDir, `predict-real-${slug}-status.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as PredictStatus;
  } catch {
    /* нет данных */
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

// Рекомендуемый минимальный банк (доля депозита) под стратегию, чтобы Kelly работал
// нормально. Причина: минимальная заявка Polymarket ≈ 5 акций ≈ 5×цена ($3–4.5). Чтобы
// этот пол был малой долей банка (а не упирался и не отклонялся), нужен запас. Прогрессии
// и дорогие фавориты требуют чуть больше. Новые стратегии — дефолт $20.
const MIN_DEPOSIT_BY_SLUG: Record<string, number> = {
  eglate: 20, egprog: 20, egsnap: 20, egz2: 20, egsess: 20,
  egparlay: 25, egoscar: 25, egfav: 25, egfavs: 25,
};
function minDepositOf(s: StrategyDef): number {
  return s.minDeposit ?? MIN_DEPOSIT_BY_SLUG[s.slug] ?? 20;
}

// Карточка стратегии в боевой панели: результат + кнопка Запуск/Стоп.
// Активные — с зелёной рамкой и живым статусом; неактивные — приглушённые (блюр).
const REAL_STATE_RU: Record<string, string> = { running: 'идёт торговля', starting: 'запуск…', low_deposit: 'ждёт пополнения', error: 'ошибка', idle: 'остановлена', done: 'остановлена' };
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
    stateBadge = `<span class="pd-rstate ${low ? 'pd-rstate-low' : 'pd-rstate-on'}">${low ? '⚠ ' : '● '}${esc(REAL_STATE_RU[ses.state] ?? ses.state)}</span>`;
    const pnlCol = (ses.pnl ?? 0) >= 0 ? '#4ad991' : '#e5616c';
    live =
      `<div style="font-size:12.5px;color:#9aa4b2;margin-bottom:8px">` +
      `Сессия: сделок <b style="color:#e6e9ef">${ses.fills ?? 0}</b> · PnL <b style="color:${pnlCol}">${fmtUsd(ses.pnl ?? 0)}</b>` +
      (ses.bank != null ? ` · банк <b style="color:#e6e9ef">$${ses.bank.toFixed(2)}</b>` : '') +
      `</div>` +
      (low && ses.reason ? `<div style="font-size:12px;color:#e5c061;margin-bottom:8px">💰 ${esc(ses.reason)}</div>` : '');
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
    `<div class="pd-foot" style="margin:6px 0 2px">Рекоменд. минимум под стратегию: <b style="color:#9aa4b2">$${minDep}</b>${isActive && ses?.bank != null && ses.bank < minDep ? ` · <span style="color:#e5c061">доля $${ses.bank.toFixed(2)} ниже минимума</span>` : ''}</div>` +
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

  // Рекомендуемый депозит под активный набор: при равном делёже каждой нужна её доля ≥ минимума,
  // значит депозит ≥ N × (наибольший минимум среди активных).
  const activeStrats = eligible.filter((s) => activeSet.has(s.slug));
  const recDeposit = activeStrats.length > 0 ? activeStrats.length * Math.max(...activeStrats.map(minDepositOf)) : null;
  const depositLow = deposit != null && recDeposit != null && deposit < recDeposit;

  const splitNote = activeCount > 1 && deposit != null && perShare != null
    ? `<p class="pd-foot" style="margin:0 0 14px">Банк делится поровну: депозит $${deposit.toFixed(2)} ÷ ${activeCount} = <b>$${perShare.toFixed(2)}</b> на стратегию. Суммарный риск не превышает кошелёк.</p>`
    : activeCount === 1 && deposit != null
      ? `<p class="pd-foot" style="margin:0 0 14px">Активна одна стратегия — банк Kelly = весь депозит $${deposit.toFixed(2)}.</p>`
      : `<p class="pd-foot" style="margin:0 0 14px">Запускай любое число стратегий. Банк Kelly делится поровну между активными (депозит ÷ число активных) — суммарные ставки не превысят кошелёк. У каждой стратегии свой рекомендуемый минимум (см. карточку): ниже него она ждёт пополнения.</p>`;

  // Сводка по депозиту/результату — вверху страницы.
  const summaryCard =
    `<div class="pd-card"><div class="pd-grid">` +
    statCard('Депозит', deposit != null ? `$${deposit.toFixed(2)}` : '—', deposit != null ? (depositLow ? 'neg' : undefined) : 'muted') +
    statCard('Активных стратегий', String(activeCount)) +
    (recDeposit != null ? statCard('Реком. депозит', `$${recDeposit}`, depositLow ? 'neg' : 'muted') : '') +
    statCard('Реальный PnL (всего)', fmtUsd(totalRealPnl), totalRealPnl > 0 ? 'pos' : totalRealPnl < 0 ? 'neg' : 'muted') +
    statCard('Сделок (всего)', String(totalRealTrades)) +
    `</div>` +
    (depositLow ? `<p class="pd-foot" style="margin:12px 0 0;color:#e5c061">⚠ Депозит $${deposit!.toFixed(2)} ниже рекомендуемого $${recDeposit} для ${activeCount} активных. Стратегии с долей ниже их минимума будут ждать пополнения (иначе заявки упираются в минимум Polymarket 5 акций).</p>` : '') +
    `</div>`;

  const launchCard =
    `<div class="pd-card">` +
    `<h2>Стратегии — реальная торговля</h2>` +
    `<p class="pd-sub">Запускай и останавливай стратегии по отдельности. ⚠️ <b>Авто-стопов нет</b> — каждая работает до ручной остановки. Размер ставки — <b>Kelly от доли депозита</b>.</p>` +
    splitNote +
    `<div class="pd-cards" style="margin-bottom:0">${cards}</div>` +
    (canRun ? '' : `<p class="pd-foot" style="margin-top:14px;color:#caa">Кнопки «Запустить» станут активными после сохранения ключа и адреса депозит-кошелька ниже.</p>`) +
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
  const minLine = `<p class="pd-foot" style="margin:-6px 0 14px">Рекомендуемый минимальный банк: <b style="color:${belowMin ? '#e5c061' : '#9aa4b2'}">$${minDep}</b>${belowMin ? ` · сейчас доля $${ses!.bank!.toFixed(2)} — ниже минимума` : ''}. Ниже него Kelly упирается в минимальную заявку Polymarket (5 акций) и ставки не масштабируются.</p>`;
  const sessionCard = isActive
    ? `<div class="pd-card" style="border-color:${ses.state === 'low_deposit' ? '#5a4a2e' : '#2e5a3a'}"><h2>Текущая сессия</h2>` +
      `<div style="margin:6px 0">Сделок: <b>${ses.fills ?? 0}</b> · PnL сессии: <b class="${(ses.pnl ?? 0) >= 0 ? 'pd-pos' : 'pd-neg'}">${fmtUsd(ses.pnl ?? 0)}</b>` +
      (ses.bank != null ? ` · банк: <b>$${ses.bank.toFixed(2)}</b>` : '') + `</div>` +
      (ses.since ? `<div class="pd-foot">Старт: ${esc(new Date(ses.since).toLocaleString('ru-RU', { timeZone: 'UTC' }))} UTC</div>` : '') +
      (ses.state === 'low_deposit' && ses.reason ? `<div style="color:#e5c061;margin-top:8px">💰 ${esc(ses.reason)}</div>` : '') +
      `<form method="POST" action="/predict/real/stop" style="margin-top:14px"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-stop" style="width:auto;display:inline-block;padding:9px 20px">⏸ Остановить</button></form>` +
      `</div>`
    : `<div class="pd-card"><p class="pd-sub">Стратегия сейчас не запущена в реале. ${st && (st.rounds ?? 0) > 0 ? 'Ниже — статистика прошлых реальных сделок.' : 'Реальных сделок пока не было.'}</p>` +
      `<form method="POST" action="/predict/real/start"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-rbtn pd-rbtn-go" style="width:auto;display:inline-block;padding:9px 20px">▶ Запустить</button></form></div>`;

  if (!st || (st.rounds ?? 0) === 0) {
    return STYLES + `<div class="pd-wrap">${back}${header}<p class="pd-sub">${esc(s.tagline)}</p>` + minLine + sessionCard +
      `<div class="pd-card"><p class="pd-foot">Завершённых реальных сделок пока нет — появятся здесь после первых закрытых раундов.</p></div></div>`;
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
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC · реальные деньги</p>` +
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
    // Только eligible-стратегия.
    const elig = STRATEGIES.find((s) => s.slug === slug && s.engine && s.realEligible !== false);
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

  for (const s of STRATEGIES) {
    app.get(`/predict/${s.slug}`, async (req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      const u = getAuthedUser(req);
      const pageRaw = (req.query as { page?: string } | undefined)?.page;
      const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
      return pageShell(`${s.title} — /predict`, renderStrategy(s, page), {
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

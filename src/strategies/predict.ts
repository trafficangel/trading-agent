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
};

const STRATEGIES: StrategyDef[] = [
  {
    slug: 'endgame',
    title: 'Эндшпиль (z-оценка)',
    tagline: 'В последние секунды покупаем почти решённую сторону с дисконтом',
    statusEnv: 'PREDICT_ENDGAME_STATUS_PATH',
    statusFile: 'predict-endgame-status.json',
    liveFile: 'predict-endgame-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Эта стратегия не угадывает, куда пойдёт BTC. Она реагирует на уже складывающийся исход. В последние ≤90 секунд раунда считаем, насколько далеко цена ушла от цели относительно её типичных колебаний за оставшееся время (z-оценка). Чем больше z, тем выше вероятность, что лидирующая сторона удержится до закрытия.',
      'Перекалибровка (важно). Первая версия покупала почти решённую сторону по высокой цене (~0.91 в среднем). Это оказалось проигрышной математикой: выигрыш приносил +9¢ на акцию, а проигрыш забирал −91¢ — один проигрыш съедал ~11 выигрышей, и при winrate 82% (а нужно >91%) накопился минус. Вывод: ставка на экстремального фаворита требует точности, которой у грубой z-оценки нет.',
      'Новая гипотеза: покупать ДЕШЕВЛЕ ради симметрии выплат. Теперь берём сторону только если её цена ≤ 0.80 (выигрыш ≥ 20¢ на акцию — нужен winrate >80%, а не >91%) и при этом наша оценка вероятности выше цены минимум на 10¢ (явная недооценка рынком). Уверенность входа умеренная (не «почти 100%»). Держим до резолюции.',
      'Преимущество здесь — скорость и лаг книги, а не предсказание направления: входим, когда рынок недооценил уже складывающийся исход. Если дисконта нет или цена выше 0.80 — пропускаем раунд. Честно: это перезапуск с нуля и всё ещё гипотеза — прежний прогон дал минус, новый проверяем так же строго по статистике. Прибыль не гарантирована.',
    ],
  },
  {
    slug: 'eglate',
    title: 'Эндшпиль · поздний вход',
    tagline: 'Тот же эндшпиль, но входим только в последние 60 секунд раунда',
    statusEnv: 'PREDICT_EGLATE_STATUS_PATH',
    statusFile: 'predict-eglate-status.json',
    liveFile: 'predict-eglate-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Это «эндшпиль (z-оценка)» с единственным изменением: входим только когда до закрытия раунда осталось ≤ 60 секунд (обычный эндшпиль начинает искать вход уже за 90с). Всё остальное — оценка вероятности, фильтры цены и дисконта — идентично. Это честный A/B-тест одной гипотезы.',
      'Откуда гипотеза. Разбор 111 входов обычного эндшпиля показал: единственный признак, который отличает выигрыши от проигрышей, — это МОМЕНТ входа. Входы более чем за минуту до закрытия в среднем почти ничего не приносили (а самая ранняя зона, >75с, вообще работала в ноль) и держали бо́льшую часть проигрышей. Чем раньше входим — тем больше времени у цены успеть развернуться, и тем чаще «почти решённый» исход всё-таки переворачивается.',
      'Что проверяем. Срезав раннюю зону, мы должны получить меньше входов, но выше процент выигрышей и ровнее кривую. Сравниваем напрямую с обычным эндшпилем (90с) и с «прайм»-вариантом (45с) на тех же самых рынках. Честно: это всё ещё та же гипотеза лага тонкого стакана, преимущество не гарантировано — судим по статистике на достаточной выборке.',
    ],
  },
  {
    slug: 'egsnap',
    title: 'Эндшпиль · прайм-окно',
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
    ],
  },
  {
    slug: 'egsharp',
    title: 'Эндшпиль · заточенный',
    tagline: 'Тот же эндшпиль, но входим только на сильнейших сигналах — ради ровной кривой',
    statusEnv: 'PREDICT_EGSHARP_STATUS_PATH',
    statusFile: 'predict-egsharp-status.json',
    liveFile: 'predict-egsharp-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Это «эндшпиль (z-оценка)» с более строгим фильтром. Логика та же — в последние секунды покупаем недооценённую почти решённую сторону, — но входим РЕЖЕ и только когда сигнал особенно сильный: выше уверенность (z), больший дисконт рынка (запас ≥ 15¢ против справедливой цены) и не дороже 0.78.',
      'Идея: меньше, но более качественных входов → выше доля выигрышей и более ровный, предсказуемый рост (меньше просадка). Сравниваем с обычным эндшпилем на тех же рынках — что лучше держит стабильность.',
      'Честно: это вариация той же гипотезы (лаг тонкого рынка против уже складывающегося исхода). Преимущество не гарантировано — судим по статистике на достаточной выборке. Параметры не публикуем.',
    ],
  },
  {
    slug: 'egprog',
    title: 'Эндшпиль · восстановление',
    tagline: 'Эндшпиль + умная recovery-ставка: тянем к восстановлению просадки, потом назад к базе',
    statusEnv: 'PREDICT_EGPROG_STATUS_PATH',
    statusFile: 'predict-egprog-status.json',
    liveFile: 'predict-egprog-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Вход — как у обычного эндшпиля (недооценённая почти решённая сторона в последние секунды). Отличие — в УМНОМ размере ставки: вместо наивного «удваиваться после проигрыша» система смотрит на накопленную просадку (насколько мы ниже своего пика PnL) и подбирает ставку так, чтобы выигрыши постепенно её закрывали.',
      'Размер считается с учётом коэффициента входа: повышаем ровно настолько, чтобы один выигрыш по текущей цене вернул примерно треть просадки — то есть восстанавливаемся за серию из нескольких выигрышей, а не одним рискованным рывком. Как только просадка закрыта (вернулись к пику) — ставка возвращается к базовой $10. Есть жёсткий потолок ставки, чтобы редкая серия проигрышей не разогнала риск.',
      'Идея проверки: у эндшпиля высокий процент выигрышей и редкие серии проигрышей, поэтому плавное восстановление просадки может давать ровный рост. Тестируем это на данных.',
      'Честно: никакая система ставок НЕ создаёт математического преимущества — она лишь перераспределяет результат во времени. Восстановление работает, только если у самого входа неотрицательное матожидание, а серии проигрышей редкие; иначе на длинной серии упрёмся в потолок с ограниченным, но реальным минусом. Это эксперимент в симуляции; вывод — по статистике.',
    ],
  },
  {
    slug: 'eglock',
    title: 'Эндшпиль · замок',
    tagline: 'Снайп почти-решённого исхода: в последние секунды берём победителя с дисконтом',
    statusEnv: 'PREDICT_EGLOCK_STATUS_PATH',
    statusFile: 'predict-eglock-status.json',
    liveFile: 'predict-eglock-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Это самый «жёсткий» вариант эндшпиля и наш отдельный тест на положительное матожидание. Идея простая: вход — только в самые последние секунды раунда, когда исход уже практически решён. Мы считаем z-оценку (насколько далеко цена ушла от цели относительно её типичных колебаний за оставшееся время); входим только при очень большом z — то есть когда вероятность, что лидирующая сторона удержится до закрытия, близка к 100%.',
      'Ключевое условие: при этом цена победившей-почти-наверняка стороны всё ещё ниже 0.97. Тонкий 5-минутный стакан часто не успевает переоценить уже решённый исход — и тогда мы покупаем то, что почти гарантированно гасится в 1.00, забирая разницу (1−цена)/цена как практически безрисковую прибыль. Это и есть кандидат с положительным матожиданием: не предсказание направления, а сбор лага книги на решённом исходе.',
      'Честно о пределах. «Положительное матожидание» здесь держится ровно до тех пор, пока книга запаздывает с переоценкой. Если другие боты переоценивают исход мгновенно — цена сразу прыгает к 1.00, наше условие «дешевле 0.97» не выполняется, и стратегия просто НЕ входит (нулевая активность лучше, чем убыток). Гарантированной +EV-системы на эффективном рынке для частника не существует; это самый сильный кандидат, и мы проверяем его строго по статистике в симуляции. Параметры не публикуем.',
    ],
  },
  {
    slug: 'favprog',
    title: 'Фаворит · восстановление',
    tagline: 'Ставка на фаворита (высокий winrate) + умная recovery-ставка по просадке',
    statusEnv: 'PREDICT_FAVPROG_STATUS_PATH',
    statusFile: 'predict-favprog-status.json',
    liveFile: 'predict-favprog-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Зачем именно фаворит. Recovery-система (восстановление накопленной просадки повышением ставки) менее опасна там, где проигрыши редко идут длинными сериями подряд. Самый высокий процент выигрышей среди направленных входов даёт ставка на фаворита — сторону, чья цена высокая (а значит, по рынку вероятная). Поэтому базой берём именно её: каждый раунд покупаем сторону, чей ask в полосе 0.60–0.85 (фаворит, но не почти-решённый — там уже нет места прибыли), и держим до конца.',
      'Как считается ставка (recovery). Базовая ставка $10. Если накопленный PnL просел ниже своего пика на величину dd, система повышает ставку так, чтобы один выигрыш по текущей цене вернул примерно треть просадки (растягиваем восстановление на серию выигрышей, а не на один рискованный рывок), с учётом коэффициента входа. Как только просадка закрыта — ставка возвращается к базовым $10. Есть жёсткий потолок ставки ($100), чтобы редкая серия проигрышей не разогнала риск.',
      'Честно о математике. Никакая система ставок НЕ создаёт преимущества — она лишь перераспределяет результат во времени. У ставки на фаворита процент выигрышей примерно равен подразумеваемой ценой вероятности (своего преимущества нет, EV ≈ 0 минус комиссия). Высокий winrate делает кривую recovery более ровной и приятной на вид, НО у этого есть цена: когда фаворит всё же проигрывает несколько раз подряд при поднятой ставке — просадка получается крупной (особенно у дорогих фаворитов, где один проигрыш стоит как много выигрышей). Это эксперимент по форме кривой и управлению риском, а не источник дохода. Paper; вывод — по статистике.',
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
    (opts.isTrap ? `<th>Что</th><th>Куплено / продано</th>` : `<th>Сторона</th><th ${right}>Ставка</th>`) +
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
            : `<td ${right}>${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}</td>`) +
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
        (opts.isTrap ? boughtCell(r) : `<td ${right}>${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}</td>`) +
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

function renderOverview(): string {
  const cards = STRATEGIES.map((s) => strategyCard(s, readStatus(s))).join('');
  return (
    STYLES +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>/predict</h1></div>` +
    `<p class="pd-sub">Экспериментальные стратегии на prediction-маркете Polymarket (BTC Up/Down, 5 мин). ` +
    `Каждая стратегия — отдельная гипотеза со своей честной статистикой (убытки тоже показываем). ` +
    `Всё в paper-режиме и изолировано от основного бота — это только просмотр.</p>` +
    `<div class="pd-cards">${cards}</div>` +
    globalFeed() +
    `</div>`
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
  const avgStakeCard =
    st.avgStake != null ? statCard('Ср. ставка', `$${st.avgStake.toFixed(2)}`, 'muted') : statCard('Max drawdown', `$${st.maxDrawdown.toFixed(2)}`, 'muted');

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
    avgStakeCard +
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
function renderNoAccess(authed: boolean): string {
  const support = 'https://t.me/robotclaude_support';
  const cta = authed
    ? `<p class="pd-sub">Ваш аккаунт авторизован, но доступ к этому разделу ещё не выдан. Доступ открывается <b>вручную через поддержку</b>.</p>`
    : `<p class="pd-sub">Раздел доступен только зарегистрированным пользователям с выданным доступом. Сначала войдите, затем запросите доступ <b>через поддержку</b>.</p>`;
  return (
    STYLES +
    `<div class="pd-wrap">` +
    `<div class="pd-head"><h1>/predict</h1><span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>закрытый раздел</span></div>` +
    `<div class="pd-card">` +
    `<h2>🔒 Доступ по запросу</h2>` +
    cta +
    `<p class="pd-sub" style="margin-bottom:6px">Что в разделе:</p>` +
    `<ul class="pd-desc" style="margin:0 0 14px; padding-left:20px; line-height:1.7">` +
    `<li>Экспериментальные торговые стратегии на prediction-маркете Polymarket (BTC/ETH «вверх/вниз», окно 5 минут).</li>` +
    `<li>Честная живая статистика по каждой стратегии: винрейт, PnL, кривая доходности, история сделок — с убытками, без прикрас.</li>` +
    `<li>Лайв-панель текущего раунда: цены сторон, наша позиция, таймер до закрытия.</li>` +
    `<li>В перспективе — подключение собственного кошелька и реальная торговля (откроется только после того, как у стратегии подтвердится устойчивое преимущество).</li>` +
    `</ul>` +
    `<p class="pd-sub">Это в первую очередь исследовательский раздел: показываем как удачные, так и неудачные гипотезы. Из-за рисков доступ выдаётся индивидуально.</p>` +
    `<p style="margin-top:18px"><a class="pd-back" style="font-size:15px" href="${support}">→ Написать в поддержку для доступа</a></p>` +
    (authed ? '' : `<p style="margin-top:8px"><a class="pd-back" href="/strategies">→ Войти / зарегистрироваться</a></p>`) +
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

/** Сохранить relayer/builder креды в защищённый env-файл (chmod 600). Возвращает маску. */
function saveBuilderCreds(key: string, secret: string, passphrase: string): string {
  const body = `BUILDER_KEY=${key.trim()}\nBUILDER_SECRET=${secret.trim()}\nBUILDER_PASSPHRASE=${passphrase.trim()}\n`;
  writeFileSync(REAL_BUILDER_ENV_FILE, body, { mode: 0o600 });
  try {
    chmodSync(REAL_BUILDER_ENV_FILE, 0o600);
  } catch {
    /* best-effort */
  }
  return `••••${key.trim().slice(-4)}`;
}

function renderRealTrading(cfg: RealConfig, ctrl: RealControl, err?: string): string {
  const back = `<a class="pd-back" href="/predict">← раздел /predict</a>`;
  const keyReady = !!cfg.keyMask;
  const funderOk = !!cfg.funderAddress && /^0x[a-fA-F0-9]{40}$/.test(cfg.funderAddress);
  const funderStatus = cfg.funderAddress
    ? funderOk
      ? '<span class="pd-pos">✓ адрес корректен</span>'
      : '<span class="pd-neg">✗ адрес НЕвалиден — нужен формат 0x + 40 hex-символов (без лишних суффиксов)</span>'
    : '<span class="pd-muted-td">не задан</span>';
  const errBanner =
    err === 'funder'
      ? `<div class="pd-card" style="border-color:#5a2e2e;background:rgba(229,97,108,0.08)"><b class="pd-neg">Адрес funder не сохранён:</b> введён неверный формат. Нужен ровно <code>0x</code> + 40 hex-символов (например 0xb985…36b), без дефисов, пробелов и суффиксов. Скопируй адрес со страницы пополнения USDC в Polymarket.</div>`
      : '';
  const stakeInputStyle = 'width:80px;padding:7px 9px;background:#0b0e13;border:1px solid #2a313c;border-radius:7px;color:#e6e9ef';
  // Панель запуска/остановки: по каждой стратегии — СВОЯ фикс. ставка + кнопки + личный PnL.
  const controlRows = STRATEGIES.map((s) => {
    const running = !!ctrl.running[s.slug];
    const stake = cfg.stakes?.[s.slug];
    const stakeVal = stake != null ? String(stake) : '';
    const paper = readStatus(s);
    const paperLine = paper ? `paper: win ${paper.winRate}%, PnL ${fmtUsd(paper.netPnl)}` : 'paper: нет данных';
    const rst = readRealStatus(s.slug);
    const statLine = rst
      ? `боевой: ${rst.rounds} сделок · win ${rst.winRate}% · PnL <b class="${rst.netPnl >= 0 ? 'pd-pos' : 'pd-neg'}">${fmtUsd(rst.netPnl)}</b>`
      : '<span class="pd-muted-td">боевых сделок ещё нет</span>';
    const curve = rst && rst.equityCurve && rst.equityCurve.length > 1 ? equitySvg(rst.equityCurve) : '';
    const badge = running
      ? `<span class="pd-fresh pd-fresh-ok"><span class="pd-dot"></span>🟢 запущена · ставка $${stakeVal || '?'}</span>`
      : `<span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>⏸ остановлена</span>`;
    const control = running
      ? `<form method="POST" action="/predict/real/stop" style="display:inline"><input type="hidden" name="slug" value="${esc(s.slug)}"><button type="submit" class="pd-back" style="background:#3a1f1f;border:1px solid #5a2e2e;padding:8px 14px;border-radius:8px;cursor:pointer">⏹ Остановить</button></form>`
      : `<form method="POST" action="/predict/real/start" style="display:flex;gap:8px;align-items:center" onsubmit="return confirm('Запустить РЕАЛЬНУЮ торговлю «${esc(s.title)}»? Пойдут настоящие деньги с твоего кошелька.');">` +
        `<input type="hidden" name="slug" value="${esc(s.slug)}">` +
        `<input type="text" name="stake" value="${esc(stakeVal)}" placeholder="ставка $" title="Фикс. ставка на сделку, USD" style="${stakeInputStyle}">` +
        `<button type="submit" ${keyReady && funderOk ? '' : `disabled title="${keyReady ? 'Сначала введи корректный funder-адрес' : 'Сначала сохрани ключ кошелька'}"`} class="pd-back" style="background:#16321f;border:1px solid #2e5a3a;padding:8px 14px;border-radius:8px;cursor:${keyReady && funderOk ? 'pointer' : 'not-allowed'};opacity:${keyReady && funderOk ? '1' : '0.5'}">▶ Запустить</button></form>`;
    return (
      `<div style="padding:12px;border:1px solid #1e2530;border-radius:8px;margin-bottom:10px">` +
      `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">` +
      `<div><b>${esc(s.title)}</b> ${badge}<br><span class="pd-muted-td" style="font-size:12px">${esc(paperLine)}</span> · <span style="font-size:13px">${statLine}</span></div>` +
      `<div>${control}</div></div>` +
      (curve ? `<div style="margin-top:10px">${curve}</div>` : '') +
      `</div>`
    );
  }).join('');
  const fieldStyle = 'margin-top:4px;width:360px;max-width:100%;padding:8px 10px;background:#0b0e13;border:1px solid #2a313c;border-radius:7px;color:#e6e9ef';
  const keyStatus = cfg.keyMask
    ? `<span class="pd-pos">✓ ключ сохранён (${esc(cfg.keyMask)})</span>`
    : `<span class="pd-neg">✗ ключ не сохранён</span>`;
  const updated = cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC' : '—';
  return (
    STYLES +
    `<div class="pd-wrap">${back}` +
    `<div class="pd-head"><h1>Реальная торговля</h1>` +
    `<span class="pd-fresh pd-fresh-stale"><span class="pd-dot"></span>⏸ не активна</span></div>` +
    `<div class="pd-card" style="border-color:#3a2e2e">` +
    `<p class="pd-sub">⚠️ Реальная торговля <b>пока не запущена</b> — сохранение тут только готовит подключение. Риск ограничивай <b>суммой на кошельке</b>: заведи отдельный кошелёк и держи на нём только то, что готов потерять. Преимущества пока нет — на старте вероятен минус.</p>` +
    `</div>` +
    errBanner +
    `<form method="POST" action="/predict/real/save" autocomplete="off">` +
    `<div class="pd-card"><h2>Подключение кошелька</h2>` +
    `<label style="display:block;margin-bottom:12px">Приватный ключ кошелька (хранится на сервере в защищённом файле, обратно не показывается):<br>` +
    `<input type="password" name="privkey" value="" placeholder="${cfg.keyMask ? 'оставь пустым, чтобы не менять' : '0x… приватный ключ'}" autocomplete="new-password" style="${fieldStyle}"></label>` +
    `<div style="margin:6px 0 14px">Статус ключа: ${keyStatus}</div>` +
    `<label style="display:block;margin-bottom:8px">Адрес funder / proxy (публичный, 0x…):<br>` +
    `<input type="text" name="funder" value="${esc(cfg.funderAddress ?? '')}" placeholder="0x… (ровно 0x + 40 hex)" style="${fieldStyle}"></label>` +
    `<div style="margin:6px 0 14px">Статус адреса: ${funderStatus}</div>` +
    `<hr style="border:none;border-top:1px solid #1e2530;margin:16px 0">` +
    `<p class="pd-foot" style="margin-bottom:10px">Relayer/builder API-креды Polymarket (из раздела «API-ключи релеера» в профиле Polymarket). Нужны движку для боевого режима. Оставь все три пустыми, чтобы не менять.</p>` +
    `<label style="display:block;margin-bottom:8px">BUILDER_KEY:<br><input type="password" name="builder_key" value="" placeholder="${cfg.builderMask ? 'оставь пустым, чтобы не менять' : 'API key релеера'}" autocomplete="new-password" style="${fieldStyle}"></label>` +
    `<label style="display:block;margin-bottom:8px">BUILDER_SECRET:<br><input type="password" name="builder_secret" value="" placeholder="${cfg.builderMask ? 'оставь пустым' : 'API secret'}" autocomplete="new-password" style="${fieldStyle}"></label>` +
    `<label style="display:block;margin-bottom:8px">BUILDER_PASSPHRASE:<br><input type="password" name="builder_passphrase" value="" placeholder="${cfg.builderMask ? 'оставь пустым' : 'API passphrase'}" autocomplete="new-password" style="${fieldStyle}"></label>` +
    `<div style="margin:6px 0 14px">Статус relayer-кредов: ${cfg.builderMask ? `<span class="pd-pos">✓ сохранены (${esc(cfg.builderMask)})</span>` : '<span class="pd-neg">✗ не сохранены</span>'}</div>` +
    `<p class="pd-foot">🔒 Ключ и relayer-креды передаются по HTTPS, кладутся в файлы с правами 600, в логи/в git не попадают и обратно не отображаются. Это твои креды на твоём сервере — для надёжности используй отдельный кошелёк с малым балансом.</p>` +
    `</div>` +
    `<div class="pd-card"><button type="submit" class="pd-back" style="font-size:15px;background:#16321f;border:1px solid #2e5a3a;padding:10px 16px;border-radius:8px;cursor:pointer">💾 Сохранить</button>` +
    `<p class="pd-foot" style="margin-top:10px">Сохранение НЕ запускает торговлю — только готовит подключение. Боевой запуск включается отдельно и осознанно.</p>` +
    `<p class="pd-foot">Обновлено: ${esc(updated)}</p></div>` +
    `</form>` +
    `<div class="pd-card"><h2>Запуск и личная статистика</h2>` +
    `<p class="pd-sub">По каждой стратегии задай <b>свою фикс. ставку</b> и запусти. Кнопка запуска активна только когда сохранён ключ кошелька. Здесь же — личный боевой PnL каждой стратегии.</p>` +
    controlRows +
    `<p class="pd-foot">⚙️ Кнопка ставит «запущена/остановлена»; реальное исполнение поднимает супервайзер на сервере. Боевые сделки идут на твои деньги — преимущества пока нет, вероятен минус.</p>` +
    `</div>` +
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

  app.get('/predict', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const u = gate(req);
    if (!u) {
      return pageShell('/predict — закрытый раздел', renderNoAccess(!!getAuthedUser(req)), { lang: 'ru', robots: 'noindex, nofollow' });
    }
    return pageShell('/predict — Robot Claude', REAL_TRADING_NOTE + renderOverview(), {
      lang: 'ru',
      autoRefreshSec: 60,
      robots: 'noindex, nofollow',
      authed: { displayName: u.displayName, phone: u.phone },
    });
  });

  // Страница реальной торговли (оператор-онли, гейт). Пока НИЧЕГО не исполняет —
  // только выбор стратегии и параметров. Ключ сюда не вводится.
  app.get('/predict/real', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const u = gate(req);
    if (!u) {
      return pageShell('/predict — закрытый раздел', renderNoAccess(!!getAuthedUser(req)), { lang: 'ru', robots: 'noindex, nofollow' });
    }
    const err = (req.query as { err?: string } | undefined)?.err;
    return pageShell('Реальная торговля — /predict', renderRealTrading(readRealConfig(), readRealControl(), err), {
      lang: 'ru',
      robots: 'noindex, nofollow',
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
    if (!funderOk) {
      // Нельзя запускать боевую торговлю без валидного funder-адреса.
      reply.code(303).header('location', '/predict/real?err=funder').send();
      return;
    }
    if (STRATEGIES.some((s) => s.slug === slug) && cfg.keyMask) {
      // Сохраняем фикс. ставку этой стратегии (если задана), затем запускаем.
      const stakeN = Number(b.stake);
      if (Number.isFinite(stakeN) && stakeN > 0) {
        cfg.stakes = { ...cfg.stakes, [slug]: Math.round(stakeN * 100) / 100 };
        writeRealConfig(cfg);
      }
      const c = readRealControl();
      c.running[slug] = { since: new Date().toISOString() };
      writeRealControl(c);
    }
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
      reply.header('Cache-Control', 'private, no-store');
      const u = gate(req);
      if (!u) {
        return pageShell('/predict — закрытый раздел', renderNoAccess(!!getAuthedUser(req)), { lang: 'ru', robots: 'noindex, nofollow' });
      }
      const pageRaw = (req.query as { page?: string } | undefined)?.page;
      const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
      return pageShell(`${s.title} — /predict`, renderStrategy(s, page), {
        lang: 'ru',
        autoRefreshSec: 60,
        robots: 'noindex, nofollow',
        authed: { displayName: u.displayName, phone: u.phone },
      });
    });
    app.get(`/predict/${s.slug}/status.json`, async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!gate(req)) {
        reply.code(403);
        return { ok: false, error: 'forbidden' };
      }
      const st = readStatus(s);
      if (!st) {
        reply.code(503);
        return { ok: false, error: 'no_data_yet' };
      }
      return st;
    });
    app.get(`/predict/${s.slug}/live.json`, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gate(req)) {
        reply.code(403);
        return { ok: false, error: 'forbidden' };
      }
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

  // Диагностика: что движок прочитает. Закрыта тем же гейтом, что и раздел.
  app.get('/predict/lux/feed.json', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gate(req)) {
      reply.code(403);
      return { ok: false, error: 'forbidden' };
    }
    try {
      if (existsSync(LUX_SIGNAL_FILE)) return JSON.parse(readFileSync(LUX_SIGNAL_FILE, 'utf8'));
    } catch {
      /* ignore */
    }
    reply.code(503);
    return { ok: false, error: 'no_signals_yet' };
  });
}

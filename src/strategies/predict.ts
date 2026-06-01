import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { pageShell } from './landing.js';

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
      'Эдж здесь — скорость и лаг книги, а не предсказание направления: входим, когда рынок недооценил уже складывающийся исход. Если дисконта нет или цена выше 0.80 — пропускаем раунд. Честно: это перезапуск с нуля и всё ещё гипотеза — прежний прогон дал минус, новый проверяем так же строго по статистике. Прибыль не гарантирована.',
    ],
  },
  {
    slug: 'lux',
    title: 'LuxAlgo сигналы',
    tagline: 'Держим направление последнего Confirmation LuxAlgo (1m); вход при коэффициенте ≥ 2',
    statusEnv: 'PREDICT_LUX_STATUS_PATH',
    statusFile: 'predict-lux-status.json',
    liveFile: 'predict-lux-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Стратегия следует за сигналами Confirmation индикатора LuxAlgo с минутного графика BTC. Алерты из TradingView приходят на наш сервер вебхуком на закрытии каждого 1-минутного бара. Размер ставки фиксированный — $1 на раунд; позицию держим до конца 5-минутного окна.',
      'Направление. Текущую сторону задаёт последний Confirmation: Buy → ставим на UP, Sell → на DOWN (усиленные Buy+/Sell+ — то же направление). Это направление ДЕРЖИТСЯ, пока не прилетит новый Confirmation в другую сторону — то есть мы торгуем по сигналу, пока он не сменится (а не ждём новый каждый раунд). Если последний сигнал старше 30 минут — считаем направление неактуальным и не торгуем.',
      'Вход — по коэффициенту ≥ 2. Каждый раунд, если сторона по нашему направлению стоит дёшево: коэффициент ≥ 2, то есть цена ≤ 0.50 (и не глубже 0.30). Смысл: LuxAlgo говорит, например, UP, а рынок оценивает UP в ≤50% — мы ставим против цены с выплатой не меньше 2:1, доверяя сигналу. Если сторона сигнала стоит дороже 0.50 (коэф < 2) — пропускаем: выплата мала.',
      'Когда раунд пропускаем. Нет актуального направления (Confirmation не приходил или он старше 30 мин); сторона сигнала дороже 0.50 (коэф < 2); цена глубже 0.30; не хватает времени или ликвидности.',
      'Честно. Это направленная ставка по индикатору. Сигналы LuxAlgo запаздывают и могут перерисовываться, а угадывание направления на 5-минутном BTC у нас нигде не дало устойчивого плюса — поэтому прибыль НЕ гарантирована. Фильтр «коэф ≥ 2» даёт шанс на эдж, только если сигнал реально опережает рынок там, где рынок оценивает эту сторону в аутсайдеры. Проверяем строго по статистике; параметры не публикуем.',
    ],
  },
  {
    slug: 'trap',
    title: 'Ценовая ловушка',
    tagline: 'Набираем обе стороны дёшево по очереди; если сумма входа < $1 — прибыль заперта',
    statusEnv: 'PREDICT_TRAP_STATUS_PATH',
    statusFile: 'predict-trap-status.json',
    liveFile: 'predict-trap-live.json',
    showStakeCol: false,
    hasLive: true,
    isTrap: true,
    description: [
      'В бинарном рынке стороны UP и DOWN всегда стоят в сумме около $1 (ровно одна выплатит $1). Купить обе одновременно — гарантированный минус (платишь больше $1 из-за спреда). Но эта стратегия покупает стороны НЕ одновременно, а по очереди — ловит каждую, когда она временно дешёвая (цена качнулась против неё).',
      'Например: цена качнулась вниз → UP подешевел, покупаем UP по 0.40. Позже цена качнулась вверх → DOWN подешевел, покупаем DOWN по 0.40. Суммарно вложено 0.80, а на резолюции придёт ровно $1 — прибыль +0.20 на акцию заперта, независимо от исхода. «Ловушка захлопнулась». Вторую ногу берём, только если суммарная цена входа ≤ 0.90 (гарантированный плюс ≥10¢ на акцию).',
      'Честный риск: ловушка захлопывается только если цена в раунде ходит в ОБЕ стороны. Если рынок трендит в одну сторону — дешевеет лишь проигрывающая сторона, мы добираем только её и остаёмся с одной проигрышной ногой (убыток). По сути это ставка на разворот/боковик против тренда. Прибыльна ли она — зависит от того, как часто 5-минутный рынок ходит в диапазоне, а не трендит. Проверяем статистикой; плюс не гарантирован.',
    ],
  },
  {
    slug: 'leadlag',
    title: 'Lead-Lag BTC→ETH',
    tagline: 'BTC ведёт, ETH следом: ловим лаг ETH-рынка после резкого движения BTC',
    statusEnv: 'PREDICT_LEADLAG_STATUS_PATH',
    statusFile: 'predict-leadlag-status.json',
    liveFile: 'predict-leadlag-live.json',
    showStakeCol: true,
    hasLive: true,
    description: [
      'Эта стратегия торгует на рынке ETH (а не BTC). BTC и ETH скоррелированы на ~85–90%, и на коротком горизонте BTC обычно двигается первым, а ETH повторяет его с задержкой. Идея: когда BTC делает резкий рывок, ETH-рынок ещё не успевает переоцениться — покупаем сторону ETH по направлению движения BTC, пока ордербук ETH отстаёт.',
      'Механика: следим за живой ценой BTC (отдельный поток с биржи) и за ценой ETH. Если за последние ~8 секунд BTC прошёл заметное расстояние (≥0.05%), а ETH отыграл меньше 60% этого движения (то есть отстаёт) — входим в ETH-сторону по направлению BTC, если её цена ещё не задрана (в полосе 0.40–0.75). Держим до конца раунда.',
      'Это не предсказание направления, а реакция на уже случившееся движение лидера — тот же принцип «эдж = скорость», что и у эндшпиля. Честные оговорки: лидерство BTC→ETH не абсолютно (иногда ведёт ETH, иногда корреляция рвётся внутри 5 минут), а задержка доставки данных может съесть преимущество. Поэтому всё логируем (рывок BTC против реакции ETH) — статистика покажет, есть ли лаг на самом деле. Плюс не гарантирован.',
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
  const sideCell = (r: RecentRound): string => {
    if (opts.isTrap || r._isTrap) {
      if (r.bothLegs) return `<td class="pd-pos">🔒 захлопнулась</td>`;
      const sc = r.side === 'UP' ? 'pd-up' : r.side === 'DOWN' ? 'pd-down' : '';
      return `<td class="${sc}">однобоко ${esc(r.side ?? '—')}</td>`;
    }
    const sc = r.side === 'UP' ? 'pd-up' : r.side === 'DOWN' ? 'pd-down' : '';
    return `<td class="${sc}">${esc(r.side ?? '—')}</td>`;
  };
  const title = opts.title ?? 'Последние раунды';
  const showStrategy = opts.showStrategy ?? false;
  const showMetric = opts.showMetric !== false;
  // Адаптивные колонки: оценка (prob), коэф входа, время входа.
  const hasEdge = showMetric && rounds.some((r) => r.edge != null);
  const hasCoef = showMetric && rounds.some((r) => r.coef != null);
  const hasEntry = showMetric && rounds.some((r) => r.entrySecLeft != null);
  const right = 'style="text-align:right"';
  const head =
    `<tr>` +
    (showStrategy ? `<th>Стратегия</th>` : '') +
    `<th>Сторона</th><th ${right}>Ставка</th>` +
    (hasEdge ? `<th ${right}>Оценка</th>` : '') +
    (hasCoef ? `<th ${right}>Коэф.</th>` : '') +
    (hasEntry ? `<th ${right}>До закрытия</th>` : '') +
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
          `<td ${right}>${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}</td>` +
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
        `<td ${right}>${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}</td>` +
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
  // Для ловушки — счётчик «захлопнулось / однобоких» (ключ к пониманию статистики).
  const trapCard =
    s.isTrap && st.trapClosed != null
      ? statCard('Захлопнулось / однобоко', `${st.trapClosed} / ${st.oneLegged ?? 0}`, 'muted')
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
    `<div class="pd-foot">Выигрышей: ${st.wins} · Проигрышей: ${st.losses} · ` +
    `Исходы рынка ↑${st.marketOutcomes.up}/↓${st.marketOutcomes.down}</div></div>` +
    roundsTable +
    PAPER_NOTE +
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC</p>` +
    `</div>`
  );
}

export async function predictRoute(app: FastifyInstance): Promise<void> {
  app.get('/predict', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return pageShell('/predict — Robot Claude', renderOverview(), { lang: 'ru', autoRefreshSec: 60 });
  });

  // Back-compat: /predict/status.json = первая стратегия (prob).
  app.get('/predict/status.json', async (_req, reply) => {
    const st = readStatus(STRATEGIES[0]!);
    reply.header('Cache-Control', 'public, max-age=30');
    if (!st) {
      reply.code(503);
      return { ok: false, error: 'no_data_yet' };
    }
    return st;
  });

  for (const s of STRATEGIES) {
    app.get(`/predict/${s.slug}`, async (req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=30');
      const pageRaw = (req.query as { page?: string } | undefined)?.page;
      const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
      return pageShell(`${s.title} — /predict`, renderStrategy(s, page), { lang: 'ru', autoRefreshSec: 60 });
    });
    app.get(`/predict/${s.slug}/status.json`, async (_req, reply) => {
      const st = readStatus(s);
      reply.header('Cache-Control', 'public, max-age=30');
      if (!st) {
        reply.code(503);
        return { ok: false, error: 'no_data_yet' };
      }
      return st;
    });
    app.get(`/predict/${s.slug}/live.json`, async (_req, reply) => {
      const live = readLive(s);
      reply.header('Cache-Control', 'no-store');
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

  // Диагностика: что движок прочитает (без секрета — публично безопасно).
  app.get('/predict/lux/feed.json', async (_req, reply) => {
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

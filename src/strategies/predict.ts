import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
};

const STRATEGIES: StrategyDef[] = [
  {
    slug: 'prob',
    title: 'Probability Engine',
    tagline: 'Оценка вероятности и эдж против ордербука',
    statusEnv: 'PREDICT_STATUS_PATH',
    statusFile: 'predict-status.json',
    liveFile: 'predict-live-prob.json',
    showStakeCol: true,
    description: [
      'Каждые полсекунды стратегия смотрит на три вещи: насколько цена BTC ушла от референса (цены-цели на момент открытия 5-минутного окна), её краткосрочный моментум и сколько времени осталось до закрытия. Из этого считается оценка вероятности исхода.',
      'Если наша оценка вероятности заметно выше цены стороны в ордербуке (есть «эдж» ≥ 8%), покупаем эту сторону — пока книга тонкого рынка не успела переоцениться. Размер ставки растёт с величиной эджа, потолок $25 на рынок. Позиция держится до конца окна.',
      'Суть: зарабатываем на скорости и лаге ордербука, а не на угадывании направления BTC. Поэтому входим редко — только когда эдж действительно есть.',
    ],
  },
  {
    slug: 'martingale',
    title: 'Мартингейл-Фибоначчи',
    tagline: 'Ставка на аутсайдера при коэф. 3.0–3.5 + прогрессия Фибоначчи',
    statusEnv: 'PREDICT_MART_STATUS_PATH',
    statusFile: 'predict-mart-status.json',
    liveFile: 'predict-live-martingale.json',
    showStakeCol: true,
    description: [
      'Стратегия ждёт момент в раунде, когда коэффициент одной из сторон попадает в диапазон 3.0–3.5 (цена 0.286–0.333) — рынок оценивает её как аутсайдера с шансом ~30%. Ставим на эту сторону, выбирая коэффициент ближе к 3 (там выше вероятность выигрыша). Если аутсайдер ушёл глубже 3.5 — раунд пропускаем. Ровно 3.00 поймать нельзя: цены идут тиками по 0.01, ближайшее — 0.33 (коэф 3.03).',
      'Размер ставки — система Фибоначчи от $1: 1, 1, 2, 3, 5, 8, 13, 21, 34… После проигрыша делаем следующий шаг последовательности, после выигрыша возвращаемся к $1. Потолок серии — 20 шагов.',
      'Честно: ставка на аутсайдера выигрывает примерно 1 раз из 3 — проигрышей по природе больше, чем выигрышей. Идея в том, что выплата ~3:1 на выигрышах вместе с прогрессией покрывает серии проигрышей. С учётом спреда встроенного эджа нет — накопленная статистика покажет правду.',
    ],
  },
];

type RecentRound = {
  t: number | null;
  side: 'UP' | 'DOWN' | null;
  stake?: number | null;
  coef?: number | null;
  prob?: number | null; // наша оценка вероятности, %
  edge?: number | null; // недооценка (наша оценка − цена), проц. пункты
  distanceBp?: number | null;
  pnl: number;
  win: boolean;
  _strategy?: string; // подпись стратегии (для общего списка)
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
    `<div class="pl-meta">BTC <span id="pl-btc">—</span> · цель <span id="pl-target">—</span> · отрыв <span id="pl-gap">—</span></div>` +
    `<div id="pl-pos" class="pl-pos">—</div>` +
    `</div>` +
    `<script>(function(){` +
    `var slug=${slug};var slotEnd=null;var lastUpd=0;` +
    `function $(i){return document.getElementById(i);}` +
    `function set(i,v){var e=$(i);if(e)e.textContent=v;}` +
    `function fmt(ms){if(ms<0)ms=0;var s=Math.floor(ms/1000);return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}` +
    `function cents(p){return p!=null?Math.round(p*100)+'¢':'—';}` +
    `function coef(p){return p?'×'+(1/p).toFixed(2):'—';}` +
    `function usd(n){return n!=null?'$'+n.toLocaleString('ru-RU',{maximumFractionDigits:2}):'—';}` +
    `function tick(){var t=$('pl-timer');if(!t)return;if(slotEnd&&Date.now()-lastUpd<25000){t.textContent=Date.now()<slotEnd?fmt(slotEnd-Date.now()):'раунд закрыт';}else{t.textContent='ожидание данных';}}` +
    `async function poll(){try{var r=await fetch('/predict/'+slug+'/live.json',{cache:'no-store'});if(!r.ok)return;var d=await r.json();lastUpd=Date.now();slotEnd=d.slotEndMs;` +
    `set('pl-up',cents(d.up&&d.up.ask));set('pl-up-k',coef(d.up&&d.up.ask));set('pl-down',cents(d.down&&d.down.ask));set('pl-down-k',coef(d.down&&d.down.ask));` +
    `set('pl-btc',usd(d.btc));set('pl-target',usd(d.target));var g=(d.btc!=null&&d.target!=null)?d.btc-d.target:null;set('pl-gap',g!=null?(g>=0?'+':'−')+'$'+Math.abs(g).toFixed(2):'—');` +
    `var p=d.position;$('pl-pos').innerHTML=p?('🟢 В сделке: <b class=\"'+(p.side==='UP'?'pd-up':'pd-down')+'\">'+p.side+'</b> · ставка '+usd(p.stake)+' · коэф '+(p.entryCoef||'—')):'⚪ Открытой позиции нет — ждём сигнал';` +
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

function recentRoundsTable(
  rounds: RecentRound[],
  opts: { title?: string; showStrategy?: boolean; showMetric?: boolean } = {},
): string {
  if (rounds.length === 0) return '';
  const title = opts.title ?? 'Последние раунды';
  const showStrategy = opts.showStrategy ?? false;
  const showMetric = opts.showMetric !== false;
  // Адаптивные колонки: для prob-engine — оценка/недооценка, для martingale — коэф.
  const hasEdge = showMetric && rounds.some((r) => r.edge != null);
  const hasCoef = showMetric && !hasEdge && rounds.some((r) => r.coef != null);
  const right = 'style="text-align:right"';
  const head =
    `<tr>` +
    (showStrategy ? `<th>Стратегия</th>` : '') +
    `<th>Сторона</th><th ${right}>Ставка</th>` +
    (hasEdge ? `<th ${right}>Оценка</th><th ${right}>Недооценка</th>` : '') +
    (hasCoef ? `<th ${right}>Коэф.</th>` : '') +
    `<th>Исход</th><th ${right}>PnL</th><th ${right}>Когда</th></tr>`;
  const rows = rounds
    .map((r) => {
      const when = r.t ? agoText(r.t) : '—';
      const side = r.side ?? '—';
      const sideCls = r.side === 'UP' ? 'pd-up' : r.side === 'DOWN' ? 'pd-down' : '';
      const resCls = r.win ? 'pd-pos' : 'pd-neg';
      const stratCell = showStrategy ? `<td class="pd-muted-td">${esc(r._strategy ?? '')}</td>` : '';
      const edgeCells = hasEdge
        ? `<td ${right}>${r.prob != null ? r.prob + '%' : '—'}</td>` +
          `<td class="pd-pos" ${right}>${r.edge != null ? '+' + r.edge + ' п.п.' : '—'}</td>`
        : '';
      const coefCell = hasCoef ? `<td class="pd-muted-td" ${right}>${r.coef != null ? r.coef.toFixed(2) : '—'}</td>` : '';
      return (
        `<tr>` +
        stratCell +
        `<td class="${sideCls}">${esc(side)}</td>` +
        `<td ${right}>${r.stake != null ? '$' + r.stake.toFixed(2) : '—'}</td>` +
        edgeCells +
        coefCell +
        `<td class="${resCls}">${r.win ? 'выигрыш' : 'проигрыш'}</td>` +
        `<td class="${resCls}" ${right}>${fmtUsd(r.pnl)}</td>` +
        `<td class="pd-muted-td" ${right}>${esc(when)}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="pd-card"><h2>${esc(title)}</h2>` +
    `<table class="pd-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
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
  .pd-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
  .pd-scard{display:block;background:#11151c;border:1px solid #1e2530;border-radius:14px;padding:20px;text-decoration:none;transition:border-color .15s}
  .pd-scard:hover{border-color:#33414f}
  .pd-scard h3{margin:0 0 4px;color:#fff;font-size:18px}
  .pd-scard .tag{color:#8b95a4;font-size:13px;line-height:1.4;margin-bottom:14px}
  .pd-scard .row{display:flex;gap:18px;flex-wrap:wrap}
  .pd-scard .row div{font-size:13px;color:#9aa4b2}
  .pd-scard .row b{display:block;font-size:18px;color:#fff;font-weight:700;margin-bottom:2px}
  .pd-arrow{color:#4ad991;font-size:13px;margin-top:14px;display:inline-block}
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
  `эдж считается реальным только после статистической проверки на большой выборке с учётом проскальзывания. ` +
  `Параметры стратегии не публикуются.</div>`;

function strategyCard(s: StrategyDef, st: PredictStatus | null): string {
  const stat = st
    ? `<div class="row">` +
      `<div><b>${st.rounds}</b>раундов</div>` +
      `<div><b>${st.winRate}%</b>win rate</div>` +
      `<div><b style="color:${st.netPnl >= 0 ? '#4ad991' : '#e5616c'}">${fmtUsd(st.netPnl)}</b>net PnL</div>` +
      `</div>`
    : `<div class="row"><div style="color:#6b7484">данных пока нет</div></div>`;
  return (
    `<a class="pd-scard" href="/predict/${s.slug}">` +
    `<h3>${esc(s.title)}</h3>` +
    `<div class="tag">${esc(s.tagline)}</div>` +
    stat +
    `<span class="pd-arrow">Подробнее →</span></a>`
  );
}

/** Лайв «сейчас в работе» по всем стратегиям (клиентский опрос live.json каждой). */
function livePositionsPanel(): string {
  const list = STRATEGIES.map((s) => ({ slug: s.slug, title: s.title }));
  const rows = STRATEGIES.map(
    (s) =>
      `<div class="pl2-row"><span class="pl2-name">${esc(s.title)}</span>` +
      `<span class="pl2-pos" id="pl2-${s.slug}-pos">—</span>` +
      `<span class="pl2-timer" id="pl2-${s.slug}-t">—</span></div>`,
  ).join('');
  return (
    `<div class="pd-card"><h2>Сейчас в работе</h2><div class="pl2">${rows}</div></div>` +
    `<script>(function(){var L=${JSON.stringify(list)};var ends={};` +
    `function fmt(ms){if(ms<0)ms=0;var s=Math.floor(ms/1000);return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}` +
    `function tick(){L.forEach(function(x){var e=document.getElementById('pl2-'+x.slug+'-t');if(!e)return;var se=ends[x.slug];e.textContent=(se&&Date.now()<se)?'⏳ '+fmt(se-Date.now()):'';});}` +
    `function poll(){L.forEach(function(x){fetch('/predict/'+x.slug+'/live.json',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(d){var pe=document.getElementById('pl2-'+x.slug+'-pos');if(!pe)return;if(d){ends[x.slug]=d.slotEndMs;var p=d.position;pe.innerHTML=p?('🟢 <b class=\"'+(p.side==='UP'?'pd-up':'pd-down')+'\">'+p.side+'</b> · $'+(p.stake!=null?p.stake.toFixed(2):'—')+' · коэф '+(p.entryCoef||'—')):'⚪ нет позиции';}else{pe.textContent='нет данных';}}).catch(function(){});});}` +
    `poll();setInterval(poll,2000);setInterval(tick,1000);tick();})();</script>`
  );
}

/** Общий список последних сделок по всем стратегиям. */
function globalFeed(): string {
  const all: RecentRound[] = [];
  for (const s of STRATEGIES) {
    const st = readStatus(s);
    if (st?.recentRounds) for (const r of st.recentRounds) all.push({ ...r, _strategy: s.title });
  }
  all.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return recentRoundsTable(all.slice(0, 15), {
    title: 'Последние сделки · все стратегии',
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
    livePositionsPanel() +
    `<div class="pd-cards">${cards}</div>` +
    globalFeed() +
    `</div>`
  );
}

function renderStrategy(s: StrategyDef): string {
  const st = readStatus(s);
  const back = `<a class="pd-back" href="/predict">← все стратегии</a>`;
  const descCard = `<div class="pd-card"><h2>Как работает</h2><div class="pd-desc">${s.description.map((p) => `<p>${esc(p)}</p>`).join('')}</div></div>`;

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
      livePanel(s) +
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

  return (
    STYLES +
    `<div class="pd-wrap">${back}${header}<p class="pd-sub">${esc(s.tagline)}</p>` +
    livePanel(s) +
    descCard +
    `<div class="pd-grid">` +
    statCard('Раундов', String(st.rounds)) +
    statCard('Win rate', `${st.winRate}%`) +
    statCard('Profit factor', pf) +
    statCard('Net PnL', fmtUsd(st.netPnl), netAccent) +
    avgStakeCard +
    statCard('Режим', st.mode === 'paper' ? 'Paper' : esc(st.mode), 'muted') +
    `</div>` +
    `<div class="pd-card"><h2>Кривая накопленного PnL</h2>${equitySvg(st.equityCurve)}` +
    `<div class="pd-foot">Выигрышей: ${st.wins} · Проигрышей: ${st.losses} · ` +
    `Исходы рынка ↑${st.marketOutcomes.up}/↓${st.marketOutcomes.down}</div></div>` +
    recentRoundsTable(st.recentRounds ?? []) +
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
    app.get(`/predict/${s.slug}`, async (_req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=30');
      return pageShell(`${s.title} — /predict`, renderStrategy(s), { lang: 'ru', autoRefreshSec: 60 });
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
}

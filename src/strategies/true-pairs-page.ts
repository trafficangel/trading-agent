import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  candleSnapshot,
  fundingHistory,
  l2Book,
  type HlCandle,
  type HlFunding,
} from '../exchange/hyperliquid.js';
import {
  pairExitPrices,
  pairResidualZ,
  type PairFit,
  type PairTopOfBook,
} from '../lib/true-pairs.js';
import { getLang, pageShell } from './landing.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FEE_RATE = 0.00045;
const FEE_RT_PCT = 0.09;
const STATE_PATH = 'data/true-pairs-shadow.json';
const RESULTS_PATH = 'data/true-pairs-hourly-results.json';
const ACTIVE_ID = 'DOGE_XRP_H60';
const PAIR = { a: 'DOGE', b: 'XRP', model: 'H_F60_R14_E2', exitZ: 0.25, stopZ: 4 } as const;

type Lang = 'ru' | 'en';
type Position = {
  direction: 1 | -1;
  beta: number;
  entryAt: number;
  entryBarAt: number;
  aEntry: number;
  bEntry: number;
  zEntry: number;
  lastZ?: number;
  minZSeen?: number;
  maxZSeen?: number;
  lastCheckedAt?: number;
};
type Runtime = {
  fit?: PairFit;
  position?: Position;
  completedTrades: number;
  cumulativeNetPct: number;
  invalidReason?: string;
};
type ShadowState = {
  basketId: string;
  lastRunAt?: number;
  candidates: Record<string, Runtime>;
};
type HistoricalTrade = {
  entryAt: number;
  exitAt: number;
  holdBars: number;
  netPct: number;
  stressPct: number;
  exitReason: 'mean' | 'z-stop' | 'time' | 'rebalance';
};
type ResultsFile = {
  researchStartAt: number;
  generatedAt: string;
  featuredDivergence?: Point[];
  results: Array<{ pair: string; model: string; trades?: HistoricalTrade[] }>;
};
type Point = { t: number; actual: number; fair: number; z: number };
type Period = '30d' | '90d' | '1y' | 'all';
type PageData = {
  state: ShadowState;
  runtime: Runtime;
  points: Point[];
  historicalPoints: Point[];
  currentZ: number;
  currentNetUsd: number | null;
  currentGrossUsd: number | null;
  currentFeeUsd: number | null;
  currentFundingUsd: number | null;
  targetNetUsd: number | null;
  targetRangeUsd: [number, number] | null;
  stopNetUsd: number | null;
  history: HistoricalTrade[];
  historyGeneratedAt?: string;
  marketAt: number;
};

const t = (lang: Lang, ru: string, en: string): string => (lang === 'en' ? en : ru);

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function topOfBook(levels: Awaited<ReturnType<typeof l2Book>>['levels']): PairTopOfBook {
  const bid = Number(levels[0][0]?.px);
  const ask = Number(levels[1][0]?.px);
  if (!(bid > 0) || !(ask > bid)) throw new Error('invalid Hyperliquid top of book');
  return { bid, ask };
}

function closed(rows: HlCandle[], now: number): HlCandle[] {
  return rows.filter((row) => row.T <= now && Number(row.c) > 0).sort((a, b) => a.t - b.t);
}

function chartPoints(aRows: HlCandle[], bRows: HlCandle[], fit: PairFit): Point[] {
  const b = new Map(bRows.map((row) => [row.t, Number(row.c)]));
  return aRows.flatMap((row) => {
    const aPrice = Number(row.c);
    const bPrice = b.get(row.t);
    if (!bPrice) return [];
    const fair = Math.exp(fit.alpha + fit.beta * Math.log(bPrice) + fit.residualMean);
    return [{ t: row.t, actual: aPrice, fair, z: pairResidualZ(aPrice, bPrice, fit) }];
  });
}

function fundingMap(rows: HlFunding[], after: number, through: number): Map<number, number> {
  const rates = new Map<number, number>();
  for (const row of rows) {
    if (row.time <= after || row.time > through) continue;
    rates.set(Math.floor(row.time / HOUR_MS) * HOUR_MS, Number(row.fundingRate));
  }
  return rates;
}

function fundingSince(
  position: Position,
  exitAt: number,
  aRows: HlFunding[],
  bRows: HlFunding[],
): number {
  const a = fundingMap(aRows, position.entryAt, exitAt);
  const b = fundingMap(bRows, position.entryAt, exitAt);
  const hours: number[] = [];
  const first = Math.floor(position.entryAt / HOUR_MS) * HOUR_MS + HOUR_MS;
  const last = Math.floor(exitAt / HOUR_MS) * HOUR_MS;
  for (let hour = first; hour <= last; hour += HOUR_MS) {
    if (a.has(hour) && b.has(hour)) hours.push(hour);
  }
  return hours.reduce(
    (sum, hour) => sum + position.direction * (-a.get(hour)! * 1_000 + b.get(hour)! * 1_000),
    0,
  );
}

let cached: { expiresAt: number; promise: Promise<PageData> } | null = null;

async function loadPageData(): Promise<PageData> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = buildPageData(now).catch((error) => {
    cached = null;
    throw error;
  });
  cached = { expiresAt: now + 45_000, promise };
  return promise;
}

async function buildPageData(now: number): Promise<PageData> {
  const state = readJson<ShadowState>(STATE_PATH);
  const runtime = state?.candidates[ACTIVE_ID];
  if (!state || !runtime?.fit) throw new Error('pairs shadow state is not ready');
  const [aCandles, bCandles, aBookRaw, bBookRaw] = await Promise.all([
    candleSnapshot(PAIR.a, '1h', now - 30 * DAY_MS, now),
    candleSnapshot(PAIR.b, '1h', now - 30 * DAY_MS, now),
    l2Book(PAIR.a),
    l2Book(PAIR.b),
  ]);
  const aBook = topOfBook(aBookRaw.levels);
  const bBook = topOfBook(bBookRaw.levels);
  const midA = (aBook.bid + aBook.ask) / 2;
  const midB = (bBook.bid + bBook.ask) / 2;
  const points = chartPoints(closed(aCandles, now), closed(bCandles, now), runtime.fit);
  const currentZ = pairResidualZ(midA, midB, runtime.fit);
  let currentNetUsd: number | null = null;
  let currentGrossUsd: number | null = null;
  let currentFeeUsd: number | null = null;
  let currentFundingUsd: number | null = null;
  let targetNetUsd: number | null = null;
  let targetRangeUsd: [number, number] | null = null;
  let stopNetUsd: number | null = null;

  if (runtime.position) {
    const position = runtime.position;
    const exit = pairExitPrices(position.direction, aBook, bBook);
    const [aFunding, bFunding] = await Promise.all([
      fundingHistory(PAIR.a, position.entryAt),
      fundingHistory(PAIR.b, position.entryAt),
    ]);
    const funding = fundingSince(position, now, aFunding, bFunding);
    const aReturn = exit.a / position.aEntry - 1;
    const bReturn = exit.b / position.bEntry - 1;
    currentGrossUsd = position.direction * (aReturn - bReturn) * 1_000;
    const aExitNotional = (1_000 / position.aEntry) * exit.a;
    const bExitNotional = (1_000 / position.bEntry) * exit.b;
    currentFeeUsd = FEE_RATE * (2_000 + aExitNotional + bExitNotional);
    currentFundingUsd = funding;
    currentNetUsd = currentGrossUsd - currentFeeUsd + currentFundingUsd;

    const targetZ = position.direction === 1 ? -PAIR.exitZ : PAIR.exitZ;
    const targetSpreadMove =
      position.direction * (targetZ - position.zEntry) * runtime.fit.residualStd;
    const targetGrossPct = (targetSpreadMove / (1 + position.beta)) * 100;
    targetNetUsd = (targetGrossPct - FEE_RT_PCT) * 20;
    const targetResidualChange = (targetZ - position.zEntry) * runtime.fit.residualStd;
    const aOnly = position.direction * 1_000 * (Math.exp(targetResidualChange) - 1);
    const bOnly =
      -position.direction * 1_000 * (Math.exp(-targetResidualChange / position.beta) - 1);
    targetRangeUsd = [Math.min(aOnly, bOnly) - 1.8, Math.max(aOnly, bOnly) - 1.8];

    const stopZ = position.direction === 1 ? -PAIR.stopZ : PAIR.stopZ;
    const stopSpreadMove = position.direction * (stopZ - position.zEntry) * runtime.fit.residualStd;
    const stopGrossPct = (stopSpreadMove / (1 + position.beta)) * 100;
    stopNetUsd = (stopGrossPct - FEE_RT_PCT) * 20;
  }

  const results = readJson<ResultsFile>(RESULTS_PATH);
  const historyRow = results?.results.find(
    (row) => row.pair === `${PAIR.a}/${PAIR.b}` && row.model === PAIR.model,
  );
  return {
    state,
    runtime,
    points,
    historicalPoints: results?.featuredDivergence ?? [],
    currentZ,
    currentNetUsd,
    currentGrossUsd,
    currentFeeUsd,
    currentFundingUsd,
    targetNetUsd,
    targetRangeUsd,
    stopNetUsd,
    history: historyRow?.trades ?? [],
    historyGeneratedAt: results?.generatedAt,
    marketAt: now,
  };
}

function money(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}

function path(values: number[], width: number, height: number, min: number, max: number): string {
  const range = max - min || 1;
  return values
    .map((value, index) => {
      const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function samplePoints(points: Point[], maxPoints = 900): Point[] {
  const stride = Math.max(1, Math.ceil(points.length / maxPoints));
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1);
}

function priceChart(points: Point[], lang: Lang, entryAt?: number): string {
  if (points.length < 2)
    return `<div class="tp-empty">${t(lang, 'Недостаточно данных', 'Not enough data')}</div>`;
  const sampled = samplePoints(points);
  const base = sampled[0]!.fair;
  const actual = sampled.map((point) => (point.actual / base) * 100);
  const fair = sampled.map((point) => (point.fair / base) * 100);
  const all = [...actual, ...fair];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = Math.max(0.4, (max - min) * 0.12);
  const yMin = min - pad;
  const yMax = max + pad;
  const w = 900;
  const h = 290;
  const entryIndex = entryAt ? sampled.findIndex((point) => point.t >= entryAt) : -1;
  const entryX = entryIndex >= 0 ? (entryIndex / (sampled.length - 1)) * w : null;
  const span = sampled.at(-1)!.t - sampled[0]!.t;
  const dateLabel = (timestamp: number): string =>
    span >= 300 * DAY_MS
      ? new Date(timestamp).toISOString().slice(0, 7)
      : new Date(timestamp).toISOString().slice(5, 10);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = h * ratio;
      const label = yMax - (yMax - yMin) * ratio;
      return `<line x1="0" y1="${y}" x2="${w}" y2="${y}" class="grid"/><text x="-10" y="${y + 4}" text-anchor="end">${label.toFixed(1)}</text>`;
    })
    .join('');
  return `<svg class="tp-chart" viewBox="-58 -12 980 340" role="img" aria-label="DOGE and fair DOGE chart">
    ${grid}
    ${entryX == null ? '' : `<line x1="${entryX}" y1="0" x2="${entryX}" y2="${h}" class="entry"/><text x="${Math.min(w - 48, entryX + 7)}" y="18" class="entry-label">ENTRY</text>`}
    <path d="${path(fair, w, h, yMin, yMax)}" class="fair"/>
    <path d="${path(actual, w, h, yMin, yMax)}" class="actual"/>
    <text x="0" y="322">${dateLabel(sampled[0]!.t)}</text>
    <text x="${w}" y="322" text-anchor="end">${dateLabel(sampled.at(-1)!.t)}</text>
  </svg>`;
}

function zChart(points: Point[], entryAt?: number): string {
  if (points.length < 2) return '';
  const sampled = samplePoints(points);
  const z = sampled.map((point) => point.z);
  const bound = Math.max(5, Math.ceil(Math.max(...z.map(Math.abs))));
  const w = 900;
  const h = 180;
  const y = (value: number): number => h - ((value + bound) / (2 * bound)) * h;
  const bands = [-4, -2, 0, 2, 4]
    .map(
      (value) =>
        `<line x1="0" y1="${y(value)}" x2="${w}" y2="${y(value)}" class="z-${Math.abs(value)}"/><text x="-10" y="${y(value) + 4}" text-anchor="end">${value}</text>`,
    )
    .join('');
  const entryIndex = entryAt ? sampled.findIndex((point) => point.t >= entryAt) : -1;
  const entryX = entryIndex >= 0 ? (entryIndex / (sampled.length - 1)) * w : null;
  return `<svg class="tp-chart tp-z" viewBox="-58 -10 980 220" role="img" aria-label="spread z-score chart">
    ${bands}
    ${entryX == null ? '' : `<line x1="${entryX}" y1="0" x2="${entryX}" y2="${h}" class="entry"/>`}
    <path d="${path(z, w, h, -bound, bound)}" class="zline"/>
  </svg>`;
}

function periodPoints(data: PageData, period: Period): Point[] {
  if (period === '30d' || !data.historicalPoints.length) return data.points;
  const latest = data.historicalPoints.at(-1)?.t ?? data.marketAt;
  const since =
    period === '90d' ? latest - 90 * DAY_MS : period === '1y' ? latest - 365 * DAY_MS : 0;
  return data.historicalPoints.filter((point) => point.t >= since);
}

function deviationSummary(
  points: Point[],
  entryZ: number | null,
): {
  min: Point | null;
  max: Point | null;
  maxAbs: Point | null;
  entryPercentile: number | null;
  beyondEntry: number;
} {
  if (!points.length)
    return { min: null, max: null, maxAbs: null, entryPercentile: null, beyondEntry: 0 };
  const min = points.reduce((best, point) => (point.z < best.z ? point : best));
  const max = points.reduce((best, point) => (point.z > best.z ? point : best));
  const maxAbs = points.reduce((best, point) =>
    Math.abs(point.z) > Math.abs(best.z) ? point : best,
  );
  if (entryZ == null) return { min, max, maxAbs, entryPercentile: null, beyondEntry: 0 };
  const entryAbs = Math.abs(entryZ);
  const within = points.filter((point) => Math.abs(point.z) <= entryAbs).length;
  return {
    min,
    max,
    maxAbs,
    entryPercentile: (within / points.length) * 100,
    beyondEntry: points.filter((point) => Math.abs(point.z) >= entryAbs).length,
  };
}

function monthlyExtremes(
  points: Point[],
): Array<{ month: string; min: number; max: number; maxAbs: number }> {
  const months = new Map<string, { min: number; max: number }>();
  for (const point of points) {
    const month = new Date(point.t).toISOString().slice(0, 7);
    const row = months.get(month) ?? { min: point.z, max: point.z };
    row.min = Math.min(row.min, point.z);
    row.max = Math.max(row.max, point.z);
    months.set(month, row);
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, row]) => ({
      month,
      min: row.min,
      max: row.max,
      maxAbs: Math.max(Math.abs(row.min), Math.abs(row.max)),
    }));
}

function historyStats(trades: HistoricalTrade[]): {
  n: number;
  perMonth: number;
  mean: number;
  stops: number;
  expiry: number;
  winners: number;
  avgHold: number;
  net: number;
  stress: number;
} {
  if (!trades.length)
    return {
      n: 0,
      perMonth: 0,
      mean: 0,
      stops: 0,
      expiry: 0,
      winners: 0,
      avgHold: 0,
      net: 0,
      stress: 0,
    };
  const first = Math.min(...trades.map((trade) => trade.entryAt));
  const last = Math.max(...trades.map((trade) => trade.exitAt));
  const months = Math.max(1, (last - first) / (30.44 * DAY_MS));
  return {
    n: trades.length,
    perMonth: trades.length / months,
    mean: trades.filter((trade) => trade.exitReason === 'mean').length,
    stops: trades.filter((trade) => trade.exitReason === 'z-stop').length,
    expiry: trades.filter(
      (trade) => trade.exitReason === 'time' || trade.exitReason === 'rebalance',
    ).length,
    winners: trades.filter((trade) => trade.netPct > 0).length,
    avgHold: trades.reduce((sum, trade) => sum + trade.holdBars, 0) / trades.length,
    net: trades.reduce((sum, trade) => sum + trade.netPct, 0),
    stress: trades.reduce((sum, trade) => sum + trade.stressPct, 0),
  };
}

function renderPage(data: PageData, lang: Lang, period: Period): string {
  const position = data.runtime.position;
  const stats = historyStats(data.history);
  const selectedPoints = periodPoints(data, period);
  const monthSummary = deviationSummary(data.points, position?.zEntry ?? null);
  const months = monthlyExtremes(data.historicalPoints).slice(-12);
  const currentClass = (data.currentNetUsd ?? 0) >= 0 ? 'pos' : 'neg';
  const targetRange = data.targetRangeUsd
    ? `$${data.targetRangeUsd[0].toFixed(0)}–$${data.targetRangeUsd[1].toFixed(0)}`
    : '—';
  const periodLabels: Array<[Period, string]> = [
    ['30d', '30D'],
    ['90d', '90D'],
    ['1y', '1Y'],
    ['all', 'ALL'],
  ];
  const periodTabs = periodLabels
    .map(
      ([value, label]) =>
        `<a href="/lab/pairs?period=${value}" class="${period === value ? 'active' : ''}">${label}</a>`,
    )
    .join('');
  const strongerText =
    monthSummary.entryPercentile == null
      ? '—'
      : t(
          lang,
          `${monthSummary.beyondEntry} из ${data.points.length} часовых точек были сильнее входа`,
          `${monthSummary.beyondEntry} of ${data.points.length} hourly points exceeded entry`,
        );
  const body = `
    <style>${CSS}</style>
    <div class="tp-head">
      <div>
        <div class="tp-kicker">TRUE PAIRS · HYPERLIQUID · FORWARD SHADOW</div>
        <h1>DOGE / XRP</h1>
        <p>${t(lang, 'Торгуем возврат относительной цены к статистической норме, а не направление рынка.', 'Trading the relative price back toward its statistical norm, not market direction.')}</p>
      </div>
      <div class="tp-live"><span></span>${position ? t(lang, 'позиция открыта', 'position open') : t(lang, 'ждём сигнал', 'waiting for signal')}</div>
    </div>

    <div class="tp-stats">
      <div class="tp-stat"><div class="k">Z-SCORE</div><div class="v">${data.currentZ.toFixed(2)}</div><div class="s">entry ${position?.zEntry.toFixed(2) ?? '—'} · target −0.25</div></div>
      <div class="tp-stat"><div class="k">$1000 + $1000 · ${t(lang, 'сейчас', 'now')}</div><div class="v ${currentClass}">${money(data.currentNetUsd)}</div><div class="s">gross ${money(data.currentGrossUsd)} · fee ${money(data.currentFeeUsd == null ? null : -data.currentFeeUsd)}</div></div>
      <div class="tp-stat"><div class="k">${t(lang, 'СЦЕНАРИЙ ДО ЦЕЛИ', 'TARGET SCENARIO')}</div><div class="v pos">${targetRange}</div><div class="s">${t(lang, `beta-оценка ${money(data.targetNetUsd)}`, `beta estimate ${money(data.targetNetUsd)}`)}</div></div>
      <div class="tp-stat"><div class="k">${t(lang, 'СЦЕНАРИЙ ДО СТОПА', 'STOP SCENARIO')}</div><div class="v neg">${money(data.stopNetUsd)}</div><div class="s">z ${position?.direction === 1 ? '−4.00' : '+4.00'} · fee included</div></div>
    </div>

    <div class="tp-context">
      <div><span>${t(lang, 'МИНИМУМ Z ЗА 30 ДНЕЙ', '30D MIN Z')}</span><b>${monthSummary.min?.z.toFixed(2) ?? '—'}</b><small>${monthSummary.min ? new Date(monthSummary.min.t).toISOString().slice(0, 10) : ''}</small></div>
      <div><span>${t(lang, 'МАКСИМУМ Z ЗА 30 ДНЕЙ', '30D MAX Z')}</span><b>${monthSummary.max?.z.toFixed(2) ?? '—'}</b><small>${monthSummary.max ? new Date(monthSummary.max.t).toISOString().slice(0, 10) : ''}</small></div>
      <div><span>${t(lang, 'ПЕРЦЕНТИЛЬ ВХОДА', 'ENTRY PERCENTILE')}</span><b>${monthSummary.entryPercentile?.toFixed(0) ?? '—'}%</b><small>${strongerText}</small></div>
      <div><span>${t(lang, 'ХУДШИЙ Z ПОСЛЕ ВХОДА', 'WORST Z SINCE ENTRY')}</span><b>${position ? (position.direction === 1 ? Math.min(position.zEntry, position.minZSeen ?? data.currentZ) : Math.max(position.zEntry, position.maxZSeen ?? data.currentZ)).toFixed(2) : '—'}</b><small>${position?.lastCheckedAt ? new Date(position.lastCheckedAt).toISOString().slice(11, 16) + ' UTC' : t(lang, 'минутный монитор запускается', 'minute monitor starting')}</small></div>
    </div>

    <section class="tp-panel">
      <div class="tp-section-head"><div><h2>${t(lang, 'Фактическая и справедливая цена', 'Actual and fair price')}</h2><p>${t(lang, period === '30d' ? 'Нативные Hyperliquid 1h. Зелёная линия — DOGE; жёлтая — справедливая DOGE из XRP и beta.' : 'Исторические 1h-окна с отдельным causal fit для каждого торгового блока.', period === '30d' ? 'Native Hyperliquid 1h. Green is DOGE; yellow is fair DOGE from XRP and beta.' : 'Historical 1h windows with a separate causal fit for each trading block.')}</p></div><div><div class="tp-periods">${periodTabs}</div><div class="legend"><span class="a">DOGE</span><span class="f">FAIR DOGE</span></div></div></div>
      ${priceChart(selectedPoints, lang, position?.entryBarAt)}
    </section>

    <section class="tp-panel">
      <div class="tp-section-head"><div><h2>Z-score</h2><p>${t(lang, 'Ноль — модельное равновесие. Пунктир ±2 — зона входа, ±4 — защитный выход.', 'Zero is model equilibrium. Dashed ±2 marks entry territory; ±4 is the protective exit.')}</p></div></div>
      ${zChart(selectedPoints, position?.entryBarAt)}
    </section>

    ${months.length ? `<section class="tp-history"><div class="tp-section-head"><div><h2>${t(lang, 'Максимальные расхождения по месяцам', 'Maximum monthly divergences')}</h2><p>${t(lang, 'Минимальный и максимальный z внутри каждого causal торгового блока. Последние 12 месяцев с доступной валидной моделью.', 'Minimum and maximum z inside each causal trading block. Latest 12 months with a valid model.')}</p></div></div><div class="tp-months">${months.map((row) => `<div><span>${row.month}</span><b class="neg">${row.min.toFixed(2)}</b><i>…</i><b class="pos">${row.max.toFixed(2)}</b><strong>|z| ${row.maxAbs.toFixed(2)}</strong></div>`).join('')}</div></section>` : ''}

    <section class="tp-history">
      <div class="tp-section-head"><div><h2>${t(lang, 'Исторические расхождения', 'Historical divergences')}</h2><p>${t(lang, 'Часовые окна с фиксированным календарём, next-open исполнением, funding и комиссиями Hyperliquid.', 'Hourly fixed-calendar windows with next-open execution, funding and Hyperliquid fees.')}</p></div></div>
      ${
        stats.n
          ? `<div class="tp-stats history">
        <div class="tp-stat"><div class="k">${t(lang, 'СИГНАЛОВ', 'SIGNALS')}</div><div class="v">${stats.n}</div><div class="s">${stats.perMonth.toFixed(1)} / ${t(lang, 'месяц', 'month')}</div></div>
        <div class="tp-stat"><div class="k">${t(lang, 'СХОДИЛИСЬ К СРЕДНЕМУ', 'MEAN EXITS')}</div><div class="v">${stats.mean}</div><div class="s">${((stats.mean / stats.n) * 100).toFixed(0)}%</div></div>
        <div class="tp-stat"><div class="k">${t(lang, 'РАСХОДИЛИСЬ ДО СТОПА', 'Z-STOPS')}</div><div class="v">${stats.stops}</div><div class="s">${((stats.stops / stats.n) * 100).toFixed(0)}%</div></div>
        <div class="tp-stat"><div class="k">${t(lang, 'TIME / REFIT', 'TIME / REFIT')}</div><div class="v">${stats.expiry}</div><div class="s">avg ${stats.avgHold.toFixed(0)}h</div></div>
        <div class="tp-stat"><div class="k">${t(lang, 'ПРИБЫЛЬНЫХ NET', 'NET WINNERS')}</div><div class="v">${stats.winners}</div><div class="s">${((stats.winners / stats.n) * 100).toFixed(0)}%</div></div>
        <div class="tp-stat"><div class="k">${t(lang, 'СУММА', 'TOTAL')}</div><div class="v ${stats.net >= 0 ? 'pos' : 'neg'}">${pct(stats.net)}</div><div class="s">stress ${pct(stats.stress)}</div></div>
      </div>`
          : `<div class="tp-empty">${t(lang, 'Исторический журнал пересчитывается. Forward-график уже работает.', 'Historical trade log is being rebuilt. The forward chart is already live.')}</div>`
      }
    </section>

    <div class="tp-note">${t(lang, 'Важно: большое |z| означает редкое отклонение, а не гарантированную прибыль. Новые сигналы считаются по закрытой 1h-свече, открытая позиция и стоп проверяются каждую минуту. Усреднения нет: при |z| = 4 обе ноги закрываются. Все суммы — модель для двух ног по $1000; реальные ордера не отправляются.', 'Important: a large |z| means a rare deviation, not guaranteed profit. New signals use closed 1h candles; an open position and stop are checked every minute. There is no averaging: both legs close at |z| = 4. Dollar figures model two $1,000 legs; no real orders are sent.')}</div>
  `;
  return pageShell(`${PAIR.a}/${PAIR.b} pairs shadow · Robot Claude`, body, {
    lang,
    autoRefreshSec: 60,
    robots: 'noindex, follow',
  });
}

export function truePairsHero(lang: Lang): string {
  const state = readJson<ShadowState>(STATE_PATH);
  const open = state
    ? Object.values(state.candidates).filter((runtime) => runtime.position).length
    : 0;
  const closedCount = state
    ? Object.values(state.candidates).reduce((sum, runtime) => sum + runtime.completedTrades, 0)
    : 0;
  return `<a class="lt-hero" href="/lab/pairs">
    <div class="lt-hero-l">
      <span class="lt-hero-badge">TRUE PAIRS · Hyperliquid · SHADOW</span>
      <div class="lt-hero-title">DOGE / XRP</div>
      <div class="lt-hero-sub">${t(lang, 'Две ноги, живой спред и график схождения', 'Two legs, live spread and convergence chart')}</div>
    </div>
    <div class="lt-hero-r">
      <div class="lt-hero-stat"><div class="v">${open}</div><div class="k">${t(lang, 'открыто', 'open')}</div></div>
      <div class="lt-hero-stat"><div class="v">${closedCount}</div><div class="k">${t(lang, 'закрыто', 'closed')}</div></div>
    </div>
  </a>`;
}

export async function truePairsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { period?: string } }>('/lab/pairs', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    try {
      const period: Period = ['30d', '90d', '1y', 'all'].includes(req.query.period ?? '')
        ? (req.query.period as Period)
        : '30d';
      return renderPage(await loadPageData(), getLang(req), period);
    } catch {
      reply.code(503);
      return pageShell(
        'True pairs · Robot Claude',
        `<div class="header"><h1 class="title">True pairs</h1><p class="subtitle">${t(getLang(req), 'Данные временно обновляются. Страница попробует снова через минуту.', 'Data is refreshing. The page will retry in one minute.')}</p></div>`,
        { lang: getLang(req), autoRefreshSec: 60, robots: 'noindex, follow' },
      );
    }
  });
}

const CSS = `
  .tp-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin:18px 0 26px}
  .tp-kicker{font-size:11px;font-weight:700;color:var(--accent);letter-spacing:.08em;margin-bottom:8px}
  .tp-head h1{font-size:38px;line-height:1.05;margin:0 0 8px;letter-spacing:0}.tp-head p{margin:0;color:var(--text-dim);max-width:680px}
  .tp-live{font-size:12px;color:var(--text-dim);white-space:nowrap}.tp-live span{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:7px;box-shadow:0 0 0 4px var(--accent-soft)}
  .tp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:22px}.tp-stats.history{grid-template-columns:repeat(3,minmax(0,1fr));margin:0}
  .tp-stat{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px;min-width:0}.tp-stat .k{font-size:10px;color:var(--text-faint);font-weight:700}.tp-stat .v{font-size:25px;font-weight:650;margin:5px 0 2px;font-variant-numeric:tabular-nums}.tp-stat .s{font-size:11px;color:var(--text-dim);white-space:normal}.pos{color:var(--accent)!important}.neg{color:var(--danger)!important}
  .tp-context{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:2px 0 18px}.tp-context>div{padding:12px 14px;border-right:1px solid var(--border);min-width:0}.tp-context>div:last-child{border-right:0}.tp-context span,.tp-context small{display:block;font-size:9px;color:var(--text-faint)}.tp-context b{display:block;font-size:18px;margin:3px 0;font-variant-numeric:tabular-nums}.tp-context small{font-size:10px;color:var(--text-dim);white-space:normal}
  .tp-panel,.tp-history{border-top:1px solid var(--border);padding:25px 0;margin-top:12px}.tp-section-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:14px}.tp-section-head h2{font-size:18px;margin:0 0 4px;letter-spacing:0}.tp-section-head p{font-size:12px;color:var(--text-dim);margin:0}.legend{display:flex;gap:14px;font-size:10px;font-weight:700;white-space:nowrap}.legend span:before{content:'';display:inline-block;width:18px;height:3px;margin-right:6px;vertical-align:middle}.legend .a:before{background:#4ad991}.legend .f:before{background:#f4c95d}
  .tp-periods{display:flex;border:1px solid var(--border);margin:0 0 10px auto;width:max-content}.tp-periods a{padding:5px 9px;color:var(--text-dim);font-size:10px;font-weight:700;text-decoration:none;border-right:1px solid var(--border)}.tp-periods a:last-child{border-right:0}.tp-periods a.active{background:var(--accent-soft);color:var(--accent)}
  .tp-chart{display:block;width:100%;height:auto;overflow:visible}.tp-chart text{fill:var(--text-faint);font-size:10px}.tp-chart .grid{stroke:var(--border);stroke-width:1}.tp-chart path{fill:none;stroke-linejoin:round;stroke-linecap:round}.tp-chart .actual{stroke:#4ad991;stroke-width:2.2}.tp-chart .fair{stroke:#f4c95d;stroke-width:2}.tp-chart .entry{stroke:#e36b6b;stroke-width:1.2;stroke-dasharray:5 5}.tp-chart .entry-label{fill:#e36b6b;font-weight:700}.tp-z .zline{stroke:#67a9e8;stroke-width:2}.tp-z .z-0{stroke:var(--text-faint);stroke-width:1}.tp-z .z-2{stroke:#f4c95d;stroke-width:1;stroke-dasharray:5 5}.tp-z .z-4{stroke:#e36b6b;stroke-width:1;stroke-dasharray:5 5}
  .tp-empty{padding:28px 0;color:var(--text-dim);font-size:13px}.tp-note{border-left:3px solid #f4c95d;padding:12px 14px;margin:18px 0;color:var(--text-dim);font-size:12px;background:var(--bg-card)}
  .tp-months{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--border);border-left:1px solid var(--border)}.tp-months>div{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:9px 10px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);font-size:11px;font-variant-numeric:tabular-nums}.tp-months span{color:var(--text-dim)}.tp-months i{color:var(--text-faint);font-style:normal}.tp-months strong{grid-column:1/-1;color:var(--text-faint);font-size:9px;font-weight:600}
  @media(max-width:800px){.tp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.tp-stats.history{grid-template-columns:repeat(2,minmax(0,1fr))}.tp-context{grid-template-columns:repeat(2,minmax(0,1fr))}.tp-context>div:nth-child(2){border-right:0}.tp-months{grid-template-columns:repeat(2,minmax(0,1fr))}.tp-head{align-items:flex-start}.tp-head h1{font-size:32px}}
  @media(max-width:520px){.tp-head{display:block}.tp-live{margin-top:14px}.tp-stats,.tp-stats.history{grid-template-columns:1fr 1fr}.tp-stat .v{font-size:20px}.tp-section-head{display:block}.legend{margin-top:10px}.tp-chart{min-height:180px}.tp-head h1{font-size:30px}}
`;

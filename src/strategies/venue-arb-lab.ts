import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getLang, pageShell } from './landing.js';

type Lang = 'ru' | 'en';
type Venue =
  | 'lighter'
  | 'hyperliquid'
  | 'paradex'
  | 'polymarket'
  | 'extended'
  | 'aster'
  | 'binance'
  | 'bybit';
type SurvivalRow = {
  sampled?: number;
  observedAtHorizon?: number;
  rawPositivePct?: number | null;
  netPositivePct?: number | null;
};
type Summary = {
  closed?: number;
  viable?: number;
  viablePct?: number | null;
  medianPeakRawBps?: number | null;
  p95PeakRawBps?: number | null;
  medianPeakNetBps?: number | null;
  medianViablePeakNetBps?: number | null;
  maxPeakNetBps?: number | null;
  medianDurationMs?: number | null;
  medianViableDurationMs?: number | null;
  medianHalfLifeMs?: number | null;
  survival?: Record<string, SurvivalRow>;
};
type Opportunity = {
  id?: string;
  coin?: string;
  buyVenue?: Venue;
  sellVenue?: Venue;
  route?: string;
  startedAt?: number;
  closedAt?: number | null;
  durationMs?: number | null;
  closeReason?: string | null;
  startRawBps?: number;
  startNetBps?: number;
  startRawBps1000?: number;
  startNetBps1000?: number;
  peakRawBps?: number;
  peakNetBps?: number;
  peakRawBps1000?: number;
  peakNetBps1000?: number;
  currentRawBps?: number;
  currentNetBps?: number;
  currentRawBps1000?: number | null;
  currentNetBps1000?: number | null;
  currentExecutable1000?: boolean;
  currentBuyVwap500?: number;
  currentSellVwap500?: number;
  currentBuyVwap1000?: number | null;
  currentSellVwap1000?: number | null;
  currentBuyDepthUsd?: number;
  currentSellDepthUsd?: number;
  currentBuyBookAgeMs?: number;
  currentSellBookAgeMs?: number;
  halfLifeMs?: number | null;
  convergenceMs?: number | null;
  executable1000AtStart?: boolean;
  roundTripCostBps?: number;
  horizons?: Record<string, {
    rawBps?: number;
    netBps?: number;
    rawBps1000?: number | null;
    netBps1000?: number | null;
    executable1000?: boolean;
  }>;
};
type Status = {
  version?: string;
  readOnly?: boolean;
  startedAt?: number;
  updatedAt?: number;
  sampleMs?: number;
  staleMs?: number;
  netTriggerBps?: number;
  executionBufferBps?: number;
  notionalsUsd?: number[];
  feesBpsPerSide?: Partial<Record<Venue, number>>;
  markets?: string[];
  venues?: Array<{ venue?: Venue; class?: string }>;
  connections?: Partial<Record<Venue, {
    connected?: boolean;
    messages?: number;
    reconnects?: number;
    lastMessageAt?: number;
  }>>;
  evaluations?: number;
  active?: Opportunity[];
  recentClosed?: Opportunity[];
  summary?: Summary;
  groupedSummaries?: Record<string, Summary>;
  freshnessMs?: Record<string, Partial<Record<Venue, number | null>>>;
};

const VENUES: readonly Venue[] = [
  'lighter',
  'hyperliquid',
  'paradex',
  'polymarket',
  'extended',
  'aster',
  'binance',
  'bybit',
];
const t = (lang: Lang, ru: string, en: string): string => lang === 'en' ? en : ru;
const dataRoot = (): string => process.env.VENUE_ARB_DATA_DIR
  ?? '/home/trader/apps/trading-agent/data/venue-arb';
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));

async function readStatus(): Promise<Status | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(dataRoot(), 'status.json'), 'utf8'),
    ) as Status;
  } catch {
    return null;
  }
}

function pctFromBps(value: unknown, signed = true): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const pct = number / 100;
  const sign = signed && pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(3)}%`;
}

function pct(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number.toFixed(1)}%`;
}

function duration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function price(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number >= 1_000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(4);
  return number.toFixed(6);
}

function usdDepth(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number >= 1_000_000) return `$${(number / 1_000_000).toFixed(1)}m`;
  if (number >= 1_000) return `$${Math.floor(number / 1_000)}k`;
  return `$${Math.floor(number)}`;
}

function legacyNet1000Bps(row: Opportunity): number | null {
  const buy = Number(row.currentBuyVwap1000);
  const sell = Number(row.currentSellVwap1000);
  const cost = Number(row.roundTripCostBps);
  if (!Number.isFinite(buy) || !Number.isFinite(sell) || !Number.isFinite(cost) || buy <= 0) {
    return null;
  }
  return ((sell - buy) / buy) * 10_000 - cost;
}

function currentNet1000Bps(row: Opportunity): number | null {
  const value = Number(row.currentNetBps1000);
  if (Number.isFinite(value)) return value;
  return legacyNet1000Bps(row);
}

function utc(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(5, 19).replace('T', ' ');
}

function cls(value: unknown): string {
  const number = Number(value);
  return number > 0 ? 'pos' : number < 0 ? 'neg' : '';
}

function live(status: Status | null): boolean {
  if (!status?.updatedAt || Date.now() - status.updatedAt > 15_000) return false;
  return VENUES.every((venue) => status.connections?.[venue]?.connected);
}

function activeRows(rows: Opportunity[], triggerBps: number): string {
  const profitable = rows.filter((row) => (
    Number(currentNet1000Bps(row)) > triggerBps
  ));
  if (!profitable.length) {
    return `<div class="va-empty">Сейчас нет расхождений с net не ниже ${pctFromBps(triggerBps)} на объёме $1,000 после всех комиссий.</div>`;
  }
  const now = Date.now();
  return `<div class="va-table"><table><thead><tr>
    <th>Монета</th><th>Купить → продать</th><th>Net $1,000</th><th>Net $500</th>
    <th>VWAP $1,000</th><th>Доступная глубина</th><th>Возраст стакана</th><th>Net-окно</th>
  </tr></thead><tbody>${profitable.map((row) => {
    const net1000 = currentNet1000Bps(row);
    const depth = Math.min(
      Number(row.currentBuyDepthUsd ?? 0),
      Number(row.currentSellDepthUsd ?? 0),
    );
    const bookAge = Math.max(
      Number(row.currentBuyBookAgeMs ?? 0),
      Number(row.currentSellBookAgeMs ?? 0),
    );
    return `<tr>
      <td><b>${esc(row.coin)}</b><small class="va-route">${esc(row.route)}</small></td>
      <td>${esc(row.buyVenue)} → ${esc(row.sellVenue)}</td>
      <td class="${cls(net1000)}"><b>${net1000 == null ? 'нет глубины' : pctFromBps(net1000)}</b></td>
      <td class="${cls(row.currentNetBps ?? row.startNetBps)}">${pctFromBps(row.currentNetBps ?? row.startNetBps)}</td>
      <td>${price(row.currentBuyVwap1000)} → ${price(row.currentSellVwap1000)}</td>
      <td>${usdDepth(depth)} <small>min двух ног</small></td>
      <td>${duration(bookAge)}</td>
      <td>${duration(now - Number(row.startedAt ?? now))}</td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function routeRows(groups: Record<string, Summary>): string {
  const routeKeys = ['DEX→CEX', 'CEX→DEX', 'DEX→DEX', 'CEX→CEX'];
  return routeKeys.flatMap((route) => {
    const summary = groups[`route:${route}`] ?? {};
    if (Number(summary.viable ?? 0) <= 0) return [];
    const survival = summary.survival ?? {};
    return `<tr>
      <td><b>${route}</b></td><td>${Number(summary.viable ?? 0)} / ${Number(summary.closed ?? 0)}</td>
      <td>${pct(summary.viablePct)}</td>
      <td class="pos">${pctFromBps(summary.medianViablePeakNetBps)}</td>
      <td class="pos">${pctFromBps(summary.maxPeakNetBps)}</td>
      <td>${duration(summary.medianViableDurationMs)}</td>
      <td>${pct(survival['100']?.netPositivePct)}</td>
      <td>${pct(survival['250']?.netPositivePct)}</td>
      <td>${pct(survival['500']?.netPositivePct)}</td>
      <td>${pct(survival['1000']?.netPositivePct)}</td>
    </tr>`;
  }).join('');
}

function pairRows(groups: Record<string, Summary>): string {
  return Object.entries(groups)
    .filter(([key, summary]) => key.startsWith('pair:') && Number(summary.viable ?? 0) > 0)
    .sort((a, b) => Number(b[1].viable ?? 0) - Number(a[1].viable ?? 0)
      || Number(b[1].medianPeakNetBps ?? -Infinity) - Number(a[1].medianPeakNetBps ?? -Infinity))
    .map(([key, summary]) => `<tr>
      <td><b>${esc(key.slice(5))}</b></td><td>${Number(summary.viable ?? 0)} / ${Number(summary.closed ?? 0)}</td>
      <td>${pct(summary.viablePct)}</td>
      <td class="pos">${pctFromBps(summary.medianViablePeakNetBps)}</td>
      <td class="pos">${pctFromBps(summary.maxPeakNetBps)}</td>
      <td>${duration(summary.medianViableDurationMs)}</td>
    </tr>`).join('');
}

function historyRows(rows: Opportunity[]): string {
  const profitable = rows.filter((row) => Number(row.peakNetBps1000) > 0);
  if (!profitable.length) return '<div class="va-empty">Завершённых прибыльных расхождений после всех комиссий пока нет.</div>';
  return `<div class="va-table"><table><thead><tr>
    <th>UTC</th><th>Монета</th><th>Маршрут</th><th>Пара</th>
    <th>Raw $1k старт → пик</th><th>Net $1k старт → пик</th><th>Жизнь</th>
    <th>Half-life</th><th>Net $1k через 250 / 500 / 1000 ms</th><th>Финиш</th>
  </tr></thead><tbody>${profitable.slice(0, 100).map((row) => {
    const horizon = row.horizons ?? {};
    return `<tr>
      <td>${utc(row.startedAt)}</td><td><b>${esc(row.coin)}</b></td><td>${esc(row.route)}</td>
      <td>${esc(row.buyVenue)} → ${esc(row.sellVenue)}</td>
      <td>${pctFromBps(row.startRawBps1000)} → ${pctFromBps(row.peakRawBps1000)}</td>
      <td class="${cls(row.peakNetBps1000)}">${pctFromBps(row.startNetBps1000)} → <b>${pctFromBps(row.peakNetBps1000)}</b></td>
      <td>${duration(row.durationMs)}</td><td>${duration(row.halfLifeMs)}</td>
      <td>${pctFromBps(horizon['250']?.netBps1000)} / ${pctFromBps(horizon['500']?.netBps1000)} / ${pctFromBps(horizon['1000']?.netBps1000)}</td>
      <td>${row.closeReason === 'converged' ? 'схождение' : row.closeReason === 'insufficient_depth' ? 'нет $1k глубины' : row.closeReason === 'max_lifetime' ? '≥ 15 min' : esc(row.closeReason)}</td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function feedRows(status: Status): string {
  const freshness = status.freshnessMs ?? {};
  return (status.markets ?? []).map((coin) => `<tr><td><b>${esc(coin)}</b></td>${VENUES.map((venue) => {
    const age = freshness[coin]?.[venue];
    const fresh = age != null && age <= (venue === 'hyperliquid' ? 10_000 : Number(status.staleMs ?? 1_000));
    return `<td class="${fresh ? 'pos' : 'neg'}">${age == null ? 'нет данных' : duration(age)}</td>`;
  }).join('')}</tr>`).join('');
}

async function render(lang: Lang): Promise<string> {
  const status = await readStatus();
  const isLive = live(status);
  const summary = status?.summary ?? {};
  const groups = status?.groupedSummaries ?? {};
  const connections = status?.connections ?? {};
  const connected = VENUES.filter((venue) => connections[venue]?.connected).length;
  const triggerBps = Number(status?.netTriggerBps ?? 3);
  const profitableActive = (status?.active ?? [])
    .filter((row) => Number(currentNet1000Bps(row)) > triggerBps);
  const survival250 = summary.survival?.['250'];
  return pageShell(
    t(lang, 'DEX/CEX Perp Arbitrage Radar', 'DEX/CEX Perp Arbitrage Radar'),
    `<style>${VENUE_ARB_CSS}</style>
    <div class="va-wrap">
      <a class="va-back" href="/lab">← Лаборатория</a>
      <div class="va-head"><div>
        <span class="va-badge">READ-ONLY · DEX ↔ CEX · TRADEABLE $1,000 VWAP</span>
        <h1>Perp Arbitrage Radar</h1>
        <p>Фиксирует только расхождения, исполнимые на $1,000. Net-окно начинается при остаточном edge выше ${pctFromBps(triggerBps)} после полного цикла из четырёх taker-ордеров, VWAP и защитного буфера, и заканчивается при net ≤ 0%.</p>
      </div><div class="va-engine ${isLive ? 'live' : ''}"><i></i>${isLive ? 'РАБОТАЕТ' : 'НЕТ СВЕЖИХ ДАННЫХ'}</div></div>

      <div class="va-cards">
        <div class="va-card"><small>Потоки</small><b>${connected}/${VENUES.length}</b><em>Lighter · Hyperliquid · Paradex · Polymarket · Extended · Aster · Binance · Bybit</em></div>
        <div class="va-card"><small>Допуск сейчас</small><b class="${profitableActive.length ? 'pos' : ''}">${profitableActive.length}</b><em>$1,000 net &gt; ${pctFromBps(triggerBps)}</em></div>
        <div class="va-card"><small>Tradeable окон завершено</small><b class="${Number(summary.viable ?? 0) > 0 ? 'pos' : ''}">${Number(summary.viable ?? 0)}</b><em>из ${Number(summary.closed ?? 0)} честных окон</em></div>
        <div class="va-card"><small>Медиана tradeable net</small><b class="pos">${pctFromBps(summary.medianViablePeakNetBps)}</b><em>$1,000 · лучший ${pctFromBps(summary.maxPeakNetBps)}</em></div>
        <div class="va-card"><small>Жизнь tradeable edge</small><b>${duration(summary.medianViableDurationMs)}</b><em>$1,000 после издержек</em></div>
        <div class="va-card"><small>Net жив через 250 ms</small><b>${pct(survival250?.netPositivePct)}</b><em>${Number(survival250?.observedAtHorizon ?? 0)} дожили · N ${Number(survival250?.sampled ?? 0)}</em></div>
      </div>

      <section class="va-panel"><div class="va-panel-head"><h2>Tradeable расхождения сейчас</h2><span>$1,000 net &gt; ${pctFromBps(triggerBps)} · автообновление 5 сек</span></div>
        ${activeRows(status?.active ?? [], triggerBps)}
      </section>

      <section class="va-panel"><h2>Прибыльные типы маршрутов</h2>
        <p>Показываются только маршруты, где $1,000 VWAP на старте давал net выше ${pctFromBps(triggerBps)} после входа и выхода обеих ног: четырёх taker-комиссий и ${pctFromBps(status?.executionBufferBps, false)} защитного буфера.</p>
        <div class="va-table"><table><thead><tr><th>Маршрут</th><th>Net+ / все</th><th>Доля</th><th>Медиана прибыльного net</th><th>Лучший net</th><th>Жизнь</th><th>100 ms</th><th>250 ms</th><th>500 ms</th><th>1000 ms</th></tr></thead>
          <tbody>${routeRows(groups) || '<tr><td colspan="10">Прибыльных маршрутов пока нет.</td></tr>'}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>Прибыльные биржевые направления</h2>
        <div class="va-table"><table><thead><tr><th>Купить → продать</th><th>Net+ / все</th><th>Доля</th><th>Медиана прибыльного net</th><th>Лучший net</th><th>Жизнь</th></tr></thead>
          <tbody>${pairRows(groups) || '<tr><td colspan="6">Прибыльных направлений пока нет.</td></tr>'}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>История прибыльных расхождений</h2>${historyRows(status?.recentClosed ?? [])}</section>

      <section class="va-panel"><h2>Свежесть стаканов</h2>
        <div class="va-table"><table><thead><tr><th>Монета</th>${VENUES.map((venue) => `<th>${venue}</th>`).join('')}</tr></thead>
          <tbody>${status ? feedRows(status) : ''}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>Что именно проверяем</h2>
        <div class="va-rules">
          <span>глубина минимум $500</span><span>контроль $1,000</span><span>шаг 100 ms</span>
          <span>VWAP, не mid-price</span><span>две ноги одновременно</span><span>полный round-trip</span>
          <span>допуск только при $1k net &gt; ${pctFromBps(triggerBps)}</span><span>Lighter fee 0%</span><span>никаких ключей и ордеров</span>
        </div>
        <p>Сейчас это измеритель, а не торговый робот. Допуск к микрореалу появится только если на достаточной выборке DEX↔CEX или DEX↔DEX маршрут показывает положительный net после 250–500 ms, достаточную глубину и повторяемость на нескольких монетах.</p>
      </section>
    </div>`,
    { autoRefreshSec: 5, lang },
  );
}

export async function venueArbHero(lang: Lang): Promise<string> {
  const status = await readStatus();
  const isLive = live(status);
  const summary = status?.summary ?? {};
  const triggerBps = Number(status?.netTriggerBps ?? 3);
  const profitableActive = (status?.active ?? [])
    .filter((row) => Number(currentNet1000Bps(row)) > triggerBps).length;
  return `<a class="va-hero" href="/lab/venue-arb">
    <div><span class="va-badge">⚡ DEX ↔ CEX · PERP ARBITRAGE · READ-ONLY</span>
      <div class="va-title">Executable Divergence Radar</div>
      <div class="va-sub">${t(lang, '8 площадок · $1,000 net после комиссий · скорость схождения →', '8 venues · $1,000 net after fees · convergence speed →')}</div>
    </div>
    <div class="va-hero-stats">
      <span><b class="${isLive ? 'pos' : 'neg'}">${isLive ? 'LIVE' : 'OFFLINE'}</b><small>engine</small></span>
      <span><b>${profitableActive}</b><small>net+ live</small></span>
      <span><b>${Number(summary.viable ?? 0)}</b><small>net+ closed</small></span>
      <span><b class="${Number(summary.viable ?? 0) > 0 ? 'pos' : ''}">${Number(summary.viable ?? 0)}</b><small>net+</small></span>
    </div>
  </a>`;
}

export async function venueArbLabRoute(app: FastifyInstance): Promise<void> {
  app.get('/lab/venue-arb', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=3');
    return render(getLang(req));
  });
}

export const VENUE_ARB_CSS = `
.va-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:0 0 14px;padding:17px 20px;border:1px solid rgba(164,104,255,.38);border-radius:14px;background:linear-gradient(135deg,rgba(137,79,255,.15),var(--bg-card));color:var(--text);text-decoration:none}.va-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(137,79,255,.15);color:#b58aff;font-size:11px;font-weight:750;letter-spacing:.04em}.va-title{font-size:19px;font-weight:700;margin-top:8px}.va-sub{font-size:13px;color:var(--text-dim);margin-top:3px}.va-hero-stats{display:flex;gap:22px}.va-hero-stats span{display:grid;text-align:right}.va-hero-stats b{font-size:18px}.va-hero-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}.va-wrap{max-width:1180px;margin:0 auto}.va-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}.va-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.va-head h1{font-size:34px;margin:12px 0 7px}.va-head p{max-width:790px;color:var(--text-dim)}.va-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.va-engine i{width:8px;height:8px;border-radius:50%;background:#ff6577}.va-engine.live i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}.va-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.va-card,.va-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.va-card{padding:16px;display:grid;gap:5px}.va-card small,.va-card em{color:var(--text-faint);font-size:11px;font-style:normal}.va-card b{font-size:25px;font-variant-numeric:tabular-nums}.va-panel{padding:18px;margin:12px 0}.va-panel h2{font-size:17px;margin:0 0 14px}.va-panel p{color:var(--text-dim);font-size:13px}.va-panel-head{display:flex;justify-content:space-between;gap:12px}.va-panel-head span{font-size:12px;color:var(--text-faint)}.va-table{overflow:auto}.va-table table{width:100%;border-collapse:collapse;font-size:12px}.va-table th,.va-table td{text-align:left;padding:9px;border-bottom:1px solid var(--border);white-space:nowrap}.va-table th{color:var(--text-faint);font-size:10px;text-transform:uppercase}.va-route{padding:3px 7px;border-radius:7px;background:rgba(137,79,255,.13);color:#b58aff}.va-rules{display:flex;flex-wrap:wrap;gap:7px}.va-rules span{padding:6px 9px;border-radius:8px;background:var(--bg);font-size:12px}.va-empty{padding:22px;text-align:center;color:var(--text-faint)}.va-wrap .pos,.va-hero .pos{color:#38d996}.va-wrap .neg,.va-hero .neg{color:#ff6577}@media(max-width:760px){.va-cards{grid-template-columns:repeat(2,1fr)}.va-head{display:block}.va-engine{display:inline-flex;margin-top:8px}.va-hero-stats{width:100%;justify-content:space-between}.va-hero-stats span{text-align:left}}@media(max-width:460px){.va-cards{grid-template-columns:1fr}.va-head h1{font-size:27px}}
`;

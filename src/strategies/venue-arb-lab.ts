import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getLang, pageShell } from './landing.js';

type Lang = 'ru' | 'en';
type Venue = 'lighter' | 'hyperliquid' | 'paradex' | 'binance' | 'bybit';
type SurvivalRow = {
  sampled?: number;
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
  medianDurationMs?: number | null;
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
  peakRawBps?: number;
  peakNetBps?: number;
  currentRawBps?: number;
  currentNetBps?: number;
  currentExecutable1000?: boolean;
  halfLifeMs?: number | null;
  convergenceMs?: number | null;
  executable1000AtStart?: boolean;
  roundTripCostBps?: number;
  horizons?: Record<string, { rawBps?: number; netBps?: number; executable1000?: boolean }>;
};
type Status = {
  version?: string;
  readOnly?: boolean;
  startedAt?: number;
  updatedAt?: number;
  sampleMs?: number;
  staleMs?: number;
  rawTriggerBps?: number;
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

const VENUES: readonly Venue[] = ['lighter', 'hyperliquid', 'paradex', 'binance', 'bybit'];
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

function activeRows(rows: Opportunity[]): string {
  if (!rows.length) return '<div class="va-empty">Сейчас расхождений выше порога нет.</div>';
  const now = Date.now();
  return `<div class="va-table"><table><thead><tr>
    <th>Монета</th><th>Маршрут</th><th>Купить</th><th>Продать</th>
    <th>Raw</th><th>Net полного цикла</th><th>Пик net</th><th>Жизнь</th><th>$1,000</th>
  </tr></thead><tbody>${rows.map((row) => `<tr>
    <td><b>${esc(row.coin)}</b></td><td><span class="va-route">${esc(row.route)}</span></td>
    <td>${esc(row.buyVenue)}</td><td>${esc(row.sellVenue)}</td>
    <td>${pctFromBps(row.currentRawBps ?? row.startRawBps)}</td>
    <td class="${cls(row.currentNetBps ?? row.startNetBps)}"><b>${pctFromBps(row.currentNetBps ?? row.startNetBps)}</b></td>
    <td class="${cls(row.peakNetBps)}">${pctFromBps(row.peakNetBps)}</td>
    <td>${duration(now - Number(row.startedAt ?? now))}</td>
    <td>${(row.currentExecutable1000 ?? row.executable1000AtStart) ? '✓' : '—'}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

function routeRows(groups: Record<string, Summary>): string {
  const routeKeys = ['DEX→CEX', 'CEX→DEX', 'DEX→DEX', 'CEX→CEX'];
  return routeKeys.map((route) => {
    const summary = groups[`route:${route}`] ?? {};
    const survival = summary.survival ?? {};
    return `<tr>
      <td><b>${route}</b></td><td>${Number(summary.closed ?? 0)}</td>
      <td>${pct(summary.viablePct)}</td>
      <td>${pctFromBps(summary.medianPeakRawBps, false)}</td>
      <td class="${cls(summary.medianPeakNetBps)}">${pctFromBps(summary.medianPeakNetBps)}</td>
      <td>${duration(summary.medianDurationMs)}</td>
      <td>${pct(survival['100']?.netPositivePct)}</td>
      <td>${pct(survival['250']?.netPositivePct)}</td>
      <td>${pct(survival['500']?.netPositivePct)}</td>
      <td>${pct(survival['1000']?.netPositivePct)}</td>
    </tr>`;
  }).join('');
}

function pairRows(groups: Record<string, Summary>): string {
  return Object.entries(groups)
    .filter(([key]) => key.startsWith('pair:'))
    .sort((a, b) => Number(b[1].viable ?? 0) - Number(a[1].viable ?? 0)
      || Number(b[1].medianPeakNetBps ?? -Infinity) - Number(a[1].medianPeakNetBps ?? -Infinity))
    .map(([key, summary]) => `<tr>
      <td><b>${esc(key.slice(5))}</b></td><td>${Number(summary.closed ?? 0)}</td>
      <td>${Number(summary.viable ?? 0)}</td><td>${pct(summary.viablePct)}</td>
      <td>${pctFromBps(summary.medianPeakRawBps, false)}</td>
      <td class="${cls(summary.medianPeakNetBps)}">${pctFromBps(summary.medianPeakNetBps)}</td>
      <td>${duration(summary.medianDurationMs)}</td>
    </tr>`).join('');
}

function historyRows(rows: Opportunity[]): string {
  if (!rows.length) return '<div class="va-empty">Закрытых наблюдений пока нет.</div>';
  return `<div class="va-table"><table><thead><tr>
    <th>UTC</th><th>Монета</th><th>Маршрут</th><th>Пара</th>
    <th>Raw старт → пик</th><th>Net старт → пик</th><th>Жизнь</th>
    <th>Half-life</th><th>Net через 250 / 500 / 1000 ms</th><th>Финиш</th>
  </tr></thead><tbody>${rows.slice(0, 100).map((row) => {
    const horizon = row.horizons ?? {};
    return `<tr>
      <td>${utc(row.startedAt)}</td><td><b>${esc(row.coin)}</b></td><td>${esc(row.route)}</td>
      <td>${esc(row.buyVenue)} → ${esc(row.sellVenue)}</td>
      <td>${pctFromBps(row.startRawBps)} → ${pctFromBps(row.peakRawBps)}</td>
      <td class="${cls(row.peakNetBps)}">${pctFromBps(row.startNetBps)} → <b>${pctFromBps(row.peakNetBps)}</b></td>
      <td>${duration(row.durationMs)}</td><td>${duration(row.halfLifeMs)}</td>
      <td>${pctFromBps(horizon['250']?.netBps)} / ${pctFromBps(horizon['500']?.netBps)} / ${pctFromBps(horizon['1000']?.netBps)}</td>
      <td>${row.closeReason === 'converged' ? 'схождение' : row.closeReason === 'max_lifetime' ? '≥ 15 min' : esc(row.closeReason)}</td>
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
  const survival250 = summary.survival?.['250'];
  return pageShell(
    t(lang, 'DEX/CEX Perp Arbitrage Radar', 'DEX/CEX Perp Arbitrage Radar'),
    `<style>${VENUE_ARB_CSS}</style>
    <div class="va-wrap">
      <a class="va-back" href="/lab">← Лаборатория</a>
      <div class="va-head"><div>
        <span class="va-badge">READ-ONLY · DEX ↔ CEX · $500 / $1,000 VWAP</span>
        <h1>Perp Arbitrage Radar</h1>
        <p>Фиксирует исполнимые расхождения perp-цен и измеряет, сколько преимущества остаётся после полного цикла из четырёх ордеров, комиссий и задержки.</p>
      </div><div class="va-engine ${isLive ? 'live' : ''}"><i></i>${isLive ? 'РАБОТАЕТ' : 'НЕТ СВЕЖИХ ДАННЫХ'}</div></div>

      <div class="va-cards">
        <div class="va-card"><small>Потоки</small><b>${connected}/${VENUES.length}</b><em>Lighter · Hyperliquid · Paradex · Binance · Bybit</em></div>
        <div class="va-card"><small>Активно сейчас</small><b>${status?.active?.length ?? 0}</b><em>raw ≥ ${pctFromBps(status?.rawTriggerBps, false)}</em></div>
        <div class="va-card"><small>Завершено</small><b>${Number(summary.closed ?? 0)}</b><em>компактные lifecycle-записи</em></div>
        <div class="va-card"><small>Пик net &gt; 0</small><b class="${Number(summary.viable ?? 0) > 0 ? 'pos' : ''}">${Number(summary.viable ?? 0)}</b><em>${pct(summary.viablePct)} наблюдений</em></div>
        <div class="va-card"><small>Медиана жизни</small><b>${duration(summary.medianDurationMs)}</b><em>half-life ${duration(summary.medianHalfLifeMs)}</em></div>
        <div class="va-card"><small>Net жив через 250 ms</small><b>${pct(survival250?.netPositivePct)}</b><em>N ${Number(survival250?.sampled ?? 0)}</em></div>
      </div>

      <section class="va-panel"><div class="va-panel-head"><h2>Расхождения сейчас</h2><span>автообновление 5 сек</span></div>
        ${activeRows(status?.active ?? [])}
      </section>

      <section class="va-panel"><h2>Жизнеспособность по типу маршрута</h2>
        <p>Net уже включает вход и выход обеих ног: четыре taker-комиссии плюс ${pctFromBps(status?.executionBufferBps, false)} защитного буфера. Процент survival показывает долю наблюдений, где чистое преимущество всё ещё было положительным на заданной задержке.</p>
        <div class="va-table"><table><thead><tr><th>Маршрут</th><th>N</th><th>Viable</th><th>Медиана raw peak</th><th>Медиана net peak</th><th>Жизнь</th><th>100 ms</th><th>250 ms</th><th>500 ms</th><th>1000 ms</th></tr></thead>
          <tbody>${routeRows(groups)}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>Биржевые направления</h2>
        <div class="va-table"><table><thead><tr><th>Купить → продать</th><th>N</th><th>Net+</th><th>Viable</th><th>Raw peak</th><th>Net peak</th><th>Жизнь</th></tr></thead>
          <tbody>${pairRows(groups) || '<tr><td colspan="7">Копим наблюдения.</td></tr>'}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>История расхождений</h2>${historyRows(status?.recentClosed ?? [])}</section>

      <section class="va-panel"><h2>Свежесть стаканов</h2>
        <div class="va-table"><table><thead><tr><th>Монета</th>${VENUES.map((venue) => `<th>${venue}</th>`).join('')}</tr></thead>
          <tbody>${status ? feedRows(status) : ''}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>Что именно проверяем</h2>
        <div class="va-rules">
          <span>глубина минимум $500</span><span>контроль $1,000</span><span>шаг 100 ms</span>
          <span>VWAP, не mid-price</span><span>две ноги одновременно</span><span>полный round-trip</span>
          <span>Lighter fee 0%</span><span>никаких ключей и ордеров</span>
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
  return `<a class="va-hero" href="/lab/venue-arb">
    <div><span class="va-badge">⚡ DEX ↔ CEX · PERP ARBITRAGE · READ-ONLY</span>
      <div class="va-title">Executable Divergence Radar</div>
      <div class="va-sub">${t(lang, 'Lighter + Hyperliquid + Paradex + Binance + Bybit · скорость схождения →', 'Lighter + Hyperliquid + Paradex + Binance + Bybit · convergence speed →')}</div>
    </div>
    <div class="va-hero-stats">
      <span><b class="${isLive ? 'pos' : 'neg'}">${isLive ? 'LIVE' : 'OFFLINE'}</b><small>engine</small></span>
      <span><b>${status?.active?.length ?? 0}</b><small>active</small></span>
      <span><b>${Number(summary.closed ?? 0)}</b><small>closed</small></span>
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

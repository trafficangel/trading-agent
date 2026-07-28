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
  strictStarts?: number;
  strictObserved1000?: number;
  strictPositive1000?: number;
  strictRetained1000?: number;
  strictRetained1000Pct?: number | null;
  strictMean1000NetBps?: number | null;
  strictMedian1000NetBps?: number | null;
  strictMin1000NetBps?: number | null;
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
type ExecutionShadowResult = {
  id?: string;
  coin?: string;
  routeId?: string;
  buyVenue?: Venue;
  sellVenue?: Venue;
  signalAt?: number;
  signalNetBps?: number;
  entryAt?: number | null;
  exitAt?: number;
  entryNetBps?: number | null;
  entryConfirmations?: number;
  entryEdgeConfirmed?: boolean;
  guardNetBps?: number | null;
  peakProjectedNetBps?: number | null;
  realizedNetBps?: number | null;
  realizedNetUsd?: number | null;
  reachedExitGuard?: boolean;
  passed?: boolean;
  reason?: string;
  holdingMs?: number | null;
  fundingBps?: number;
};
type ExecutionShadowProbe = {
  id?: string;
  coin?: string;
  routeId?: string;
  buyVenue?: Venue;
  sellVenue?: Venue;
  state?: string;
  signalAt?: number;
  signalNetBps?: number;
  openedAt?: number | null;
  entryConfirmations?: number;
  guardConfirmations?: number;
  guardNetBps?: number | null;
  peakProjectedNetBps?: number | null;
};
type ExecutionShadowReadiness = {
  samples?: number;
  entryEdgeConfirmed?: number;
  reachedExitGuard?: number;
  positiveAfterLatency?: number;
  passed?: number;
  passedPct?: number | null;
  requiredSamples?: number;
  requiredPassPct?: number;
  ready?: boolean;
  reasons?: Record<string, number>;
};
type ShadowRejectReason =
  | 'missing_book'
  | 'stale_book'
  | 'insufficient_depth'
  | 'below_gate'
  | 'latched';
type ShadowRouteTelemetry = {
  freshQuotes?: number;
  staleQuotes?: number;
  eligibleWindows?: number;
  lastSignalAt?: number | null;
  lastEvaluatedAt?: number | null;
  currentBestNetBps?: number | null;
  currentBestCoin?: string | null;
  peakOpeningNetBps?: number | null;
  peakCoin?: string | null;
  rejections?: Partial<Record<ShadowRejectReason, number>>;
  currentRejections?: Partial<Record<ShadowRejectReason, number>>;
};
type ExecutionShadowRoute = {
  id?: string;
  buyVenue?: Venue;
  sellVenue?: Venue;
  primary?: boolean;
  telemetry?: ShadowRouteTelemetry;
  measuredLatency?: {
    entryMs?: number;
    exitMs?: number;
    measuredTrades?: number;
  };
  readiness?: ExecutionShadowReadiness;
  active?: ExecutionShadowProbe[];
  recent?: ExecutionShadowResult[];
};
type ExecutionShadow = ExecutionShadowRoute & {
  version?: string;
  config?: {
    notionalUsd?: number;
    entryNetBps?: number;
    entryConfirmations?: number;
    exitNetBps?: number;
    exitConfirmations?: number;
    freshMs?: number;
    maxHoldMs?: number;
    fundingBpsPerHour?: number;
    executionBufferBps?: number;
  };
  routes?: Record<string, ExecutionShadowRoute>;
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
    stalls?: number;
    lastMessageAt?: number;
  }>>;
  evaluations?: number;
  active?: Opportunity[];
  recentClosed?: Opportunity[];
  summary?: Summary;
  groupedSummaries?: Record<string, Summary>;
  freshnessMs?: Record<string, Partial<Record<Venue, number | null>>>;
  executionShadow?: ExecutionShadow;
};
type LiveFill = {
  price?: number;
  quantity?: number;
  notional?: number;
  fee?: number;
  filled_at?: number | null;
};
type LiveTrade = {
  id?: string;
  status?: string;
  coin?: string;
  route?: string;
  startedAt?: number;
  openedAt?: number;
  closedAt?: number;
  holdingMs?: number;
  entryLatencyMs?: number;
  exitLatencyMs?: number;
  entryNetPct?: number;
  notionalUsdPerLeg?: number;
  leverage?: number;
  closeReason?: string;
  grossPnlUsd?: number;
  feesUsd?: number;
  netPnlUsd?: number;
  netPnlPct?: number;
  error?: string;
  entryExtended?: LiveFill | null;
  entryLighter?: LiveFill | null;
  exitExtended?: LiveFill | null;
  exitLighter?: LiveFill | null;
};
type LiveStatus = {
  version?: string;
  updatedAt?: number;
  enabled?: boolean;
  state?: string;
  notionalUsdPerLeg?: number;
  leverage?: number;
  entryNetPct?: number;
  exitMinProfitPct?: number;
  exitConfirmations?: number;
  shutdownDeferredWhenOpen?: boolean;
  route?: string;
  lastRejection?: string | null;
  error?: string;
  balancesUsd?: {
    extended?: number;
    lighter?: number;
  };
  activeTrade?: LiveTrade | null;
  lastTrade?: LiveTrade | null;
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

async function readLive(): Promise<{
  status: LiveStatus | null;
  trades: LiveTrade[];
}> {
  const read = async <T>(file: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(dataRoot(), file), 'utf8'),
      ) as T;
    } catch {
      return fallback;
    }
  };
  return {
    status: await read<LiveStatus | null>('live-status.json', null),
    trades: await read<LiveTrade[]>('live-trades.json', []),
  };
}

function pctFromBps(value: unknown, signed = true): string {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const pct = number / 100;
  const sign = signed && pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(3)}%`;
}

function coinAndBps(coin: unknown, value: unknown): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${esc(coin)} · ${pctFromBps(value)}`;
}

function shadowBlockers(telemetry: ShadowRouteTelemetry | undefined): string {
  const labels: Record<ShadowRejectReason, string> = {
    missing_book: 'нет стакана',
    stale_book: 'старые данные',
    insufficient_depth: 'нет глубины $500',
    below_gate: 'edge ниже +0.10%',
    latched: 'окно уже отслеживается',
  };
  const rows = Object.entries(telemetry?.currentRejections ?? {})
    .map(([reason, count]) => ({
      reason: reason as ShadowRejectReason,
      count: Number(count ?? 0),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);
  return rows.length
    ? rows.map((row) => `${labels[row.reason]} · ${row.count}`).join('<br>')
    : 'нет отклонений';
}

function capitalRecommendation(
  shadow: ExecutionShadow | undefined,
  groups: Record<string, Summary>,
): string {
  const routes = Object.values(shadow?.routes ?? {}).filter(
    (route) => route.buyVenue && route.sellVenue,
  );
  const ready = routes.find((route) => route.readiness?.ready);
  if (ready) {
    return `<p class="va-wait"><b class="pos">КАНДИДАТ ПРОШЁЛ SHADOW-GATE: ${esc(shadowRouteLabel(ready))}.</b> Перед пополнением требуется отдельный preflight балансов, API-прав и допустимого плеча; точную сумму и недостающее подключение оператор получит отдельной командой.</p>`;
  }
  const ranked = routes
    .map((route) => ({
      route,
      summary: groups[`pair:${route.buyVenue}→${route.sellVenue}`] ?? {},
    }))
    .filter(({ summary }) => Number(summary.strictStarts ?? 0) > 0)
    .sort((a, b) => (
      Number(b.summary.strictRetained1000 ?? 0)
      - Number(a.summary.strictRetained1000 ?? 0)
      || Number(b.summary.strictStarts ?? 0)
      - Number(a.summary.strictStarts ?? 0)
    ));
  const leader = ranked[0];
  if (!leader) {
    return '<p class="va-wait"><b>КАПИТАЛ: ПОКА НЕ ВНОСИТЬ.</b> Ни один маршрут ещё не имеет даже предварительной выборки с net ≥ +0.10%.</p>';
  }
  const gate = leader.route.readiness;
  const dexCexLeader = ranked.find(({ route }) => shadowRouteClass(route) === 'DEX/CEX');
  const dexCexNote = dexCexLeader && dexCexLeader.route.id !== leader.route.id
    ? ` Лучший DEX/CEX-кандидат — <b>${esc(shadowRouteLabel(dexCexLeader.route))}</b>: ${Number(dexCexLeader.summary.strictRetained1000 ?? 0)} / ${Number(dexCexLeader.summary.strictStarts ?? 0)}.`
    : '';
  return `<p class="va-wait"><b>КАПИТАЛ: ПОКА НЕ ВНОСИТЬ.</b> Предварительный лидер по числу устойчивых окон — <b>${esc(shadowRouteLabel(leader.route))}</b> (${esc(shadowRouteClass(leader.route))}): исторически ${Number(leader.summary.strictRetained1000 ?? 0)} из ${Number(leader.summary.strictStarts ?? 0)} окон сохранили net ≥ +0.10% через 1 секунду.${dexCexNote} Строгий forward лидера сейчас ${Number(gate?.samples ?? 0)} / ${Number(gate?.requiredSamples ?? 50)}. После PASS здесь появятся две площадки, а точный размер пополнения будет рассчитан по доступному плечу и запасу маржи.</p>`;
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

function money(value: unknown, signed = false): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${number < 0 ? '−' : ''}$${Math.abs(number).toFixed(2)}`;
}

function plainPct(value: unknown, signed = false): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const sign = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${sign}${Math.abs(number).toFixed(3)}%`;
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
  return `<div class="va-table" data-va-pager="active" data-page-size="20"><table><thead><tr>
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
  return `<div class="va-table" data-va-pager="history" data-page-size="20"><table><thead><tr>
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

function liveState(status: LiveStatus | null): string {
  const names: Record<string, string> = {
    dry_run_ready: 'DRY-RUN ГОТОВ',
    preflight: 'ПРОВЕРКА',
    armed: 'ЖДЁТ ВХОД',
    opening: 'ОТКРЫТИЕ',
    open: 'В ПОЗИЦИИ',
    shutdown_pending_profit: 'ОСТАНОВКА: ЖДЁТ NET+',
    closing: 'ЗАКРЫТИЕ',
    completed: 'CANARY ЗАВЕРШЁН',
    blocked: 'ОСТАНОВЛЕН',
    error: 'ОШИБКА',
  };
  return names[String(status?.state)] ?? 'НЕ ЗАПУЩЕН';
}

function liveTradeRows(rows: LiveTrade[]): string {
  if (!rows.length) {
    return '<tr><td colspan="11">Реальных арбитражных сделок пока нет — исполнитель ждёт допустимый net-edge.</td></tr>';
  }
  return [...rows].reverse().map((row) => {
    const status = row.status === 'closed'
      ? 'ЗАКРЫТА'
      : row.status === 'open'
        ? 'LIVE'
        : row.status === 'failed_flat'
          ? 'ВЫРОВНЕНА'
          : esc(row.status);
    const ext = row.entryExtended;
    const lit = row.entryLighter;
    const extExit = row.exitExtended;
    const litExit = row.exitLighter;
    return `<tr>
      <td><b>${esc(row.id)}</b></td>
      <td>${utc(row.openedAt ?? row.startedAt)} → ${row.closedAt ? utc(row.closedAt) : '—'}</td>
      <td><b>${esc(row.coin)}</b></td>
      <td>${esc(row.route)}</td>
      <td>${money(row.notionalUsdPerLeg)} × 2 · ${Number(row.leverage ?? 0)}x</td>
      <td>${price(ext?.price)} / ${price(lit?.price)}</td>
      <td>${price(extExit?.price)} / ${price(litExit?.price)}</td>
      <td>${duration(row.holdingMs)}</td>
      <td>${duration(row.entryLatencyMs)} / ${duration(row.exitLatencyMs)}</td>
      <td>${money(row.feesUsd)}</td>
      <td class="${cls(row.netPnlUsd)}"><b>${money(row.netPnlUsd, true)} · ${plainPct(row.netPnlPct, true)}</b><small>${status}${row.closeReason ? ` · ${esc(row.closeReason)}` : ''}${row.error ? ` · ${esc(row.error)}` : ''}</small></td>
    </tr>`;
  }).join('');
}

function shadowReason(reason: unknown): string {
  const labels: Record<string, string> = {
    protected_exit: 'защищённый выход',
    edge_lost_before_entry: 'edge исчез до входа',
    stale_at_delayed_entry: 'стакан устарел до входа',
    unstable_edge_before_entry: 'меньше трёх свежих подтверждений',
    stale_after_exit_latency: 'стакан устарел после exit latency',
    max_hold: 'достигнут max hold',
    invalid_probe_state: 'ошибка состояния',
    unknown_shadow_route: 'неизвестный shadow-маршрут',
  };
  return labels[String(reason)] ?? esc(reason);
}

function shadowProbeState(state: unknown): string {
  const labels: Record<string, string> = {
    awaiting_entry: 'ЗАДЕРЖКА ВХОДА',
    open: 'ИЩЕТ NET+ ВЫХОД',
    awaiting_exit: 'МОДЕЛЬ EXIT LATENCY',
  };
  return labels[String(state)] ?? esc(state);
}

function shadowRouteLabel(
  row: Pick<ExecutionShadowRoute, 'buyVenue' | 'sellVenue'>,
): string {
  return row.buyVenue && row.sellVenue
    ? `${row.buyVenue} → ${row.sellVenue}`
    : '—';
}

function shadowRouteClass(
  row: Pick<ExecutionShadowRoute, 'buyVenue' | 'sellVenue'>,
): string {
  if (!row.buyVenue || !row.sellVenue) return '—';
  const venueClass = (venue: Venue) => (
    venue === 'binance' || venue === 'bybit' ? 'CEX' : 'DEX'
  );
  return `${venueClass(row.buyVenue)}/${venueClass(row.sellVenue)}`;
}

function executionShadowRows(
  shadow: ExecutionShadow | undefined,
  routeId = 'extended-lighter',
): string {
  const routes = routeId === 'scout'
    ? Object.values(shadow?.routes ?? {}).filter((route) => !route.primary)
    : [shadow?.routes?.[routeId] ?? shadow].filter(Boolean) as ExecutionShadowRoute[];
  const active = routes.flatMap((route) => route.active ?? [])
    .sort((a, b) => Number(b.signalAt ?? 0) - Number(a.signalAt ?? 0));
  const recent = routes.flatMap((route) => route.recent ?? [])
    .sort((a, b) => Number(b.signalAt ?? 0) - Number(a.signalAt ?? 0))
    .slice(0, 100);
  const routeLabel = routeId === 'scout'
    ? 'DEX/CEX scout'
    : shadowRouteLabel(routes[0] ?? {});
  if (!active.length && !recent.length) {
    return `<tr><td colspan="10">Shadow-gate ждёт первое окно ${esc(routeLabel)} с исполнимым net ≥ +0.10%.</td></tr>`;
  }
  return [
    ...active.map((row) => `<tr>
      <td>${utc(row.signalAt)}</td>
      <td><b>${esc(row.coin)}</b></td>
      <td>${esc(shadowRouteLabel(row))}</td>
      <td><b>${shadowProbeState(row.state)}</b></td>
      <td class="${cls(row.signalNetBps)}">${pctFromBps(row.signalNetBps)}</td>
      <td>${Number(row.entryConfirmations ?? 0)} / ${Number(shadow?.config?.entryConfirmations ?? 3)}</td>
      <td>${Number(row.guardConfirmations ?? 0)} / ${Number(shadow?.config?.exitConfirmations ?? 3)}${row.guardNetBps == null ? '' : ` · ${pctFromBps(row.guardNetBps)}`}</td>
      <td>—</td>
      <td>${duration(Date.now() - Number(row.signalAt ?? Date.now()))}</td>
      <td>наблюдение продолжается</td>
    </tr>`),
    ...recent.map((row) => `<tr>
      <td>${utc(row.signalAt)}</td>
      <td><b>${esc(row.coin)}</b></td>
      <td>${esc(shadowRouteLabel(row))}</td>
      <td class="${row.passed ? 'pos' : 'neg'}"><b>${row.passed ? 'PASS' : 'FAIL'}</b></td>
      <td class="${cls(row.signalNetBps)}">${pctFromBps(row.signalNetBps)}</td>
      <td class="${row.entryEdgeConfirmed ? 'pos' : 'neg'}">${row.entryNetBps == null ? '—' : pctFromBps(row.entryNetBps)} · ${Number(row.entryConfirmations ?? 0)} / ${Number(shadow?.config?.entryConfirmations ?? 3)}</td>
      <td>${row.reachedExitGuard ? `✓ ${pctFromBps(row.guardNetBps)}` : `нет · пик ${row.peakProjectedNetBps == null ? '—' : pctFromBps(row.peakProjectedNetBps)}`}</td>
      <td class="${cls(row.realizedNetBps)}"><b>${row.realizedNetBps == null ? '—' : pctFromBps(row.realizedNetBps)}</b>${row.realizedNetUsd == null ? '' : ` · ${money(row.realizedNetUsd, true)}`}</td>
      <td>${row.holdingMs == null ? '—' : duration(row.holdingMs)}</td>
      <td>${shadowReason(row.reason)}${Number(row.fundingBps ?? 0) > 0 ? ` · funding ${pctFromBps(row.fundingBps)}` : ''}</td>
    </tr>`),
  ].join('');
}

function scoutRouteRows(shadow: ExecutionShadow | undefined): string {
  const routes = Object.values(shadow?.routes ?? {})
    .filter((route) => !route.primary)
    .sort((a, b) => {
      const ready = Number(Boolean(b.readiness?.ready))
        - Number(Boolean(a.readiness?.ready));
      if (ready) return ready;
      const eligible = Number(b.telemetry?.eligibleWindows ?? 0)
        - Number(a.telemetry?.eligibleWindows ?? 0);
      if (eligible) return eligible;
      return Number(b.telemetry?.peakOpeningNetBps ?? -Infinity)
        - Number(a.telemetry?.peakOpeningNetBps ?? -Infinity);
    });
  if (!routes.length) {
    return '<tr><td colspan="9">Scout-маршруты не настроены.</td></tr>';
  }
  return routes.map((route) => {
    const gate = route.readiness;
    const telemetry = route.telemetry;
    const status = gate?.ready
      ? '<b class="pos">GATE PASS</b>'
      : Number(route.active?.length ?? 0) > 0
        ? '<b class="pos">В РАБОТЕ</b>'
        : 'СКАНИРУЕТ';
    return `<tr>
      <td><b>${esc(shadowRouteLabel(route))}</b><small>${esc(shadowRouteClass(route))}</small></td>
      <td>${Number(gate?.samples ?? 0)} / ${Number(gate?.requiredSamples ?? 50)}</td>
      <td class="${cls(gate?.passedPct)}">${Number(gate?.passed ?? 0)} · ${pct(gate?.passedPct)}</td>
      <td>${Number(telemetry?.eligibleWindows ?? 0)}</td>
      <td>${coinAndBps(telemetry?.currentBestCoin, telemetry?.currentBestNetBps)}</td>
      <td>${coinAndBps(telemetry?.peakCoin, telemetry?.peakOpeningNetBps)}</td>
      <td>${shadowBlockers(telemetry)}</td>
      <td>${duration(route.measuredLatency?.entryMs)} / ${duration(route.measuredLatency?.exitMs)}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}

const VENUE_ARB_PAGINATION_SCRIPT = `<script>
(() => {
  const storagePrefix = 'venue-arb-page:';
  const safeReadPage = (key) => {
    try {
      return Number(window.sessionStorage.getItem(key)) || 1;
    } catch {
      return 1;
    }
  };
  const safeWritePage = (key, page) => {
    try {
      window.sessionStorage.setItem(key, String(page));
    } catch {
      // Pagination still works when browser storage is unavailable.
    }
  };
  const pageWindow = (current, total) => {
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
    const pages = new Set([1, total, current - 1, current, current + 1]);
    return [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  };

  document.querySelectorAll('[data-va-pager]').forEach((wrapper) => {
    const rows = Array.from(wrapper.querySelectorAll('tbody > tr'));
    const pageSize = Math.max(1, Number(wrapper.getAttribute('data-page-size')) || 20);
    const totalPages = Math.ceil(rows.length / pageSize);
    if (totalPages <= 1) return;

    const pagerId = wrapper.getAttribute('data-va-pager') || 'table';
    const storageKey = storagePrefix + pagerId;
    let currentPage = Math.min(totalPages, Math.max(1, safeReadPage(storageKey)));
    const controls = document.createElement('nav');
    controls.className = 'va-pagination';
    controls.setAttribute('aria-label', 'Страницы таблицы');
    const summary = document.createElement('span');
    summary.className = 'va-pagination-summary';
    const buttons = document.createElement('div');
    buttons.className = 'va-pagination-buttons';
    controls.append(summary, buttons);
    wrapper.appendChild(controls);

    const makeButton = (label, page, options = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = options.pageNumber ? 'va-page-number' : 'va-page-arrow';
      button.textContent = label;
      button.disabled = Boolean(options.disabled);
      button.setAttribute('aria-label', options.ariaLabel || ('Страница ' + page));
      if (options.current) {
        button.classList.add('active');
        button.setAttribute('aria-current', 'page');
      }
      button.addEventListener('click', () => {
        currentPage = page;
        safeWritePage(storageKey, currentPage);
        render();
      });
      return button;
    };

    const render = () => {
      const start = (currentPage - 1) * pageSize;
      const end = Math.min(start + pageSize, rows.length);
      rows.forEach((row, index) => {
        row.hidden = index < start || index >= end;
      });
      summary.textContent = (start + 1) + '–' + end + ' из ' + rows.length;
      buttons.replaceChildren();
      buttons.appendChild(makeButton('←', currentPage - 1, {
        disabled: currentPage === 1,
        ariaLabel: 'Предыдущая страница',
      }));
      let previousPage = 0;
      pageWindow(currentPage, totalPages).forEach((page) => {
        if (previousPage && page - previousPage > 1) {
          const gap = document.createElement('span');
          gap.className = 'va-page-gap';
          gap.textContent = '…';
          buttons.appendChild(gap);
        }
        buttons.appendChild(makeButton(String(page), page, {
          pageNumber: true,
          current: page === currentPage,
        }));
        previousPage = page;
      });
      buttons.appendChild(makeButton('→', currentPage + 1, {
        disabled: currentPage === totalPages,
        ariaLabel: 'Следующая страница',
      }));
    };

    render();
  });
})();
</script>`;

async function render(lang: Lang): Promise<string> {
  const [status, liveData] = await Promise.all([readStatus(), readLive()]);
  const liveStatus = liveData.status;
  const liveTrades = liveData.trades ?? [];
  const closedLive = liveTrades.filter((row) => row.status === 'closed');
  const liveNet = closedLive.reduce(
    (sum, row) => sum + Number(row.netPnlUsd ?? 0),
    0,
  );
  const liveFees = closedLive.reduce(
    (sum, row) => sum + Number(row.feesUsd ?? 0),
    0,
  );
  const liveWins = closedLive.filter((row) => Number(row.netPnlUsd ?? 0) > 0).length;
  const activeLive = liveStatus?.activeTrade;
  const isLive = live(status);
  const summary = status?.summary ?? {};
  const groups = status?.groupedSummaries ?? {};
  const connections = status?.connections ?? {};
  const connected = VENUES.filter((venue) => connections[venue]?.connected).length;
  const maxFeedAgeMs = Math.max(0, ...VENUES.map((venue) => {
    const last = Number(connections[venue]?.lastMessageAt ?? 0);
    return last > 0 ? Date.now() - last : 0;
  }));
  const feedStalls = VENUES.reduce(
    (sum, venue) => sum + Number(connections[venue]?.stalls ?? 0),
    0,
  );
  const triggerBps = Number(status?.netTriggerBps ?? 3);
  const profitableActive = (status?.active ?? [])
    .filter((row) => Number(currentNet1000Bps(row)) > triggerBps);
  const survival250 = summary.survival?.['250'];
  const executionShadow = status?.executionShadow;
  const primaryShadow = executionShadow?.routes?.['extended-lighter']
    ?? executionShadow;
  const shadowGate = primaryShadow?.readiness;
  const shadowReasons = Object.entries(shadowGate?.reasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${shadowReason(reason)} ${count}`)
    .join(' · ');
  return pageShell(
    t(lang, 'DEX/CEX Perp Arbitrage Radar', 'DEX/CEX Perp Arbitrage Radar'),
    `<style>${VENUE_ARB_CSS}</style>
    <div class="va-wrap">
      <a class="va-back" href="/lab">← Лаборатория</a>
      <div class="va-head"><div>
        <span class="va-badge">READ-ONLY · PERP ARBITRAGE · TRADEABLE $1,000 VWAP</span>
        <h1>Perp Arbitrage Radar</h1>
        <p>Фиксирует только расхождения, исполнимые на $1,000. Net-окно начинается при остаточном edge выше ${pctFromBps(triggerBps)} после полного цикла из четырёх taker-ордеров, VWAP и защитного буфера, и заканчивается при net ≤ 0%.</p>
      </div><div class="va-engine ${isLive ? 'live' : ''}"><i></i>${isLive ? 'РАБОТАЕТ' : 'НЕТ СВЕЖИХ ДАННЫХ'}</div></div>

      <div class="va-cards">
        <div class="va-card"><small>Потоки</small><b>${connected}/${VENUES.length}</b><em>Lighter · Hyperliquid · Paradex · Polymarket · Extended · Aster · Binance · Bybit</em></div>
        <div class="va-card"><small>Максимальный возраст потока</small><b class="${maxFeedAgeMs > 15_000 ? 'neg' : ''}">${duration(maxFeedAgeMs)}</b><em>авто-reconnect зависаний: ${feedStalls}</em></div>
        <div class="va-card"><small>Допуск сейчас</small><b class="${profitableActive.length ? 'pos' : ''}">${profitableActive.length}</b><em>$1,000 net &gt; ${pctFromBps(triggerBps)}</em></div>
        <div class="va-card"><small>Tradeable окон завершено</small><b class="${Number(summary.viable ?? 0) > 0 ? 'pos' : ''}">${Number(summary.viable ?? 0)}</b><em>из ${Number(summary.closed ?? 0)} честных окон</em></div>
        <div class="va-card"><small>Медиана tradeable net</small><b class="pos">${pctFromBps(summary.medianViablePeakNetBps)}</b><em>$1,000 · лучший ${pctFromBps(summary.maxPeakNetBps)}</em></div>
        <div class="va-card"><small>Жизнь tradeable edge</small><b>${duration(summary.medianViableDurationMs)}</b><em>$1,000 после издержек</em></div>
        <div class="va-card"><small>Net жив через 250 ms</small><b>${pct(survival250?.netPositivePct)}</b><em>${Number(survival250?.observedAtHorizon ?? 0)} дожили · N ${Number(survival250?.sampled ?? 0)}</em></div>
      </div>

      <section class="va-panel"><div class="va-panel-head"><h2>Tradeable расхождения сейчас</h2><span>$1,000 net &gt; ${pctFromBps(triggerBps)} · автообновление 5 сек</span></div>
        ${activeRows(status?.active ?? [], triggerBps)}
      </section>

      <section class="va-panel va-shadow-panel">
        <div class="va-panel-head"><div><span class="va-badge">EXECUTION SHADOW · EXTENDED → LIGHTER</span><h2>Gate реального исполнения</h2></div>
          <span class="${shadowGate?.ready ? 'pos' : ''}">${shadowGate?.ready ? 'ГОТОВ К CANARY' : 'СБОР ДОКАЗАТЕЛЬСТВ'}</span>
        </div>
        <div class="va-live-cards">
          <div><small>Выборка / минимум</small><b>${Number(shadowGate?.samples ?? 0)} / ${Number(shadowGate?.requiredSamples ?? 50)}</b></div>
          <div><small>Полный PASS</small><b class="${Number(shadowGate?.passedPct ?? 0) >= Number(shadowGate?.requiredPassPct ?? 90) ? 'pos' : ''}">${Number(shadowGate?.passed ?? 0)} · ${pct(shadowGate?.passedPct)}</b></div>
          <div><small>Edge подтверждён 3×</small><b>${Number(shadowGate?.entryEdgeConfirmed ?? 0)}</b></div>
          <div><small>Достигли exit guard</small><b>${Number(shadowGate?.reachedExitGuard ?? 0)}</b></div>
          <div><small>Квалифицированные окна</small><b>${Number(primaryShadow?.telemetry?.eligibleWindows ?? 0)}</b></div>
          <div><small>Лучший net сейчас</small><b>${coinAndBps(primaryShadow?.telemetry?.currentBestCoin, primaryShadow?.telemetry?.currentBestNetBps)}</b></div>
          <div><small>Пик с запуска</small><b>${coinAndBps(primaryShadow?.telemetry?.peakCoin, primaryShadow?.telemetry?.peakOpeningNetBps)}</b></div>
          <div><small>Свежих котировок проверено</small><b>${Number(primaryShadow?.telemetry?.freshQuotes ?? 0).toLocaleString('ru-RU')}</b></div>
          <div><small>Почему нет входа сейчас</small><b>${shadowBlockers(primaryShadow?.telemetry)}</b></div>
          <div><small>Активные probes</small><b>${Number(primaryShadow?.active?.length ?? 0)}</b></div>
          <div><small>Модель entry / exit</small><b>${duration(primaryShadow?.measuredLatency?.entryMs)} / ${duration(primaryShadow?.measuredLatency?.exitMs)}</b></div>
          <div><small>Порог входа / выхода</small><b>${pctFromBps(executionShadow?.config?.entryNetBps)} / ${pctFromBps(executionShadow?.config?.exitNetBps)}</b></div>
        </div>
        <p>Каждый probe начинается только при исполнимом net ≥ ${pctFromBps(executionShadow?.config?.entryNetBps)} и требует ${Number(executionShadow?.config?.entryConfirmations ?? 3)} независимых свежих подтверждения в течение измеренной задержки входа. Затем фиксируется $${Number(executionShadow?.config?.notionalUsd ?? 500)} VWAP, вычитаются четыре taker-комиссии, ${pctFromBps(executionShadow?.config?.executionBufferBps, false)} execution-буфера и funding ${pctFromBps(executionShadow?.config?.fundingBpsPerHour, false)}/час. Выход допускается после ${Number(executionShadow?.config?.exitConfirmations ?? 3)} свежих снимков с реальным модельным PnL ≥ ${pctFromBps(executionShadow?.config?.exitNetBps)}, затем применяется измеренная exit latency. Gate: минимум ${Number(shadowGate?.requiredSamples ?? 50)} probes и PASS ≥ ${pct(shadowGate?.requiredPassPct)}.</p>
        ${shadowReasons ? `<p class="va-wait">Причины завершения: ${esc(shadowReasons)}</p>` : ''}
        <div class="va-table" data-va-pager="execution-shadow" data-page-size="20"><table><thead><tr>
          <th>Сигнал UTC</th><th>Монета</th><th>Маршрут</th><th>Статус</th><th>Signal net</th>
          <th>Delayed entry / 3×</th><th>Exit guard</th><th>После exit latency</th>
          <th>Жизнь</th><th>Результат / причина</th>
        </tr></thead><tbody>${executionShadowRows(executionShadow)}</tbody></table></div>
      </section>

      <section class="va-panel va-shadow-panel">
        <div class="va-panel-head"><div><span class="va-badge">ARB SCOUT · SHADOW ONLY</span><h2>Сравнение альтернативных маршрутов</h2></div>
          <span>ЕДИНЫЙ GATE · БЕЗ РЕАЛЬНЫХ ОРДЕРОВ</span>
        </div>
        <p>Все направления проверяются одинаково: $${Number(executionShadow?.config?.notionalUsd ?? 500)} VWAP, net ≥ ${pctFromBps(executionShadow?.config?.entryNetBps)}, три свежих подтверждения, все комиссии, funding, execution buffer и консервативная latency. Маршрут не получает преимущества за счёт ослабления фильтра.</p>
        ${capitalRecommendation(executionShadow, groups)}
        <div class="va-table" data-va-pager="execution-shadow-scout-routes" data-page-size="20"><table><thead><tr>
          <th>Маршрут</th><th>Samples</th><th>PASS</th><th>Окна ≥0.10%</th>
          <th>Лучший сейчас</th><th>Пик</th><th>Почему нет входа сейчас</th><th>Entry / exit</th><th>Статус</th>
        </tr></thead><tbody>${scoutRouteRows(executionShadow)}</tbody></table></div>
        <h3>История квалифицированных scout-окон</h3>
        <div class="va-table" data-va-pager="execution-shadow-scout" data-page-size="20"><table><thead><tr>
          <th>Сигнал UTC</th><th>Монета</th><th>Маршрут</th><th>Статус</th><th>Signal net</th>
          <th>Delayed entry / 3×</th><th>Exit guard</th><th>После exit latency</th>
          <th>Жизнь</th><th>Результат / причина</th>
        </tr></thead><tbody>${executionShadowRows(executionShadow, 'scout')}</tbody></table></div>
      </section>

      <section class="va-panel va-live-panel">
        <div class="va-panel-head"><div><span class="va-badge">REAL · EXTENDED ↔ LIGHTER</span><h2>Реальная арбитражная торговля</h2></div>
          <span class="va-live-state ${liveStatus?.state === 'error' || liveStatus?.state === 'blocked' ? 'neg' : liveStatus?.enabled ? 'pos' : ''}">${liveState(liveStatus)}</span>
        </div>
        <div class="va-live-cards">
          <div><small>Реальный net PnL</small><b class="${cls(liveNet)}">${money(liveNet, true)}</b></div>
          <div><small>Закрыто / прибыльных</small><b>${closedLive.length} / ${liveWins}</b></div>
          <div><small>Реальные комиссии</small><b>${money(liveFees)}</b></div>
          <div><small>Размер / плечо</small><b>${money(liveStatus?.notionalUsdPerLeg)} × 2 · ${Number(liveStatus?.leverage ?? 0)}x</b></div>
          <div><small>Extended / Lighter</small><b>${money(liveStatus?.balancesUsd?.extended)} / ${money(liveStatus?.balancesUsd?.lighter)}</b></div>
          <div><small>Текущий статус</small><b>${activeLive ? `${esc(activeLive.coin)} · ${esc(activeLive.status)}` : liveState(liveStatus)}</b></div>
        </div>
        <p>Отдельный честный журнал canary: две ноги считаются по фактическим fill-ценам, комиссиям и итоговому PnL. Вход разрешён только для Extended → Lighter при net ≥ ${plainPct(liveStatus?.entryNetPct ?? .15)} и свежести обоих стаканов ≤ 150 ms. Обычный выход допускается только после ${Number(liveStatus?.exitConfirmations ?? 3)} последовательных снимков с исполнимым net PnL ≥ ${plainPct(liveStatus?.exitMinProfitPct ?? .10)}; команда остановки больше не инициирует немедленное закрытие открытой пары.</p>
        <div class="va-table" data-va-pager="live-trades" data-page-size="20"><table><thead><tr>
          <th>ID</th><th>Открыта → закрыта UTC</th><th>Монета</th><th>Маршрут</th>
          <th>Размер</th><th>Вход Ext / Lighter</th><th>Выход Ext / Lighter</th>
          <th>Жизнь</th><th>Вход / выход</th><th>Комиссии</th><th>Net результат</th>
        </tr></thead><tbody>${liveTradeRows(liveTrades)}</tbody></table></div>
        ${liveStatus?.lastRejection && liveStatus.state === 'armed' ? `<p class="va-wait">Сейчас: ${esc(liveStatus.lastRejection)}</p>` : ''}
        ${liveStatus?.error ? `<p class="neg">Ошибка: ${esc(liveStatus.error)}</p>` : ''}
      </section>

      <section class="va-panel"><h2>Прибыльные типы маршрутов</h2>
        <p>Показываются только маршруты, где $1,000 VWAP на старте давал net выше ${pctFromBps(triggerBps)} после входа и выхода обеих ног: четырёх taker-комиссий и ${pctFromBps(status?.executionBufferBps, false)} защитного буфера.</p>
        <div class="va-table" data-va-pager="route-types" data-page-size="20"><table><thead><tr><th>Маршрут</th><th>Net+ / все</th><th>Доля</th><th>Медиана прибыльного net</th><th>Лучший net</th><th>Жизнь</th><th>100 ms</th><th>250 ms</th><th>500 ms</th><th>1000 ms</th></tr></thead>
          <tbody>${routeRows(groups) || '<tr><td colspan="10">Прибыльных маршрутов пока нет.</td></tr>'}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>Прибыльные биржевые направления</h2>
        <div class="va-table" data-va-pager="venue-directions" data-page-size="20"><table><thead><tr><th>Купить → продать</th><th>Net+ / все</th><th>Доля</th><th>Медиана прибыльного net</th><th>Лучший net</th><th>Жизнь</th></tr></thead>
          <tbody>${pairRows(groups) || '<tr><td colspan="6">Прибыльных направлений пока нет.</td></tr>'}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>История прибыльных расхождений</h2>${historyRows(status?.recentClosed ?? [])}</section>

      <section class="va-panel"><h2>Свежесть стаканов</h2>
        <div class="va-table" data-va-pager="book-freshness" data-page-size="20"><table><thead><tr><th>Монета</th>${VENUES.map((venue) => `<th>${venue}</th>`).join('')}</tr></thead>
          <tbody>${status ? feedRows(status) : ''}</tbody></table></div>
      </section>

      <section class="va-panel"><h2>Что именно проверяем</h2>
        <div class="va-rules">
          <span>глубина минимум $500</span><span>контроль $1,000</span><span>шаг 100 ms</span>
          <span>VWAP, не mid-price</span><span>две ноги одновременно</span><span>полный round-trip</span>
          <span>допуск только при $1k net &gt; ${pctFromBps(triggerBps)}</span><span>Lighter fee 0%</span><span>canary: Extended → Lighter</span>
        </div>
        <p>Радар продолжает измерять все площадки. Реальный исполнитель отделён от него и допущен только к одной защищённой canary-сделке Extended → Lighter; он параллельно отправляет IOC-ноги и аварийно выравнивает позицию, если одна сторона не исполнилась.</p>
      </section>
    </div>
    ${VENUE_ARB_PAGINATION_SCRIPT}`,
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
.va-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:0 0 14px;padding:17px 20px;border:1px solid rgba(164,104,255,.38);border-radius:14px;background:linear-gradient(135deg,rgba(137,79,255,.15),var(--bg-card));color:var(--text);text-decoration:none}.va-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(137,79,255,.15);color:#b58aff;font-size:11px;font-weight:750;letter-spacing:.04em}.va-title{font-size:19px;font-weight:700;margin-top:8px}.va-sub{font-size:13px;color:var(--text-dim);margin-top:3px}.va-hero-stats{display:flex;gap:22px}.va-hero-stats span{display:grid;text-align:right}.va-hero-stats b{font-size:18px}.va-hero-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}.va-wrap{max-width:1180px;margin:0 auto}.va-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}.va-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.va-head h1{font-size:34px;margin:12px 0 7px}.va-head p{max-width:790px;color:var(--text-dim)}.va-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.va-engine i{width:8px;height:8px;border-radius:50%;background:#ff6577}.va-engine.live i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}.va-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.va-card,.va-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.va-card{padding:16px;display:grid;gap:5px}.va-card small,.va-card em{color:var(--text-faint);font-size:11px;font-style:normal}.va-card b{font-size:25px;font-variant-numeric:tabular-nums}.va-panel{padding:18px;margin:12px 0}.va-panel h2{font-size:17px;margin:0 0 14px}.va-panel p{color:var(--text-dim);font-size:13px}.va-panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.va-panel-head span{font-size:12px;color:var(--text-faint)}.va-live-panel{border-color:rgba(56,217,150,.25)}.va-live-state{font-size:12px;font-weight:750}.va-live-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.va-live-cards>div{display:grid;gap:4px;padding:11px;border-radius:10px;background:var(--bg)}.va-live-cards small{color:var(--text-faint);font-size:10px;text-transform:uppercase}.va-live-cards b{font-size:15px}.va-wait{padding:8px 10px;border-radius:8px;background:rgba(137,79,255,.08)}.va-table{overflow:auto}.va-table table{width:100%;border-collapse:collapse;font-size:12px}.va-table th,.va-table td{text-align:left;padding:9px;border-bottom:1px solid var(--border);white-space:nowrap}.va-table td small{display:block;color:var(--text-faint);font-size:10px;margin-top:2px}.va-table th{color:var(--text-faint);font-size:10px;text-transform:uppercase}.va-pagination{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:max-content;padding:12px 2px 2px;color:var(--text-faint);font-size:11px}.va-pagination-buttons{display:flex;align-items:center;gap:5px}.va-pagination button{display:inline-grid;place-items:center;min-width:31px;height:31px;padding:0 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text-dim);font:inherit;cursor:pointer}.va-pagination button:hover:not(:disabled){border-color:rgba(164,104,255,.65);color:var(--text)}.va-pagination button.active{border-color:#8d58db;background:rgba(141,88,219,.22);color:#c9a7ff;font-weight:700}.va-pagination button:disabled{opacity:.35;cursor:default}.va-page-gap{padding:0 2px}.va-route{padding:3px 7px;border-radius:7px;background:rgba(137,79,255,.13);color:#b58aff}.va-rules{display:flex;flex-wrap:wrap;gap:7px}.va-rules span{padding:6px 9px;border-radius:8px;background:var(--bg);font-size:12px}.va-empty{padding:22px;text-align:center;color:var(--text-faint)}.va-wrap .pos,.va-hero .pos{color:#38d996}.va-wrap .neg,.va-hero .neg{color:#ff6577}@media(max-width:760px){.va-cards,.va-live-cards{grid-template-columns:repeat(2,1fr)}.va-head{display:block}.va-engine{display:inline-flex;margin-top:8px}.va-hero-stats{width:100%;justify-content:space-between}.va-hero-stats span{text-align:left}}@media(max-width:460px){.va-cards,.va-live-cards{grid-template-columns:1fr}.va-head h1{font-size:27px}}
`;

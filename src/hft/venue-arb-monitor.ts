/**
 * Read-only DEX/CEX perpetual-arbitrage radar.
 *
 * It keeps live depth books in memory, prices simultaneous cheap-venue LONG /
 * expensive-venue SHORT legs at executable VWAP, and records only dislocation
 * lifecycles. It has no private clients, credentials, signing or order path.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { applyBybitDepthUpdate, createBybitDepthBook } from '../lib/bybit-depth-book.js';
import {
  executableVwap,
  netConvergenceEdgeBps,
  rawCrossEdgeBps,
  roundTripCostBps,
  type PriceLevel,
} from '../lib/venue-arb.js';
import {
  conservativeLatencyMs,
  shadowNetAfterCosts,
  shadowReadiness,
} from '../lib/venue-arb-shadow.js';

type Venue =
  | 'lighter'
  | 'hyperliquid'
  | 'paradex'
  | 'polymarket'
  | 'extended'
  | 'aster'
  | 'binance'
  | 'bybit';
type VenueClass = 'DEX' | 'CEX';
type Side = 'bids' | 'asks';

type Market = {
  coin: string;
  symbol: string;
  lighterMarketId: number;
  polymarketInstrumentId?: number;
};

type BookState = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  exchangeAt: number;
  receivedAt: number;
  updates: number;
};

type ConnectionState = {
  connected: boolean;
  messages: number;
  reconnects: number;
  lastMessageAt: number;
};

type EdgeSnapshot = {
  at: number;
  rawBps500: number;
  netBps500: number;
  rawBps1000: number | null;
  netBps1000: number | null;
  buyVwap500: number;
  sellVwap500: number;
  buyVwap1000: number | null;
  sellVwap1000: number | null;
  buyDepthUsd: number;
  sellDepthUsd: number;
  buyBookAgeMs: number;
  sellBookAgeMs: number;
};

type ExecutableBook = {
  receivedAt: number;
  updates: number;
  buyVwap500: number | null;
  buyVwap1000: number | null;
  sellVwap500: number | null;
  sellVwap1000: number | null;
  buyDepthUsd: number;
  sellDepthUsd: number;
};

type Opportunity = {
  id: string;
  coin: string;
  buyVenue: Venue;
  sellVenue: Venue;
  route: `${VenueClass}→${VenueClass}`;
  startedAt: number;
  lastAt: number;
  closedAt: number | null;
  durationMs: number | null;
  closeReason: string | null;
  startRawBps: number;
  startNetBps: number;
  startRawBps1000: number;
  startNetBps1000: number;
  peakRawBps: number;
  peakNetBps: number;
  peakRawBps1000: number;
  peakNetBps1000: number;
  currentRawBps: number;
  currentNetBps: number;
  currentRawBps1000: number | null;
  currentNetBps1000: number | null;
  currentExecutable1000: boolean;
  currentBuyVwap500: number;
  currentSellVwap500: number;
  currentBuyVwap1000: number | null;
  currentSellVwap1000: number | null;
  currentBuyDepthUsd: number;
  currentSellDepthUsd: number;
  currentBuyBookAgeMs: number;
  currentSellBookAgeMs: number;
  peakAtMs: number;
  halfLifeMs: number | null;
  convergenceMs: number | null;
  startBuyVwap500: number;
  startSellVwap500: number;
  executable1000AtStart: boolean;
  roundTripCostBps: number;
  horizons: Record<string, {
    rawBps: number;
    netBps: number;
    rawBps1000: number | null;
    netBps1000: number | null;
    executable1000: boolean;
  }>;
};

type ShadowQuote = {
  at: number;
  version: string;
  extendedBuyVwap: number;
  lighterSellVwap: number;
  extendedSellVwap: number;
  lighterBuyVwap: number;
  openingNetBps: number;
};

type ShadowProbe = {
  id: string;
  opportunityId: string;
  coin: string;
  state: 'awaiting_entry' | 'open' | 'awaiting_exit';
  signalAt: number;
  signalNetBps: number;
  entryLatencyMs: number;
  exitLatencyMs: number;
  entryDueAt: number;
  openedAt: number | null;
  entryExtended: number | null;
  entryLighter: number | null;
  quantity: number | null;
  guardConfirmations: number;
  lastGuardQuoteVersion: string | null;
  guardReachedAt: number | null;
  guardNetBps: number | null;
  exitDueAt: number | null;
  exitQuoteDeadlineAt: number | null;
  peakProjectedNetBps: number | null;
};

type ShadowResult = {
  id: string;
  opportunityId: string;
  coin: string;
  signalAt: number;
  signalNetBps: number;
  entryAt: number | null;
  exitAt: number;
  entryLatencyMs: number;
  exitLatencyMs: number;
  holdingMs: number | null;
  entryNetBps: number | null;
  guardNetBps: number | null;
  peakProjectedNetBps: number | null;
  realizedNetBps: number | null;
  realizedNetUsd: number | null;
  reachedExitGuard: boolean;
  passed: boolean;
  reason: string;
  fundingBps: number;
};

const DATA_DIR = resolve(process.env.VENUE_ARB_DATA_DIR ?? 'data/venue-arb');
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const EXECUTION_STATUS_PATH = resolve(DATA_DIR, 'execution-status.json');
const OPPORTUNITIES_PATH = resolve(DATA_DIR, 'opportunities.ndjson');
const LIVE_TRADES_PATH = resolve(DATA_DIR, 'live-trades.json');
const SHADOW_RESULTS_PATH = resolve(DATA_DIR, 'shadow-execution.ndjson');
const SHADOW_ACTIVE_PATH = resolve(DATA_DIR, 'shadow-active.json');
const SAMPLE_MS = finiteEnv('VENUE_ARB_SAMPLE_MS', 100);
const STALE_MS = finiteEnv('VENUE_ARB_STALE_MS', 250);
const NET_TRIGGER_BPS = finiteEnv('VENUE_ARB_NET_TRIGGER_BPS', 3);
const EXECUTION_BUFFER_BPS = finiteEnv('VENUE_ARB_EXECUTION_BUFFER_BPS', 2);
const MAX_LIFETIME_MS = finiteEnv('VENUE_ARB_MAX_LIFETIME_MS', 15 * 60_000);
const SHADOW_NOTIONAL_USD = finiteEnv('VENUE_ARB_SHADOW_NOTIONAL_USD', 500);
const SHADOW_ENTRY_NET_BPS = finiteEnv('VENUE_ARB_SHADOW_ENTRY_NET_BPS', 5);
const SHADOW_EXIT_NET_BPS = finiteEnv('VENUE_ARB_SHADOW_EXIT_NET_BPS', 10);
const SHADOW_EXIT_CONFIRMATIONS = finiteEnv(
  'VENUE_ARB_SHADOW_EXIT_CONFIRMATIONS',
  3,
);
const SHADOW_FRESH_MS = finiteEnv('VENUE_ARB_SHADOW_FRESH_MS', 150);
const SHADOW_MAX_HOLD_MS = finiteEnv(
  'VENUE_ARB_SHADOW_MAX_HOLD_MS',
  15 * 60_000,
);
const SHADOW_FUNDING_BPS_PER_HOUR = finiteEnv(
  'VENUE_ARB_SHADOW_FUNDING_BPS_PER_HOUR',
  1,
);
const SHADOW_REQUIRED_SAMPLES = finiteEnv(
  'VENUE_ARB_SHADOW_REQUIRED_SAMPLES',
  50,
);
const SHADOW_REQUIRED_PASS_PCT = finiteEnv(
  'VENUE_ARB_SHADOW_REQUIRED_PASS_PCT',
  90,
);
const SHADOW_ENTRY_LATENCY_FLOOR_MS = finiteEnv(
  'VENUE_ARB_SHADOW_ENTRY_LATENCY_FLOOR_MS',
  1_000,
);
const SHADOW_EXIT_LATENCY_FLOOR_MS = finiteEnv(
  'VENUE_ARB_SHADOW_EXIT_LATENCY_FLOOR_MS',
  2_200,
);
const SHADOW_EXIT_QUOTE_GRACE_MS = finiteEnv(
  'VENUE_ARB_SHADOW_EXIT_QUOTE_GRACE_MS',
  1_000,
);
const RECONNECT_MS = 2_000;
const HORIZONS_MS = [100, 250, 500, 1_000, 2_000, 5_000, 10_000] as const;

const MARKETS: readonly Market[] = [
  { coin: 'BTC', symbol: 'BTCUSDT', lighterMarketId: 1, polymarketInstrumentId: 6 },
  { coin: 'ETH', symbol: 'ETHUSDT', lighterMarketId: 0, polymarketInstrumentId: 7 },
  { coin: 'SOL', symbol: 'SOLUSDT', lighterMarketId: 2, polymarketInstrumentId: 8 },
  { coin: 'HYPE', symbol: 'HYPEUSDT', lighterMarketId: 24, polymarketInstrumentId: 10 },
  { coin: 'XRP', symbol: 'XRPUSDT', lighterMarketId: 7 },
  { coin: 'DOGE', symbol: 'DOGEUSDT', lighterMarketId: 3 },
  { coin: 'ADA', symbol: 'ADAUSDT', lighterMarketId: 39 },
  { coin: 'BNB', symbol: 'BNBUSDT', lighterMarketId: 25 },
  { coin: 'LTC', symbol: 'LTCUSDT', lighterMarketId: 35 },
] as const;

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
const VENUE_CLASS: Record<Venue, VenueClass> = {
  lighter: 'DEX',
  hyperliquid: 'DEX',
  paradex: 'DEX',
  polymarket: 'DEX',
  extended: 'DEX',
  aster: 'DEX',
  binance: 'CEX',
  bybit: 'CEX',
};
const FEE_BPS: Record<Venue, number> = {
  lighter: finiteEnv('VENUE_ARB_FEE_BPS_LIGHTER', 0),
  hyperliquid: finiteEnv('VENUE_ARB_FEE_BPS_HYPERLIQUID', 4.5),
  // API automation is conservatively classified as Paradex Pro 0 taker.
  paradex: finiteEnv('VENUE_ARB_FEE_BPS_PARADEX', 4.5),
  polymarket: finiteEnv('VENUE_ARB_FEE_BPS_POLYMARKET', 4),
  extended: finiteEnv('VENUE_ARB_FEE_BPS_EXTENDED', 2.5),
  aster: finiteEnv('VENUE_ARB_FEE_BPS_ASTER', 4),
  binance: finiteEnv('VENUE_ARB_FEE_BPS_BINANCE', 5),
  bybit: finiteEnv('VENUE_ARB_FEE_BPS_BYBIT', 5.5),
};

const books = new Map<string, BookState>();
const executableBooks = new Map<string, ExecutableBook>();
const bySymbol = new Map(MARKETS.map((market) => [market.symbol, market]));
const byCoin = new Map(MARKETS.map((market) => [market.coin, market]));
const byLighterId = new Map(MARKETS.map((market) => [market.lighterMarketId, market]));
const byPolymarketId = new Map(MARKETS.flatMap((market) => (
  market.polymarketInstrumentId == null
    ? []
    : [[market.polymarketInstrumentId, market] as const]
)));
const bybitDepth = new Map(MARKETS.map((market) => [market.symbol, createBybitDepthBook()]));
const connections = Object.fromEntries(VENUES.map((venue) => [
  venue,
  { connected: false, messages: 0, reconnects: 0, lastMessageAt: 0 },
])) as Record<Venue, ConnectionState>;
const sockets = new Set<WebSocket>();
const active = new Map<string, Opportunity>();
const latchedUntilBelowTrigger = new Set<string>();
const shadowProbes = new Map<string, ShadowProbe>();
const shadowSeen = new Set<string>();
let recentClosed: Opportunity[] = [];
let shadowResults: ShadowResult[] = [];
let startedAt = Date.now();
let evaluations = 0;
let sequence = 0;
let shuttingDown = false;

for (const venue of VENUES) {
  for (const market of MARKETS) books.set(bookKey(venue, market.coin), emptyBook());
}

function finiteEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function emptyBook(): BookState {
  return { bids: new Map(), asks: new Map(), exchangeAt: 0, receivedAt: 0, updates: 0 };
}

function bookKey(venue: Venue, coin: string): string {
  return `${venue}:${coin}`;
}

function routeKey(coin: string, buyVenue: Venue, sellVenue: Venue): string {
  return `${coin}:${buyVenue}:${sellVenue}`;
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sortedLevels(book: BookState, side: Side, limit = 50): PriceLevel[] {
  return [...book[side].entries()]
    .filter(([price, size]) => price > 0 && size > 0)
    .sort((a, b) => side === 'bids' ? b[0] - a[0] : a[0] - b[0])
    .slice(0, limit);
}

function executableBook(venue: Venue, coin: string): ExecutableBook | null {
  const key = bookKey(venue, coin);
  const book = books.get(key);
  if (!book?.receivedAt) return null;
  const cached = executableBooks.get(key);
  if (
    cached
    && cached.receivedAt === book.receivedAt
    && cached.updates === book.updates
  ) return cached;
  const asks = sortedLevels(book, 'asks');
  const bids = sortedLevels(book, 'bids');
  const prepared: ExecutableBook = {
    receivedAt: book.receivedAt,
    updates: book.updates,
    buyVwap500: executableVwap(asks, 500)?.price ?? null,
    buyVwap1000: executableVwap(asks, 1_000)?.price ?? null,
    sellVwap500: executableVwap(bids, 500)?.price ?? null,
    sellVwap1000: executableVwap(bids, 1_000)?.price ?? null,
    buyDepthUsd: asks.reduce((sum, [price, size]) => sum + price * size, 0),
    sellDepthUsd: bids.reduce((sum, [price, size]) => sum + price * size, 0),
  };
  executableBooks.set(key, prepared);
  return prepared;
}

function atomicJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

function shadowLatencyProfile(): {
  entryMs: number;
  exitMs: number;
  measuredTrades: number;
} {
  try {
    const rows = JSON.parse(readFileSync(LIVE_TRADES_PATH, 'utf8')) as Array<{
      entryLatencyMs?: number;
      exitLatencyMs?: number;
    }>;
    const entry = rows.flatMap((row) => (
      Number.isFinite(row.entryLatencyMs) ? [Number(row.entryLatencyMs)] : []
    ));
    const exit = rows.flatMap((row) => (
      Number.isFinite(row.exitLatencyMs) ? [Number(row.exitLatencyMs)] : []
    ));
    return {
      entryMs: conservativeLatencyMs(entry, SHADOW_ENTRY_LATENCY_FLOOR_MS),
      exitMs: conservativeLatencyMs(exit, SHADOW_EXIT_LATENCY_FLOOR_MS),
      measuredTrades: Math.max(entry.length, exit.length),
    };
  } catch {
    return {
      entryMs: SHADOW_ENTRY_LATENCY_FLOOR_MS,
      exitMs: SHADOW_EXIT_LATENCY_FLOOR_MS,
      measuredTrades: 0,
    };
  }
}

function shadowQuote(now: number, coin: string): ShadowQuote | null {
  const extended = executableBook('extended', coin);
  const lighter = executableBook('lighter', coin);
  if (
    !extended
    || !lighter
    || now - extended.receivedAt > SHADOW_FRESH_MS
    || now - lighter.receivedAt > SHADOW_FRESH_MS
  ) return null;
  if (
    extended.buyVwap500 == null
    || lighter.sellVwap500 == null
    || extended.sellVwap500 == null
    || lighter.buyVwap500 == null
  ) return null;
  return {
    at: now,
    version: `${extended.receivedAt}:${lighter.receivedAt}`,
    extendedBuyVwap: extended.buyVwap500,
    lighterSellVwap: lighter.sellVwap500,
    extendedSellVwap: extended.sellVwap500,
    lighterBuyVwap: lighter.buyVwap500,
    openingNetBps: netConvergenceEdgeBps(
      rawCrossEdgeBps(extended.buyVwap500, lighter.sellVwap500),
      FEE_BPS.extended,
      FEE_BPS.lighter,
      EXECUTION_BUFFER_BPS,
    ),
  };
}

function modeledShadowExit(
  probe: ShadowProbe,
  quote: ShadowQuote,
): ReturnType<typeof shadowNetAfterCosts> & { fundingBps: number } | null {
  if (
    probe.openedAt == null
    || probe.entryExtended == null
    || probe.entryLighter == null
    || probe.quantity == null
  ) return null;
  const fundingBps = Math.max(0, quote.at - probe.openedAt)
    / 3_600_000 * SHADOW_FUNDING_BPS_PER_HOUR;
  return {
    ...shadowNetAfterCosts({
      notionalUsd: SHADOW_NOTIONAL_USD,
      quantity: probe.quantity,
      entryExtended: probe.entryExtended,
      entryLighter: probe.entryLighter,
      exitExtended: quote.extendedSellVwap,
      exitLighter: quote.lighterBuyVwap,
      extendedTakerBps: FEE_BPS.extended,
      lighterTakerBps: FEE_BPS.lighter,
      executionBufferBps: EXECUTION_BUFFER_BPS,
      fundingBps,
    }),
    fundingBps,
  };
}

function completeShadow(
  probe: ShadowProbe,
  now: number,
  reason: string,
  quote: ShadowQuote | null,
): void {
  const modeled = quote ? modeledShadowExit(probe, quote) : null;
  const reachedExitGuard = probe.guardReachedAt != null;
  const realizedNetBps = modeled?.netBps ?? null;
  const result: ShadowResult = {
    id: probe.id,
    opportunityId: probe.opportunityId,
    coin: probe.coin,
    signalAt: probe.signalAt,
    signalNetBps: probe.signalNetBps,
    entryAt: probe.openedAt,
    exitAt: now,
    entryLatencyMs: probe.entryLatencyMs,
    exitLatencyMs: probe.exitLatencyMs,
    holdingMs: probe.openedAt == null ? null : Math.max(0, now - probe.openedAt),
    entryNetBps: probe.entryExtended == null || probe.entryLighter == null
      ? null
      : netConvergenceEdgeBps(
        rawCrossEdgeBps(probe.entryExtended, probe.entryLighter),
        FEE_BPS.extended,
        FEE_BPS.lighter,
        EXECUTION_BUFFER_BPS,
      ),
    guardNetBps: probe.guardNetBps,
    peakProjectedNetBps: probe.peakProjectedNetBps,
    realizedNetBps,
    realizedNetUsd: modeled?.netUsd ?? null,
    reachedExitGuard,
    passed: reachedExitGuard && Number(realizedNetBps) > 0,
    reason,
    fundingBps: modeled?.fundingBps ?? 0,
  };
  appendFileSync(SHADOW_RESULTS_PATH, `${JSON.stringify(result)}\n`);
  shadowResults.push(result);
  if (shadowResults.length > 5_000) shadowResults = shadowResults.slice(-5_000);
  shadowProbes.delete(probe.id);
  shadowSeen.add(probe.opportunityId);
}

function evaluateShadow(now: number): void {
  for (const opportunity of active.values()) {
    if (
      opportunity.buyVenue !== 'extended'
      || opportunity.sellVenue !== 'lighter'
      || Number(opportunity.currentNetBps1000) < SHADOW_ENTRY_NET_BPS
      || shadowSeen.has(opportunity.id)
    ) continue;
    const latency = shadowLatencyProfile();
    const id = `S${now}-${opportunity.coin}-${sequence}`;
    shadowProbes.set(id, {
      id,
      opportunityId: opportunity.id,
      coin: opportunity.coin,
      state: 'awaiting_entry',
      signalAt: now,
      signalNetBps: Number(opportunity.currentNetBps1000),
      entryLatencyMs: latency.entryMs,
      exitLatencyMs: latency.exitMs,
      entryDueAt: now + latency.entryMs,
      openedAt: null,
      entryExtended: null,
      entryLighter: null,
      quantity: null,
      guardConfirmations: 0,
      lastGuardQuoteVersion: null,
      guardReachedAt: null,
      guardNetBps: null,
      exitDueAt: null,
      exitQuoteDeadlineAt: null,
      peakProjectedNetBps: null,
    });
    shadowSeen.add(opportunity.id);
  }

  for (const probe of [...shadowProbes.values()]) {
    const quote = shadowQuote(now, probe.coin);
    if (probe.state === 'awaiting_entry') {
      if (now < probe.entryDueAt) continue;
      if (!quote) {
        completeShadow(probe, now, 'stale_at_delayed_entry', null);
        continue;
      }
      if (quote.openingNetBps < SHADOW_ENTRY_NET_BPS) {
        completeShadow(probe, now, 'edge_lost_before_entry', quote);
        continue;
      }
      probe.state = 'open';
      probe.openedAt = now;
      probe.entryExtended = quote.extendedBuyVwap;
      probe.entryLighter = quote.lighterSellVwap;
      probe.quantity = SHADOW_NOTIONAL_USD / quote.extendedBuyVwap;
      continue;
    }
    if (probe.openedAt == null) {
      completeShadow(probe, now, 'invalid_probe_state', quote);
      continue;
    }
    if (now - probe.openedAt >= SHADOW_MAX_HOLD_MS) {
      completeShadow(probe, now, 'max_hold', quote);
      continue;
    }
    if (probe.state === 'awaiting_exit') {
      if (probe.exitDueAt == null || now < probe.exitDueAt) continue;
      if (quote) {
        completeShadow(probe, now, 'protected_exit', quote);
      } else if (
        probe.exitQuoteDeadlineAt != null
        && now >= probe.exitQuoteDeadlineAt
      ) {
        completeShadow(probe, now, 'stale_after_exit_latency', null);
      }
      continue;
    }
    if (!quote) {
      probe.guardConfirmations = 0;
      continue;
    }
    const modeled = modeledShadowExit(probe, quote);
    if (!modeled) {
      probe.guardConfirmations = 0;
      continue;
    }
    probe.peakProjectedNetBps = Math.max(
      probe.peakProjectedNetBps ?? -Infinity,
      modeled.netBps,
    );
    if (modeled.netBps >= SHADOW_EXIT_NET_BPS) {
      if (quote.version !== probe.lastGuardQuoteVersion) {
        probe.guardConfirmations++;
        probe.lastGuardQuoteVersion = quote.version;
      }
    } else {
      probe.guardConfirmations = 0;
      probe.lastGuardQuoteVersion = null;
    }
    if (probe.guardConfirmations >= SHADOW_EXIT_CONFIRMATIONS) {
      probe.state = 'awaiting_exit';
      probe.guardReachedAt = now;
      probe.guardNetBps = modeled.netBps;
      probe.exitDueAt = now + probe.exitLatencyMs;
      probe.exitQuoteDeadlineAt = probe.exitDueAt + SHADOW_EXIT_QUOTE_GRACE_MS;
    }
  }
}

function replaceStringLevels(target: Map<number, number>, rows: unknown): void {
  target.clear();
  if (!Array.isArray(rows)) return;
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const price = finite(raw[0]);
    const size = finite(raw[1]);
    if (price > 0 && size > 0) target.set(price, size);
  }
}

function replaceObjectLevels(target: Map<number, number>, rows: unknown): void {
  target.clear();
  updateObjectLevels(target, rows);
}

function updateObjectLevels(target: Map<number, number>, rows: unknown): void {
  if (!Array.isArray(rows)) return;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { px?: unknown; sz?: unknown; price?: unknown; size?: unknown };
    const price = finite(row.px ?? row.price);
    const size = finite(row.sz ?? row.size);
    if (!(price > 0) || size < 0) continue;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

function markBook(book: BookState, exchangeAt: number, receivedAt: number): void {
  if (!book.bids.size || !book.asks.size) return;
  book.exchangeAt = exchangeAt || receivedAt;
  book.receivedAt = receivedAt;
  book.updates++;
}

function connect(
  venue: Venue,
  url: string,
  onOpen: (ws: WebSocket) => void,
  onMessage: (payload: unknown, receivedAt: number, ws: WebSocket) => void,
  options?: ClientOptions,
): void {
  if (shuttingDown) return;
  const ws = new WebSocket(url, options);
  sockets.add(ws);
  ws.on('open', () => {
    connections[venue].connected = true;
    onOpen(ws);
    console.warn(`venue-arb ${venue} connected`);
  });
  ws.on('message', (data) => {
    const receivedAt = Date.now();
    const state = connections[venue];
    state.messages++;
    state.lastMessageAt = receivedAt;
    try {
      onMessage(JSON.parse(rawText(data)), receivedAt, ws);
    } catch (error) {
      console.warn(`venue-arb ${venue} parse`, (error as Error).message);
    }
  });
  ws.on('pong', () => {
    connections[venue].lastMessageAt = Date.now();
  });
  ws.on('error', () => {
    connections[venue].connected = false;
  });
  ws.on('close', () => {
    sockets.delete(ws);
    connections[venue].connected = false;
    connections[venue].reconnects++;
    if (!shuttingDown) {
      setTimeout(
        () => connect(venue, url, onOpen, onMessage, options),
        RECONNECT_MS,
      ).unref();
    }
  });
}

function startHyperliquid(): void {
  connect(
    'hyperliquid',
    'wss://api.hyperliquid.xyz/ws',
    (ws) => {
      for (const market of MARKETS) {
        ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin: market.coin },
        }));
      }
    },
    (payload, receivedAt) => {
      const message = payload as {
        channel?: unknown;
        data?: { coin?: unknown; time?: unknown; levels?: unknown[] };
      };
      if (message.channel !== 'l2Book' || typeof message.data?.coin !== 'string') return;
      const market = byCoin.get(message.data.coin);
      const book = market ? books.get(bookKey('hyperliquid', market.coin)) : null;
      if (!book) return;
      replaceObjectLevels(book.bids, message.data.levels?.[0]);
      replaceObjectLevels(book.asks, message.data.levels?.[1]);
      markBook(book, finite(message.data.time), receivedAt);
    },
  );
}

function startBinance(): void {
  const streams = MARKETS.map(({ symbol }) => `${symbol.toLowerCase()}@depth5@100ms`);
  connect(
    'binance',
    `wss://fstream.binance.com/stream?streams=${streams.join('/')}`,
    () => {},
    (payload, receivedAt) => {
      const wrapper = payload as { data?: Record<string, unknown> };
      const data = wrapper.data;
      const market = typeof data?.s === 'string' ? bySymbol.get(data.s) : null;
      const book = market ? books.get(bookKey('binance', market.coin)) : null;
      if (!data || !book) return;
      replaceStringLevels(book.bids, data.b);
      replaceStringLevels(book.asks, data.a);
      markBook(book, finite(data.T ?? data.E), receivedAt);
    },
  );
}

function startBybit(): void {
  connect(
    'bybit',
    'wss://stream.bybit.com/v5/public/linear',
    (ws) => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: MARKETS.map(({ symbol }) => `orderbook.50.${symbol}`),
      }));
    },
    (payload, receivedAt) => {
      const message = payload as {
        topic?: string;
        type?: string;
        ts?: unknown;
        cts?: unknown;
        data?: { b?: string[][]; a?: string[][]; u?: number; ts?: unknown; cts?: unknown };
      };
      if (!message.topic?.startsWith('orderbook.50.') || !message.data) return;
      const symbol = message.topic.slice('orderbook.50.'.length);
      const market = bySymbol.get(symbol);
      const depth = bybitDepth.get(symbol);
      const book = market ? books.get(bookKey('bybit', market.coin)) : null;
      if (!market || !depth || !book) return;
      const type = message.type === 'snapshot' || message.data.u === 1 ? 'snapshot' : 'delta';
      if (!applyBybitDepthUpdate(depth, type, message.data.b ?? [], message.data.a ?? [])) return;
      book.bids = new Map(depth.bids);
      book.asks = new Map(depth.asks);
      markBook(book, finite(message.cts ?? message.data.cts ?? message.ts ?? message.data.ts), receivedAt);
    },
  );
}

function lighterMarketId(channel: unknown): number | null {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/[:/](\d+)$/);
  return match ? finite(match[1]) : null;
}

function startLighter(): void {
  const nonces = new Map<number, number>();
  connect(
    'lighter',
    'wss://mainnet.zklighter.elliot.ai/stream',
    (ws) => {
      for (const market of MARKETS) {
        ws.send(JSON.stringify({
          type: 'subscribe',
          channel: `order_book/${market.lighterMarketId}`,
        }));
      }
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(timer);
      }, 5_000);
      timer.unref();
    },
    (payload, receivedAt, ws) => {
      const message = payload as {
        channel?: unknown;
        timestamp?: unknown;
        order_book?: {
          bids?: unknown;
          asks?: unknown;
          nonce?: unknown;
          begin_nonce?: unknown;
        };
      };
      if (!message.order_book) return;
      const marketId = lighterMarketId(message.channel);
      const market = marketId == null ? null : byLighterId.get(marketId);
      const book = market ? books.get(bookKey('lighter', market.coin)) : null;
      if (marketId == null || !market || !book) return;
      const nonce = finite(message.order_book.nonce);
      const beginNonce = finite(message.order_book.begin_nonce);
      const previous = nonces.get(marketId);
      if (previous != null && beginNonce > 0 && beginNonce !== previous) {
        book.bids.clear();
        book.asks.clear();
        nonces.delete(marketId);
        ws.send(JSON.stringify({ type: 'unsubscribe', channel: `order_book/${marketId}` }));
        ws.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${marketId}` }));
        return;
      }
      if (!book.bids.size || !book.asks.size || previous == null) {
        replaceObjectLevels(book.bids, message.order_book.bids);
        replaceObjectLevels(book.asks, message.order_book.asks);
      } else {
        updateObjectLevels(book.bids, message.order_book.bids);
        updateObjectLevels(book.asks, message.order_book.asks);
      }
      if (nonce > 0) nonces.set(marketId, nonce);
      markBook(book, finite(message.timestamp), receivedAt);
    },
  );
}

function startParadex(): void {
  connect(
    'paradex',
    'wss://ws.api.prod.paradex.trade/v1',
    (ws) => {
      for (const market of MARKETS) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'subscribe',
          params: {
            channel: `order_book.${market.coin}-USD-PERP.snapshot@15@50ms`,
          },
          id: market.lighterMarketId + 1_000,
        }));
      }
    },
    (payload, receivedAt) => {
      const message = payload as {
        method?: unknown;
        params?: {
          data?: {
            market?: unknown;
            last_updated_at?: unknown;
            inserts?: Array<{
              side?: unknown;
              price?: unknown;
              size?: unknown;
            }>;
          };
        };
      };
      if (message.method !== 'subscription' || !message.params?.data) return;
      const data = message.params.data;
      const marketName = typeof data.market === 'string' ? data.market : '';
      const coin = marketName.endsWith('-USD-PERP')
        ? marketName.slice(0, -'-USD-PERP'.length)
        : '';
      const market = byCoin.get(coin);
      const book = market ? books.get(bookKey('paradex', market.coin)) : null;
      if (!book) return;
      book.bids.clear();
      book.asks.clear();
      for (const level of data.inserts ?? []) {
        const price = finite(level.price);
        const size = finite(level.size);
        if (!(price > 0) || !(size > 0)) continue;
        if (level.side === 'BUY') book.bids.set(price, size);
        if (level.side === 'SELL') book.asks.set(price, size);
      }
      markBook(book, finite(data.last_updated_at), receivedAt);
    },
  );
}

function startPolymarket(): void {
  connect(
    'polymarket',
    'wss://ws.perpetuals.polymarket.com/v1/ws',
    (ws) => {
      ws.send(JSON.stringify({
        req: 'sub',
        id: 2,
        chs: [...byPolymarketId.keys()].map((instrumentId) => `book::${instrumentId}`),
      }));
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ req: 'post', op: { type: 'ping' } }));
        } else {
          clearInterval(timer);
        }
      }, 30_000);
      timer.unref();
    },
    (payload, receivedAt) => {
      const message = payload as {
        ch?: unknown;
        ts?: unknown;
        data?: { a?: unknown; b?: unknown };
      };
      if (typeof message.ch !== 'string' || !message.ch.startsWith('book::') || !message.data) {
        return;
      }
      const instrumentId = finite(message.ch.slice('book::'.length));
      const market = byPolymarketId.get(instrumentId);
      const book = market ? books.get(bookKey('polymarket', market.coin)) : null;
      if (!book) return;
      replaceStringLevels(book.bids, message.data.b);
      replaceStringLevels(book.asks, message.data.a);
      markBook(book, finite(message.ts), receivedAt);
    },
  );
}

function replaceExtendedLevels(target: Map<number, number>, rows: unknown): void {
  target.clear();
  updateExtendedLevels(target, rows, false);
}

function updateExtendedLevels(
  target: Map<number, number>,
  rows: unknown,
  preferCurrent: boolean,
): void {
  if (!Array.isArray(rows)) return;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { p?: unknown; q?: unknown; c?: unknown };
    const price = finite(row.p);
    const size = finite(preferCurrent ? row.c ?? row.q : row.q ?? row.c);
    if (!(price > 0) || size < 0) continue;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

function startExtended(): void {
  connect(
    'extended',
    'wss://api.starknet.extended.exchange/stream.extended.exchange/v1/orderbooks',
    () => {},
    (payload, receivedAt) => {
      const message = payload as {
        type?: unknown;
        ts?: unknown;
        data?: { m?: unknown; b?: unknown; a?: unknown };
      };
      if (!message.data || typeof message.data.m !== 'string') return;
      const coin = message.data.m.endsWith('-USD')
        ? message.data.m.slice(0, -'-USD'.length)
        : '';
      const market = byCoin.get(coin);
      const book = market ? books.get(bookKey('extended', market.coin)) : null;
      if (!book) return;
      if (message.type === 'SNAPSHOT') {
        replaceExtendedLevels(book.bids, message.data.b);
        replaceExtendedLevels(book.asks, message.data.a);
      } else if (message.type === 'DELTA') {
        updateExtendedLevels(book.bids, message.data.b, true);
        updateExtendedLevels(book.asks, message.data.a, true);
      } else {
        return;
      }
      markBook(book, finite(message.ts), receivedAt);
    },
    {
      headers: { 'User-Agent': 'RobotClaude-Arb-Monitor/1.0' },
    },
  );
}

function startAster(): void {
  const streams = MARKETS.map(({ symbol }) => `${symbol.toLowerCase()}@depth20@100ms`);
  connect(
    'aster',
    `wss://fstream.asterdex.com/stream?streams=${streams.join('/')}`,
    () => {},
    (payload, receivedAt) => {
      const wrapper = payload as { data?: Record<string, unknown> };
      const data = wrapper.data;
      const market = typeof data?.s === 'string' ? bySymbol.get(data.s) : null;
      const book = market ? books.get(bookKey('aster', market.coin)) : null;
      if (!data || !book) return;
      replaceStringLevels(book.bids, data.b);
      replaceStringLevels(book.asks, data.a);
      markBook(book, finite(data.T ?? data.E), receivedAt);
    },
  );
}

function edge(
  now: number,
  coin: string,
  buyVenue: Venue,
  sellVenue: Venue,
): EdgeSnapshot | null {
  const buyBook = executableBook(buyVenue, coin);
  const sellBook = executableBook(sellVenue, coin);
  if (
    !buyBook
    || !sellBook
    || now - buyBook.receivedAt > STALE_MS
    || now - sellBook.receivedAt > STALE_MS
  ) return null;
  if (buyBook.buyVwap500 == null || sellBook.sellVwap500 == null) return null;
  const rawBps500 = rawCrossEdgeBps(
    buyBook.buyVwap500,
    sellBook.sellVwap500,
  );
  const cost = roundTripCostBps(
    FEE_BPS[buyVenue],
    FEE_BPS[sellVenue],
    EXECUTION_BUFFER_BPS,
  );
  const rawBps1000 = buyBook.buyVwap1000 != null
    && sellBook.sellVwap1000 != null
    ? rawCrossEdgeBps(buyBook.buyVwap1000, sellBook.sellVwap1000)
    : null;
  return {
    at: now,
    rawBps500,
    netBps500: netConvergenceEdgeBps(
      rawBps500,
      FEE_BPS[buyVenue],
      FEE_BPS[sellVenue],
      EXECUTION_BUFFER_BPS,
    ),
    rawBps1000,
    netBps1000: rawBps1000 == null ? null : rawBps1000 - cost,
    buyVwap500: buyBook.buyVwap500,
    sellVwap500: sellBook.sellVwap500,
    buyVwap1000: buyBook.buyVwap1000,
    sellVwap1000: sellBook.sellVwap1000,
    buyDepthUsd: buyBook.buyDepthUsd,
    sellDepthUsd: sellBook.sellDepthUsd,
    buyBookAgeMs: now - buyBook.receivedAt,
    sellBookAgeMs: now - sellBook.receivedAt,
  };
}

function startOpportunity(
  coin: string,
  buyVenue: Venue,
  sellVenue: Venue,
  snapshot: EdgeSnapshot,
): Opportunity {
  const id = `${snapshot.at}-${++sequence}-${coin}-${buyVenue}-${sellVenue}`;
  return {
    id,
    coin,
    buyVenue,
    sellVenue,
    route: `${VENUE_CLASS[buyVenue]}→${VENUE_CLASS[sellVenue]}`,
    startedAt: snapshot.at,
    lastAt: snapshot.at,
    closedAt: null,
    durationMs: null,
    closeReason: null,
    startRawBps: snapshot.rawBps500,
    startNetBps: snapshot.netBps500,
    startRawBps1000: snapshot.rawBps1000!,
    startNetBps1000: snapshot.netBps1000!,
    peakRawBps: snapshot.rawBps500,
    peakNetBps: snapshot.netBps500,
    peakRawBps1000: snapshot.rawBps1000!,
    peakNetBps1000: snapshot.netBps1000!,
    currentRawBps: snapshot.rawBps500,
    currentNetBps: snapshot.netBps500,
    currentRawBps1000: snapshot.rawBps1000,
    currentNetBps1000: snapshot.netBps1000,
    currentExecutable1000: snapshot.rawBps1000 != null,
    currentBuyVwap500: snapshot.buyVwap500,
    currentSellVwap500: snapshot.sellVwap500,
    currentBuyVwap1000: snapshot.buyVwap1000,
    currentSellVwap1000: snapshot.sellVwap1000,
    currentBuyDepthUsd: snapshot.buyDepthUsd,
    currentSellDepthUsd: snapshot.sellDepthUsd,
    currentBuyBookAgeMs: snapshot.buyBookAgeMs,
    currentSellBookAgeMs: snapshot.sellBookAgeMs,
    peakAtMs: 0,
    halfLifeMs: null,
    convergenceMs: null,
    startBuyVwap500: snapshot.buyVwap500,
    startSellVwap500: snapshot.sellVwap500,
    executable1000AtStart: snapshot.rawBps1000 != null,
    roundTripCostBps: roundTripCostBps(
      FEE_BPS[buyVenue],
      FEE_BPS[sellVenue],
      EXECUTION_BUFFER_BPS,
    ),
    horizons: {},
  };
}

function updateOpportunity(opportunity: Opportunity, snapshot: EdgeSnapshot): void {
  const elapsed = snapshot.at - opportunity.startedAt;
  opportunity.lastAt = snapshot.at;
  opportunity.currentRawBps = snapshot.rawBps500;
  opportunity.currentNetBps = snapshot.netBps500;
  opportunity.currentRawBps1000 = snapshot.rawBps1000;
  opportunity.currentNetBps1000 = snapshot.netBps1000;
  opportunity.currentExecutable1000 = snapshot.rawBps1000 != null;
  opportunity.currentBuyVwap500 = snapshot.buyVwap500;
  opportunity.currentSellVwap500 = snapshot.sellVwap500;
  opportunity.currentBuyVwap1000 = snapshot.buyVwap1000;
  opportunity.currentSellVwap1000 = snapshot.sellVwap1000;
  opportunity.currentBuyDepthUsd = snapshot.buyDepthUsd;
  opportunity.currentSellDepthUsd = snapshot.sellDepthUsd;
  opportunity.currentBuyBookAgeMs = snapshot.buyBookAgeMs;
  opportunity.currentSellBookAgeMs = snapshot.sellBookAgeMs;
  if (snapshot.rawBps500 > opportunity.peakRawBps) {
    opportunity.peakRawBps = snapshot.rawBps500;
    opportunity.peakAtMs = elapsed;
  }
  opportunity.peakNetBps = Math.max(opportunity.peakNetBps, snapshot.netBps500);
  if (
    snapshot.rawBps1000 != null
    && snapshot.rawBps1000 > opportunity.peakRawBps1000
  ) {
    opportunity.peakRawBps1000 = snapshot.rawBps1000;
    opportunity.peakAtMs = elapsed;
  }
  if (snapshot.netBps1000 != null) {
    opportunity.peakNetBps1000 = Math.max(
      opportunity.peakNetBps1000,
      snapshot.netBps1000,
    );
  }
  if (
    opportunity.halfLifeMs == null
    && (snapshot.netBps1000 == null
      || snapshot.netBps1000 <= opportunity.startNetBps1000 / 2)
  ) opportunity.halfLifeMs = elapsed;
  for (const horizon of HORIZONS_MS) {
    if (elapsed < horizon || opportunity.horizons[String(horizon)]) continue;
    opportunity.horizons[String(horizon)] = {
      rawBps: snapshot.rawBps500,
      netBps: snapshot.netBps500,
      rawBps1000: snapshot.rawBps1000,
      netBps1000: snapshot.netBps1000,
      executable1000: snapshot.rawBps1000 != null,
    };
  }
}

function closeOpportunity(opportunity: Opportunity, at: number, reason: string): void {
  const key = routeKey(opportunity.coin, opportunity.buyVenue, opportunity.sellVenue);
  if (!active.has(key)) return;
  opportunity.closedAt = at;
  opportunity.durationMs = Math.max(0, at - opportunity.startedAt);
  opportunity.closeReason = reason;
  if (reason === 'converged') opportunity.convergenceMs = opportunity.durationMs;
  if (reason === 'max_lifetime') latchedUntilBelowTrigger.add(key);
  active.delete(key);
  appendFileSync(OPPORTUNITIES_PATH, `${JSON.stringify(opportunity)}\n`);
  recentClosed.push(opportunity);
  if (recentClosed.length > 5_000) recentClosed = recentClosed.slice(-5_000);
}

function evaluate(): void {
  const now = Date.now();
  evaluations++;
  const observed = new Set<string>();
  for (const market of MARKETS) {
    for (const buyVenue of VENUES) {
      for (const sellVenue of VENUES) {
        if (buyVenue === sellVenue) continue;
        const key = routeKey(market.coin, buyVenue, sellVenue);
        const snapshot = edge(now, market.coin, buyVenue, sellVenue);
        if (!snapshot) continue;
        observed.add(key);
        const net1000 = snapshot.netBps1000;
        if (net1000 == null || net1000 <= NET_TRIGGER_BPS) {
          latchedUntilBelowTrigger.delete(key);
        }
        let opportunity = active.get(key);
        if (
          !opportunity
          && !latchedUntilBelowTrigger.has(key)
          && net1000 != null
          && net1000 > NET_TRIGGER_BPS
        ) {
          opportunity = startOpportunity(market.coin, buyVenue, sellVenue, snapshot);
          active.set(key, opportunity);
        }
        if (!opportunity) continue;
        updateOpportunity(opportunity, snapshot);
        if (net1000 == null) {
          closeOpportunity(opportunity, now, 'insufficient_depth');
        } else if (net1000 <= 0) {
          closeOpportunity(opportunity, now, 'converged');
        } else if (now - opportunity.startedAt >= MAX_LIFETIME_MS) {
          closeOpportunity(opportunity, now, 'max_lifetime');
        }
      }
    }
  }
  for (const [key, opportunity] of active) {
    if (observed.has(key)) continue;
    // An unchanged book is not evidence of convergence. Keep the lifecycle
    // open and simply omit latency samples until both venues are fresh again.
    if (now - opportunity.startedAt >= MAX_LIFETIME_MS) {
      closeOpportunity(opportunity, now, 'max_lifetime');
    }
  }
  evaluateShadow(now);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
}

function summary(rows: Opportunity[]): Record<string, unknown> {
  const closed = rows.filter((row) => (
    row.durationMs != null
    && Number.isFinite(row.startNetBps1000)
    && Number.isFinite(row.peakNetBps1000)
  ));
  const viable = closed.filter((row) => row.startNetBps1000 > NET_TRIGGER_BPS);
  const survival = Object.fromEntries(HORIZONS_MS.map((horizon) => {
    const samples = closed
      .map((row) => row.horizons[String(horizon)])
      .filter((sample): sample is NonNullable<typeof sample> => sample != null);
    return [String(horizon), {
      sampled: closed.length,
      observedAtHorizon: samples.length,
      rawPositivePct: closed.length
        ? samples.filter((sample) => Number(sample.rawBps1000) > 0).length / closed.length * 100
        : null,
      netPositivePct: closed.length
        ? samples.filter((sample) => Number(sample.netBps1000) > 0).length / closed.length * 100
        : null,
    }];
  }));
  return {
    closed: closed.length,
    viable: viable.length,
    viablePct: closed.length ? viable.length / closed.length * 100 : null,
    medianPeakRawBps: percentile(closed.map((row) => row.peakRawBps1000), 0.5),
    p95PeakRawBps: percentile(closed.map((row) => row.peakRawBps1000), 0.95),
    medianPeakNetBps: percentile(closed.map((row) => row.peakNetBps1000), 0.5),
    medianViablePeakNetBps: percentile(viable.map((row) => row.peakNetBps1000), 0.5),
    maxPeakNetBps: percentile(closed.map((row) => row.peakNetBps1000), 1),
    medianDurationMs: percentile(closed.map((row) => row.durationMs ?? 0), 0.5),
    medianViableDurationMs: percentile(viable.map((row) => row.durationMs ?? 0), 0.5),
    medianHalfLifeMs: percentile(
      closed.flatMap((row) => row.halfLifeMs == null ? [] : [row.halfLifeMs]),
      0.5,
    ),
    survival,
  };
}

function groupedSummaries(rows: Opportunity[]): Record<string, Record<string, unknown>> {
  const groups = new Map<string, Opportunity[]>();
  for (const row of rows) {
    for (const key of [
      `route:${row.route}`,
      `pair:${row.buyVenue}→${row.sellVenue}`,
      `coin:${row.coin}`,
    ]) {
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  }
  return Object.fromEntries([...groups.entries()].map(([key, group]) => [key, summary(group)]));
}

function executionShadowStatus(): Record<string, unknown> {
  const latency = shadowLatencyProfile();
  const readiness = shadowReadiness(
    shadowResults,
    SHADOW_REQUIRED_SAMPLES,
    SHADOW_REQUIRED_PASS_PCT,
  );
  return {
    version: 'extended-lighter-shadow-v1',
    config: {
      notionalUsd: SHADOW_NOTIONAL_USD,
      entryNetBps: SHADOW_ENTRY_NET_BPS,
      exitNetBps: SHADOW_EXIT_NET_BPS,
      exitConfirmations: SHADOW_EXIT_CONFIRMATIONS,
      freshMs: SHADOW_FRESH_MS,
      maxHoldMs: SHADOW_MAX_HOLD_MS,
      fundingBpsPerHour: SHADOW_FUNDING_BPS_PER_HOUR,
      executionBufferBps: EXECUTION_BUFFER_BPS,
    },
    measuredLatency: latency,
    readiness,
    active: [...shadowProbes.values()].sort((a, b) => a.signalAt - b.signalAt),
    recent: shadowResults.slice(-20).reverse(),
  };
}

function writeStatus(): void {
  const now = Date.now();
  const status = {
    version: 'venue-arb-v3-tradeable-1000',
    readOnly: true,
    startedAt,
    updatedAt: now,
    sampleMs: SAMPLE_MS,
    staleMs: STALE_MS,
    netTriggerBps: NET_TRIGGER_BPS,
    executionBufferBps: EXECUTION_BUFFER_BPS,
    notionalsUsd: [500, 1_000],
    feesBpsPerSide: FEE_BPS,
    markets: MARKETS.map((market) => market.coin),
    venues: VENUES.map((venue) => ({ venue, class: VENUE_CLASS[venue] })),
    connections,
    evaluations,
    active: [...active.values()].sort((a, b) => b.peakNetBps1000 - a.peakNetBps1000),
    recentClosed: recentClosed.slice(-100).reverse(),
    summary: summary(recentClosed),
    groupedSummaries: groupedSummaries(recentClosed),
    executionShadow: executionShadowStatus(),
    freshnessMs: Object.fromEntries(MARKETS.map((market) => [
      market.coin,
      Object.fromEntries(VENUES.map((venue) => [
        venue,
        books.get(bookKey(venue, market.coin))?.receivedAt
          ? now - (books.get(bookKey(venue, market.coin))?.receivedAt ?? 0)
          : null,
      ])),
    ])),
  };
  const tmp = `${STATUS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, STATUS_PATH);
  atomicJson(SHADOW_ACTIVE_PATH, [...shadowProbes.values()]);
}

function writeExecutionStatus(): void {
  const now = Date.now();
  const closingQuotes = Object.fromEntries(MARKETS.map((market) => {
    const extended = executableBook('extended', market.coin);
    const lighter = executableBook('lighter', market.coin);
    return [market.coin, {
      // Conservative for the $300 canary: use $500 executable VWAP rather
      // than top-of-book when estimating whether both closing legs are net+.
      notionalUsd: 500,
      extendedSellVwap: extended?.sellVwap500 ?? null,
      lighterBuyVwap: lighter?.buyVwap500 ?? null,
      extendedBookAgeMs: extended?.receivedAt ? now - extended.receivedAt : null,
      lighterBookAgeMs: lighter?.receivedAt ? now - lighter.receivedAt : null,
    }];
  }));
  const status = {
    version: 'venue-arb-execution-v1',
    updatedAt: now,
    sampleMs: SAMPLE_MS,
    closingQuotes,
    active: [...active.values()]
      .filter((row) => row.buyVenue === 'extended' && row.sellVenue === 'lighter')
      .map((row) => ({
        id: row.id,
        coin: row.coin,
        buyVenue: row.buyVenue,
        sellVenue: row.sellVenue,
        startedAt: row.startedAt,
        currentNetBps1000: row.currentNetBps1000,
        currentBuyVwap1000: row.currentBuyVwap1000,
        currentSellVwap1000: row.currentSellVwap1000,
        currentBuyDepthUsd: row.currentBuyDepthUsd,
        currentSellDepthUsd: row.currentSellDepthUsd,
        currentBuyBookAgeMs: row.currentBuyBookAgeMs,
        currentSellBookAgeMs: row.currentSellBookAgeMs,
      })),
  };
  const tmp = `${EXECUTION_STATUS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, EXECUTION_STATUS_PATH);
}

function tailLines(path: string, maxBytes = 4_000_000): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const bytes = Math.min(size, maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, size - bytes);
    const text = buffer.toString('utf8');
    const complete = size > bytes ? text.slice(text.indexOf('\n') + 1) : text;
    return complete.trim().split('\n').filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function loadHistory(): void {
  try {
    recentClosed = tailLines(OPPORTUNITIES_PATH)
      .slice(-5_000)
      .map((line) => JSON.parse(line) as Opportunity);
    sequence = recentClosed.length;
  } catch (error) {
    console.warn('venue-arb history load', (error as Error).message);
    recentClosed = [];
  }
}

function loadShadowState(): void {
  try {
    shadowResults = tailLines(SHADOW_RESULTS_PATH)
      .slice(-5_000)
      .map((line) => JSON.parse(line) as ShadowResult);
    for (const row of shadowResults) shadowSeen.add(row.opportunityId);
  } catch (error) {
    console.warn('venue-arb shadow history load', (error as Error).message);
    shadowResults = [];
  }
  try {
    if (!existsSync(SHADOW_ACTIVE_PATH)) return;
    const rows = JSON.parse(readFileSync(SHADOW_ACTIVE_PATH, 'utf8')) as ShadowProbe[];
    for (const row of rows) {
      if (!row?.id || !row.opportunityId || !row.coin) continue;
      shadowProbes.set(row.id, row);
      shadowSeen.add(row.opportunityId);
    }
  } catch (error) {
    console.warn('venue-arb shadow active load', (error as Error).message);
    shadowProbes.clear();
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(evaluationTimer);
  clearInterval(statusTimer);
  // A service restart is not market convergence and must not contaminate the
  // decay distribution with artificial "closed" opportunities.
  active.clear();
  writeStatus();
  writeExecutionStatus();
  for (const ws of sockets) ws.close();
  console.warn(`venue-arb shutdown ${signal}`);
  setTimeout(() => process.exit(0), 250).unref();
}

mkdirSync(DATA_DIR, { recursive: true });
// Ensure the journal exists before the first lifecycle closes.
if (!existsSync(OPPORTUNITIES_PATH)) writeFileSync(OPPORTUNITIES_PATH, '');
if (!existsSync(SHADOW_RESULTS_PATH)) writeFileSync(SHADOW_RESULTS_PATH, '');
loadHistory();
loadShadowState();
startedAt = Date.now();
startLighter();
startHyperliquid();
startParadex();
startPolymarket();
startExtended();
startAster();
startBinance();
startBybit();
const evaluationTimer = setInterval(() => {
  evaluate();
  writeExecutionStatus();
}, SAMPLE_MS);
const statusTimer = setInterval(writeStatus, 1_000);
writeStatus();
writeExecutionStatus();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.warn(
  `venue-arb read-only started: ${VENUES.join(',')} · ${MARKETS.map((m) => m.coin).join(',')} @ ${SAMPLE_MS}ms`,
);

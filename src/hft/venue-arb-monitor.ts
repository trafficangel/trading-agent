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
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { applyBybitDepthUpdate, createBybitDepthBook } from '../lib/bybit-depth-book.js';
import {
  executableVwap,
  netConvergenceEdgeBps,
  rawCrossEdgeBps,
  roundTripCostBps,
  type PriceLevel,
} from '../lib/venue-arb.js';

type Venue = 'lighter' | 'hyperliquid' | 'paradex' | 'binance' | 'bybit';
type VenueClass = 'DEX' | 'CEX';
type Side = 'bids' | 'asks';

type Market = {
  coin: string;
  symbol: string;
  lighterMarketId: number;
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
  peakRawBps: number;
  peakNetBps: number;
  currentRawBps: number;
  currentNetBps: number;
  currentExecutable1000: boolean;
  peakAtMs: number;
  halfLifeMs: number | null;
  convergenceMs: number | null;
  startBuyVwap500: number;
  startSellVwap500: number;
  executable1000AtStart: boolean;
  roundTripCostBps: number;
  horizons: Record<string, { rawBps: number; netBps: number; executable1000: boolean }>;
};

const DATA_DIR = resolve(process.env.VENUE_ARB_DATA_DIR ?? 'data/venue-arb');
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const OPPORTUNITIES_PATH = resolve(DATA_DIR, 'opportunities.ndjson');
const SAMPLE_MS = finiteEnv('VENUE_ARB_SAMPLE_MS', 100);
const STALE_MS = finiteEnv('VENUE_ARB_STALE_MS', 1_000);
const RAW_TRIGGER_BPS = finiteEnv('VENUE_ARB_RAW_TRIGGER_BPS', 5);
const CONVERGED_BPS = finiteEnv('VENUE_ARB_CONVERGED_BPS', 1);
const EXECUTION_BUFFER_BPS = finiteEnv('VENUE_ARB_EXECUTION_BUFFER_BPS', 2);
const MAX_LIFETIME_MS = finiteEnv('VENUE_ARB_MAX_LIFETIME_MS', 15 * 60_000);
const RECONNECT_MS = 2_000;
const HORIZONS_MS = [100, 250, 500, 1_000, 2_000, 5_000, 10_000] as const;

const MARKETS: readonly Market[] = [
  { coin: 'BTC', symbol: 'BTCUSDT', lighterMarketId: 1 },
  { coin: 'ETH', symbol: 'ETHUSDT', lighterMarketId: 0 },
  { coin: 'SOL', symbol: 'SOLUSDT', lighterMarketId: 2 },
  { coin: 'XRP', symbol: 'XRPUSDT', lighterMarketId: 7 },
  { coin: 'DOGE', symbol: 'DOGEUSDT', lighterMarketId: 3 },
  { coin: 'ADA', symbol: 'ADAUSDT', lighterMarketId: 39 },
  { coin: 'BNB', symbol: 'BNBUSDT', lighterMarketId: 25 },
  { coin: 'LTC', symbol: 'LTCUSDT', lighterMarketId: 35 },
] as const;

const VENUES: readonly Venue[] = ['lighter', 'hyperliquid', 'paradex', 'binance', 'bybit'];
const VENUE_CLASS: Record<Venue, VenueClass> = {
  lighter: 'DEX',
  hyperliquid: 'DEX',
  paradex: 'DEX',
  binance: 'CEX',
  bybit: 'CEX',
};
const FEE_BPS: Record<Venue, number> = {
  lighter: finiteEnv('VENUE_ARB_FEE_BPS_LIGHTER', 0),
  hyperliquid: finiteEnv('VENUE_ARB_FEE_BPS_HYPERLIQUID', 4.5),
  // API automation is conservatively classified as Paradex Pro 0 taker.
  paradex: finiteEnv('VENUE_ARB_FEE_BPS_PARADEX', 4.5),
  binance: finiteEnv('VENUE_ARB_FEE_BPS_BINANCE', 5),
  bybit: finiteEnv('VENUE_ARB_FEE_BPS_BYBIT', 5.5),
};

const books = new Map<string, BookState>();
const bySymbol = new Map(MARKETS.map((market) => [market.symbol, market]));
const byCoin = new Map(MARKETS.map((market) => [market.coin, market]));
const byLighterId = new Map(MARKETS.map((market) => [market.lighterMarketId, market]));
const bybitDepth = new Map(MARKETS.map((market) => [market.symbol, createBybitDepthBook()]));
const connections = Object.fromEntries(VENUES.map((venue) => [
  venue,
  { connected: false, messages: 0, reconnects: 0, lastMessageAt: 0 },
])) as Record<Venue, ConnectionState>;
const sockets = new Set<WebSocket>();
const active = new Map<string, Opportunity>();
const latchedUntilBelowTrigger = new Set<string>();
let recentClosed: Opportunity[] = [];
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
): void {
  if (shuttingDown) return;
  const ws = new WebSocket(url);
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
    if (!shuttingDown) setTimeout(() => connect(venue, url, onOpen, onMessage), RECONNECT_MS).unref();
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

function edge(
  now: number,
  coin: string,
  buyVenue: Venue,
  sellVenue: Venue,
): EdgeSnapshot | null {
  const buyBook = books.get(bookKey(buyVenue, coin));
  const sellBook = books.get(bookKey(sellVenue, coin));
  if (
    !buyBook
    || !sellBook
    || now - buyBook.receivedAt > STALE_MS
    || now - sellBook.receivedAt > STALE_MS
  ) return null;
  const buyLevels = sortedLevels(buyBook, 'asks');
  const sellLevels = sortedLevels(sellBook, 'bids');
  const buy500 = executableVwap(buyLevels, 500);
  const sell500 = executableVwap(sellLevels, 500);
  if (!buy500 || !sell500) return null;
  const rawBps500 = rawCrossEdgeBps(buy500.price, sell500.price);
  const cost = roundTripCostBps(
    FEE_BPS[buyVenue],
    FEE_BPS[sellVenue],
    EXECUTION_BUFFER_BPS,
  );
  const buy1000 = executableVwap(buyLevels, 1_000);
  const sell1000 = executableVwap(sellLevels, 1_000);
  const rawBps1000 = buy1000 && sell1000
    ? rawCrossEdgeBps(buy1000.price, sell1000.price)
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
    buyVwap500: buy500.price,
    sellVwap500: sell500.price,
    buyVwap1000: buy1000?.price ?? null,
    sellVwap1000: sell1000?.price ?? null,
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
    peakRawBps: snapshot.rawBps500,
    peakNetBps: snapshot.netBps500,
    currentRawBps: snapshot.rawBps500,
    currentNetBps: snapshot.netBps500,
    currentExecutable1000: snapshot.rawBps1000 != null,
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
  opportunity.currentExecutable1000 = snapshot.rawBps1000 != null;
  if (snapshot.rawBps500 > opportunity.peakRawBps) {
    opportunity.peakRawBps = snapshot.rawBps500;
    opportunity.peakAtMs = elapsed;
  }
  opportunity.peakNetBps = Math.max(opportunity.peakNetBps, snapshot.netBps500);
  if (
    opportunity.halfLifeMs == null
    && snapshot.rawBps500 <= opportunity.startRawBps / 2
  ) opportunity.halfLifeMs = elapsed;
  for (const horizon of HORIZONS_MS) {
    if (elapsed < horizon || opportunity.horizons[String(horizon)]) continue;
    opportunity.horizons[String(horizon)] = {
      rawBps: snapshot.rawBps500,
      netBps: snapshot.netBps500,
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
        if (snapshot.rawBps500 < RAW_TRIGGER_BPS) latchedUntilBelowTrigger.delete(key);
        let opportunity = active.get(key);
        if (
          !opportunity
          && !latchedUntilBelowTrigger.has(key)
          && snapshot.rawBps500 >= RAW_TRIGGER_BPS
        ) {
          opportunity = startOpportunity(market.coin, buyVenue, sellVenue, snapshot);
          active.set(key, opportunity);
        }
        if (!opportunity) continue;
        updateOpportunity(opportunity, snapshot);
        if (snapshot.rawBps500 <= CONVERGED_BPS) {
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
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
}

function summary(rows: Opportunity[]): Record<string, unknown> {
  const closed = rows.filter((row) => row.durationMs != null);
  const viable = closed.filter((row) => row.peakNetBps > 0);
  const survival = Object.fromEntries(HORIZONS_MS.map((horizon) => {
    const samples = closed
      .map((row) => row.horizons[String(horizon)])
      .filter((sample): sample is NonNullable<typeof sample> => sample != null);
    return [String(horizon), {
      sampled: samples.length,
      rawPositivePct: samples.length
        ? samples.filter((sample) => sample.rawBps > 0).length / samples.length * 100
        : null,
      netPositivePct: samples.length
        ? samples.filter((sample) => sample.netBps > 0).length / samples.length * 100
        : null,
    }];
  }));
  return {
    closed: closed.length,
    viable: viable.length,
    viablePct: closed.length ? viable.length / closed.length * 100 : null,
    medianPeakRawBps: percentile(closed.map((row) => row.peakRawBps), 0.5),
    p95PeakRawBps: percentile(closed.map((row) => row.peakRawBps), 0.95),
    medianPeakNetBps: percentile(closed.map((row) => row.peakNetBps), 0.5),
    medianDurationMs: percentile(closed.map((row) => row.durationMs ?? 0), 0.5),
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

function writeStatus(): void {
  const now = Date.now();
  const status = {
    version: 'venue-arb-v1',
    readOnly: true,
    startedAt,
    updatedAt: now,
    sampleMs: SAMPLE_MS,
    staleMs: STALE_MS,
    rawTriggerBps: RAW_TRIGGER_BPS,
    convergedBps: CONVERGED_BPS,
    executionBufferBps: EXECUTION_BUFFER_BPS,
    notionalsUsd: [500, 1_000],
    feesBpsPerSide: FEE_BPS,
    markets: MARKETS.map((market) => market.coin),
    venues: VENUES.map((venue) => ({ venue, class: VENUE_CLASS[venue] })),
    connections,
    evaluations,
    active: [...active.values()].sort((a, b) => b.peakNetBps - a.peakNetBps),
    recentClosed: recentClosed.slice(-100).reverse(),
    summary: summary(recentClosed),
    groupedSummaries: groupedSummaries(recentClosed),
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

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(evaluationTimer);
  clearInterval(statusTimer);
  // A service restart is not market convergence and must not contaminate the
  // decay distribution with artificial "closed" opportunities.
  active.clear();
  writeStatus();
  for (const ws of sockets) ws.close();
  console.warn(`venue-arb shutdown ${signal}`);
  setTimeout(() => process.exit(0), 250).unref();
}

mkdirSync(DATA_DIR, { recursive: true });
// Ensure the journal exists before the first lifecycle closes.
if (!existsSync(OPPORTUNITIES_PATH)) writeFileSync(OPPORTUNITIES_PATH, '');
loadHistory();
startedAt = Date.now();
startLighter();
startHyperliquid();
startParadex();
startBinance();
startBybit();
const evaluationTimer = setInterval(evaluate, SAMPLE_MS);
const statusTimer = setInterval(writeStatus, 1_000);
writeStatus();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.warn(
  `venue-arb read-only started: ${VENUES.join(',')} · ${MARKETS.map((m) => m.coin).join(',')} @ ${SAMPLE_MS}ms`,
);

/**
 * Read-only, gap-aware Lighter microstructure recorder.
 *
 * It subscribes only to public order_book, trade and market_stats channels and
 * stores compact one-minute aggregates. No account, signer, API key or order
 * method is imported. One-minute rows can be rolled up deterministically to 5m.
 */

import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import WebSocket, { type RawData } from 'ws';
import {
  LighterMinuteAccumulator,
  applyLighterBookUpdate,
  createLighterBookState,
  isUsableMicrostructureMinute,
  lighterBookMetrics,
  resetLighterBookState,
  type LighterBookUpdate,
  type LighterTrade,
  type MinuteMicrostructure,
} from '../lib/lighter-microstructure.js';

const WS_URL =
  process.env.LIGHTER_MICRO_WS ?? 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';
const DB_PATH = resolve(
  process.env.LIGHTER_MICRO_DB ?? 'data/lighter-native-microstructure.sqlite',
);
const STATUS_PATH = resolve(
  process.env.LIGHTER_MICRO_STATUS ?? 'data/lighter-native-microstructure-status.json',
);
const SAMPLE_MS = Math.max(250, Number(process.env.LIGHTER_MICRO_SAMPLE_MS ?? 1_000));
const SOCKET_STALE_MS = Math.max(1_000, Number(process.env.LIGHTER_MICRO_SOCKET_STALE_MS ?? 5_000));
const MARKET_STALE_MS = Math.max(
  10_000,
  Number(process.env.LIGHTER_MICRO_MARKET_STALE_MS ?? 60_000),
);
const RETENTION_DAYS = Math.max(7, Number(process.env.LIGHTER_MICRO_RETENTION_DAYS ?? 60));
const MINUTE_MS = 60_000;
const RECONNECT_MS = 2_000;
const PING_MS = 30_000;

const ALL_MARKETS = [
  { symbol: 'BTC', marketId: 1 },
  { symbol: 'ETH', marketId: 0 },
  { symbol: 'SOL', marketId: 2 },
  { symbol: 'BNB', marketId: 25 },
  { symbol: 'LTC', marketId: 35 },
  { symbol: 'HYPE', marketId: 24 },
  { symbol: 'ZEC', marketId: 90 },
  { symbol: 'DOGE', marketId: 3 },
  { symbol: 'NEAR', marketId: 10 },
  { symbol: 'JUP', marketId: 26 },
  { symbol: 'LIT', marketId: 120 },
  { symbol: 'GRAM', marketId: 12 },
  { symbol: 'XMR', marketId: 77 },
  { symbol: 'ENA', marketId: 29 },
  { symbol: 'TAO', marketId: 13 },
] as const;

const requestedSymbols = new Set(
  (process.env.LIGHTER_MICRO_MARKETS ?? ALL_MARKETS.map((market) => market.symbol).join(','))
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean),
);
const MARKETS = ALL_MARKETS.filter((market) => requestedSymbols.has(market.symbol));
if (!MARKETS.length) throw new Error('LIGHTER_MICRO_MARKETS selected no known markets');

type MarketRuntime = {
  symbol: string;
  marketId: number;
  book: ReturnType<typeof createLighterBookState>;
  accumulator: LighterMinuteAccumulator;
  lastBookAt: number;
  lastMarketMessageAt: number;
  exchangeAt: number;
  resyncs: number;
  messages: number;
  seenTradeIds: Set<string>;
};

type RecorderStatus = {
  startedAt: number;
  connected: boolean;
  reconnects: number;
  rows: number;
  invalidMessages: number;
  lastMessageAt: number;
};

function minuteStart(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function marketIdFromChannel(channel: unknown): number | null {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/[:/](\d+)$/);
  if (!match?.[1]) return null;
  const marketId = Number(match[1]);
  return Number.isInteger(marketId) ? marketId : null;
}

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(dirname(STATUS_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS lighter_microstructure_1m (
    market_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    minute_ts_ms INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    book_updates INTEGER NOT NULL,
    nonce_gaps INTEGER NOT NULL,
    stale_samples INTEGER NOT NULL,
    mid_open REAL,
    mid_high REAL,
    mid_low REAL,
    mid_close REAL,
    spread_avg_pct REAL,
    spread_max_pct REAL,
    bid5_usd_avg REAL,
    ask5_usd_avg REAL,
    depth_imbalance_avg REAL,
    depth_imbalance_close REAL,
    book_age_avg_ms REAL,
    book_age_p95_ms REAL,
    buy_usd REAL NOT NULL,
    sell_usd REAL NOT NULL,
    cvd_usd REAL NOT NULL,
    trade_count INTEGER NOT NULL,
    liquidation_buy_usd REAL NOT NULL,
    liquidation_sell_usd REAL NOT NULL,
    index_price REAL,
    mark_price REAL,
    basis_pct REAL,
    current_funding_rate REAL,
    last_funding_rate REAL,
    quality_ok INTEGER NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (market_id, minute_ts_ms)
  );
  CREATE INDEX IF NOT EXISTS idx_lighter_microstructure_symbol_time
    ON lighter_microstructure_1m(symbol, minute_ts_ms);
`);

const insertRow = db.prepare(`
  INSERT OR REPLACE INTO lighter_microstructure_1m (
    market_id, symbol, minute_ts_ms, samples, book_updates, nonce_gaps, stale_samples,
    mid_open, mid_high, mid_low, mid_close, spread_avg_pct, spread_max_pct,
    bid5_usd_avg, ask5_usd_avg, depth_imbalance_avg, depth_imbalance_close,
    book_age_avg_ms, book_age_p95_ms, buy_usd, sell_usd, cvd_usd, trade_count,
    liquidation_buy_usd, liquidation_sell_usd, index_price, mark_price, basis_pct,
    current_funding_rate, last_funding_rate, quality_ok, recorded_at_ms
  ) VALUES (
    @marketId, @symbol, @minuteTsMs, @samples, @bookUpdates, @nonceGaps, @staleSamples,
    @midOpen, @midHigh, @midLow, @midClose, @spreadAvgPct, @spreadMaxPct,
    @bid5UsdAvg, @ask5UsdAvg, @depthImbalanceAvg, @depthImbalanceClose,
    @bookAgeAvgMs, @bookAgeP95Ms, @buyUsd, @sellUsd, @cvdUsd, @tradeCount,
    @liquidationBuyUsd, @liquidationSellUsd, @indexPrice, @markPrice, @basisPct,
    @currentFundingRate, @lastFundingRate, @qualityOk, @recordedAtMs
  )
`);

const startedAt = Date.now();
const state: RecorderStatus = {
  startedAt,
  connected: false,
  reconnects: 0,
  rows: 0,
  invalidMessages: 0,
  lastMessageAt: 0,
};
const markets = new Map<number, MarketRuntime>(
  MARKETS.map((market) => [
    market.marketId,
    {
      ...market,
      book: createLighterBookState(),
      accumulator: new LighterMinuteAccumulator(minuteStart(startedAt)),
      lastBookAt: 0,
      lastMarketMessageAt: 0,
      exchangeAt: 0,
      resyncs: 0,
      messages: 0,
      seenTradeIds: new Set<string>(),
    },
  ]),
);

function persist(runtime: MarketRuntime, row: MinuteMicrostructure, recordedAtMs: number): void {
  const expectedSamples = MINUTE_MS / SAMPLE_MS;
  const qualityOk = isUsableMicrostructureMinute(row, expectedSamples);
  insertRow.run({
    ...row,
    marketId: runtime.marketId,
    symbol: runtime.symbol,
    qualityOk: qualityOk ? 1 : 0,
    recordedAtMs,
  });
  state.rows++;
}

const persistBatch = db.transaction(
  (rows: Array<{ runtime: MarketRuntime; row: MinuteMicrostructure }>) => {
    const now = Date.now();
    for (const { runtime, row } of rows) persist(runtime, row, now);
  },
);

function rotateBuckets(now: number): void {
  const currentMinute = minuteStart(now);
  const completed: Array<{ runtime: MarketRuntime; row: MinuteMicrostructure }> = [];
  for (const runtime of markets.values()) {
    if (runtime.accumulator.minuteTsMs >= currentMinute) continue;
    completed.push({ runtime, row: runtime.accumulator.snapshot() });
    runtime.accumulator = new LighterMinuteAccumulator(currentMinute);
  }
  if (completed.length) persistBatch(completed);
}

function accumulatorFor(runtime: MarketRuntime, now: number): LighterMinuteAccumulator {
  rotateBuckets(now);
  return runtime.accumulator;
}

function writeStatus(): void {
  const now = Date.now();
  let dbBytes = 0;
  try {
    dbBytes = statSync(DB_PATH).size;
  } catch {
    /* status remains useful */
  }
  const payload = {
    version: 'lighter-native-microstructure-v2',
    checkedAt: now,
    sampleMs: SAMPLE_MS,
    socketStaleMs: SOCKET_STALE_MS,
    marketStaleMs: MARKET_STALE_MS,
    retentionDays: RETENTION_DAYS,
    dbPath: DB_PATH,
    dbBytes,
    ...state,
    markets: [...markets.values()].map((runtime) => ({
      symbol: runtime.symbol,
      marketId: runtime.marketId,
      messages: runtime.messages,
      resyncs: runtime.resyncs,
      lastBookAgeMs: runtime.lastBookAt ? now - runtime.lastBookAt : null,
      lastMarketMessageAgeMs: runtime.lastMarketMessageAt
        ? now - runtime.lastMarketMessageAt
        : null,
      bookLevels: { bids: runtime.book.bids.size, asks: runtime.book.asks.size },
    })),
  };
  const temporary = `${STATUS_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2));
  renameSync(temporary, STATUS_PATH);
}

function sampleBooks(): void {
  const now = Date.now();
  rotateBuckets(now);
  for (const runtime of markets.values()) {
    const accumulator = runtime.accumulator;
    const ageMs = runtime.lastBookAt ? now - runtime.lastBookAt : Number.POSITIVE_INFINITY;
    const metrics = lighterBookMetrics(runtime.book);
    const socketAgeMs = state.lastMessageAt ? now - state.lastMessageAt : Number.POSITIVE_INFINITY;
    const marketAgeMs = runtime.lastMarketMessageAt
      ? now - runtime.lastMarketMessageAt
      : Number.POSITIVE_INFINITY;
    if (!metrics || socketAgeMs > SOCKET_STALE_MS || marketAgeMs > MARKET_STALE_MS) {
      accumulator.noteStaleSample();
      continue;
    }
    accumulator.sampleBook(metrics, ageMs);
  }
}

function tradeId(trade: LighterTrade): string | null {
  const value = trade.trade_id_str ?? trade.trade_id;
  return value == null ? null : String(value);
}

function addTrades(runtime: MarketRuntime, rows: unknown, liquidation: boolean, now: number): void {
  if (!Array.isArray(rows)) return;
  const accumulator = accumulatorFor(runtime, now);
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const trade = value as LighterTrade;
    const id = tradeId(trade);
    if (id && runtime.seenTradeIds.has(id)) continue;
    if (id) runtime.seenTradeIds.add(id);
    accumulator.addTrade(trade, liquidation);
  }
  if (runtime.seenTradeIds.size > 20_000) {
    const keep = [...runtime.seenTradeIds].slice(-10_000);
    runtime.seenTradeIds = new Set(keep);
  }
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

function subscribe(ws: WebSocket, marketId: number): void {
  for (const channel of [
    `order_book/${marketId}`,
    `trade/${marketId}`,
    `market_stats/${marketId}`,
  ]) {
    ws.send(JSON.stringify({ type: 'subscribe', channel }));
  }
}

function resubscribeBook(runtime: MarketRuntime): void {
  resetLighterBookState(runtime.book);
  runtime.lastBookAt = 0;
  runtime.exchangeAt = 0;
  runtime.resyncs++;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'unsubscribe', channel: `order_book/${runtime.marketId}` }));
  socket.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${runtime.marketId}` }));
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect(): void {
  try {
    socket = new WebSocket(WS_URL, { perMessageDeflate: true, maxPayload: 64 * 1024 * 1024 });
  } catch (error) {
    console.warn('lighter-microstructure: websocket construct failed', error);
    scheduleReconnect();
    return;
  }

  socket.on('open', () => {
    state.connected = true;
    for (const runtime of markets.values()) {
      resetLighterBookState(runtime.book);
      runtime.lastBookAt = 0;
      runtime.lastMarketMessageAt = 0;
      subscribe(socket as WebSocket, runtime.marketId);
    }
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try {
        socket?.ping();
      } catch {
        // The close handler owns reconnect and data-quality marking.
      }
    }, PING_MS);
    console.warn(`lighter-microstructure: connected ${markets.size} markets`);
  });

  socket.on('message', (data) => {
    const receivedAt = Date.now();
    state.lastMessageAt = receivedAt;
    try {
      const message = JSON.parse(rawText(data)) as {
        channel?: unknown;
        timestamp?: unknown;
        order_book?: LighterBookUpdate;
        market_stats?: Record<string, unknown>;
        trades?: unknown;
        liquidation_trades?: unknown;
      };
      const marketId = marketIdFromChannel(message.channel);
      const runtime = marketId == null ? null : markets.get(marketId);
      if (!runtime) return;
      runtime.messages++;
      runtime.lastMarketMessageAt = receivedAt;
      const accumulator = accumulatorFor(runtime, receivedAt);

      if (message.order_book) {
        const outcome = applyLighterBookUpdate(runtime.book, message.order_book);
        if (outcome === 'gap') {
          accumulator.noteNonceGap();
          resubscribeBook(runtime);
          return;
        }
        if (outcome === 'invalid') {
          state.invalidMessages++;
          return;
        }
        accumulator.noteBookUpdate();
        runtime.lastBookAt = receivedAt;
        const exchangeAt = Number(message.timestamp);
        runtime.exchangeAt = Number.isFinite(exchangeAt) ? exchangeAt : receivedAt;
      }
      if (message.market_stats) accumulator.updateStats(message.market_stats);
      addTrades(runtime, message.trades, false, receivedAt);
      addTrades(runtime, message.liquidation_trades, true, receivedAt);
    } catch (error) {
      state.invalidMessages++;
      console.warn('lighter-microstructure: invalid message', error);
    }
  });

  socket.on('ping', () => {
    try {
      socket?.pong();
    } catch {
      /* close owns recovery */
    }
  });
  socket.on('close', () => {
    state.connected = false;
    state.reconnects++;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    const now = Date.now();
    for (const runtime of markets.values()) {
      accumulatorFor(runtime, now).noteNonceGap();
      resetLighterBookState(runtime.book);
      runtime.lastBookAt = 0;
      runtime.lastMarketMessageAt = 0;
    }
    scheduleReconnect();
  });
  socket.on('error', (error) => {
    console.warn('lighter-microstructure: websocket error', error.message);
  });
}

function prune(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * MINUTE_MS;
  db.prepare('DELETE FROM lighter_microstructure_1m WHERE minute_ts_ms < ?').run(cutoff);
  db.pragma('wal_checkpoint(PASSIVE)');
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  state.connected = false;
  console.warn(`lighter-microstructure: shutdown ${signal}`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
  writeStatus();
  db.close();
  process.exit(0);
}

setInterval(sampleBooks, SAMPLE_MS);
setInterval(writeStatus, 5_000);
setInterval(prune, 60 * MINUTE_MS);
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connect();
writeStatus();

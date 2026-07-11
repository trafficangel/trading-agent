/**
 * Read-only 250ms multi-venue recorder for the Hyperliquid lead-lag study.
 *
 * Runs on the Tokyo host. It records synchronized BBO/L2/trade-flow snapshots
 * from Hyperliquid, Binance USD-M futures and Bybit linear futures. There are
 * deliberately no private clients, keys or order methods in this process.
 * Hourly gzip NDJSON files are compact enough to retain while preserving the
 * exchange and local receive timestamps needed for latency stress tests.
 */

import { createWriteStream, mkdirSync, renameSync, writeFileSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createGzip, type Gzip } from 'node:zlib';

const SAMPLE_MS = Number(process.env.HFT_SAMPLE_MS ?? 250);
const STALE_MS = Number(process.env.HFT_STALE_MS ?? 3_000);
const DATA_DIR = resolve(process.env.HFT_DATA_DIR ?? 'data/hft-leadlag');
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const RECONNECT_MS = 2_000;

const MARKETS = [
  { coin: 'BTC', symbol: 'BTCUSDT' },
  { coin: 'ETH', symbol: 'ETHUSDT' },
  { coin: 'SOL', symbol: 'SOLUSDT' },
  { coin: 'XRP', symbol: 'XRPUSDT' },
  // Pre-registered Jul 11: cross-listed HL markets where current spread can
  // clear a 3bps maker-maker round trip while daily notional remains usable.
  // Majors above remain the narrow-spread control group.
  { coin: 'UNI', symbol: 'UNIUSDT' },
  { coin: 'LIT', symbol: 'LITUSDT' },
  { coin: 'VIRTUAL', symbol: 'VIRTUALUSDT' },
  { coin: 'JUP', symbol: 'JUPUSDT' },
  { coin: 'SAGA', symbol: 'SAGAUSDT' },
] as const;

type Venue = 'hl' | 'binance' | 'bybit';
type Book = {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bid5: number;
  ask5: number;
  exchangeAt: number;
  receivedAt: number;
};
type Flow = {
  buy: number;
  sell: number;
  buyHigh: number | null;
  sellLow: number | null;
  trades: number;
  prices: Map<number, number>;
};
type MarketState = {
  coin: string;
  symbol: string;
  books: Record<Venue, Book>;
  flows: Record<Venue, Flow>;
};

const emptyBook = (): Book => ({ bid: 0, ask: 0, bidSize: 0, askSize: 0, bid5: 0, ask5: 0, exchangeAt: 0, receivedAt: 0 });
const emptyFlow = (): Flow => ({ buy: 0, sell: 0, buyHigh: null, sellLow: null, trades: 0, prices: new Map() });
const states = new Map<string, MarketState>(MARKETS.map((m) => [m.coin, {
  coin: m.coin,
  symbol: m.symbol,
  books: { hl: emptyBook(), binance: emptyBook(), bybit: emptyBook() },
  flows: { hl: emptyFlow(), binance: emptyFlow(), bybit: emptyFlow() },
}]));
const bySymbol = new Map<string, string>(MARKETS.map((m) => [m.symbol, m.coin]));

const connectionState: Record<Venue, { connected: boolean; messages: number; reconnects: number; lastMessageAt: number }> = {
  hl: { connected: false, messages: 0, reconnects: 0, lastMessageAt: 0 },
  binance: { connected: false, messages: 0, reconnects: 0, lastMessageAt: 0 },
  bybit: { connected: false, messages: 0, reconnects: 0, lastMessageAt: 0 },
};

let rows = 0;
let dropped = 0;
let startedAt = Date.now();
let currentSegment = '';
let currentPath = '';
let gzip: Gzip | null = null;
let file: WriteStream | null = null;
let shuttingDown = false;

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function segmentKey(now: number): string {
  const date = new Date(now);
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15, 0, 0);
  return date.toISOString().slice(0, 16).replace(/[-T:]/g, '');
}

function openHour(now: number): void {
  const segment = segmentKey(now);
  if (segment === currentSegment && gzip) return;
  gzip?.end();
  currentSegment = segment;
  currentPath = resolve(DATA_DIR, `leadlag-${segment}.ndjson.gz`);
  file = createWriteStream(currentPath, { flags: 'a' });
  gzip = createGzip({ level: 6 });
  gzip.pipe(file);
  gzip.on('error', (error) => { console.error('leadlag gzip error', error); });
  file.on('error', (error) => { console.error('leadlag file error', error); });
}

function appendFlow(flow: Flow, side: 'buy' | 'sell', price: number, size: number): void {
  if (!(price > 0) || !(size > 0)) return;
  flow[side] += size;
  flow.trades++;
  if (side === 'buy') flow.buyHigh = flow.buyHigh == null ? price : Math.max(flow.buyHigh, price);
  else flow.sellLow = flow.sellLow == null ? price : Math.min(flow.sellLow, price);
  const signedSize = side === 'buy' ? size : -size;
  flow.prices.set(price, (flow.prices.get(price) ?? 0) + signedSize);
}

function resetFlows(state: MarketState): void {
  state.flows.hl = emptyFlow();
  state.flows.binance = emptyFlow();
  state.flows.bybit = emptyFlow();
}

function bookTuple(book: Book): number[] {
  return [book.bid, book.ask, book.bidSize, book.askSize, book.bid5, book.ask5, book.exchangeAt, book.receivedAt];
}

function flowTuple(flow: Flow): Array<number | null> {
  return [flow.buy, flow.sell, flow.buyHigh, flow.sellLow, flow.trades];
}

function priceFlowTuple(flow: Flow): number[] {
  return [...flow.prices.entries()].sort((a, b) => a[0] - b[0]).flatMap(([price, signedSize]) => [price, signedSize]);
}

function sample(): void {
  const now = Date.now();
  openHour(now);
  if (!gzip) return;
  for (const state of states.values()) {
    const ready = (Object.values(state.books) as Book[]).every((book) =>
      book.bid > 0 && book.ask > book.bid && now - book.receivedAt <= STALE_MS,
    );
    if (ready) {
      const row = {
        v: 1,
        t: now,
        s: state.coin,
        h: bookTuple(state.books.hl),
        b: bookTuple(state.books.binance),
        y: bookTuple(state.books.bybit),
        f: [...flowTuple(state.flows.hl), ...flowTuple(state.flows.binance), ...flowTuple(state.flows.bybit)],
        x: priceFlowTuple(state.flows.hl),
      };
      if (!gzip.write(`${JSON.stringify(row)}\n`)) dropped++;
      rows++;
    }
    resetFlows(state);
  }
}

function writeStatus(): void {
  const now = Date.now();
  const status = {
    version: 'leadlag-v1',
    startedAt,
    checkedAt: now,
    sampleMs: SAMPLE_MS,
    staleMs: STALE_MS,
    markets: MARKETS.map((m) => m.coin),
    rows,
    dropped,
    currentPath,
    connections: connectionState,
    freshnessMs: Object.fromEntries([...states.values()].map((state) => [state.coin, {
      hl: now - state.books.hl.receivedAt,
      binance: now - state.books.binance.receivedAt,
      bybit: now - state.books.bybit.receivedAt,
    }])),
  };
  const tmp = `${STATUS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2));
  renameSync(tmp, STATUS_PATH);
}

function textData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data);
}

function connect(
  venue: Venue,
  url: string,
  onOpen: (ws: WebSocket) => void,
  onMessage: (payload: unknown, receivedAt: number) => void,
): void {
  if (shuttingDown) return;
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    connectionState[venue].connected = true;
    onOpen(ws);
    console.warn(`leadlag ${venue} connected`);
  });
  ws.addEventListener('message', (event) => {
    const receivedAt = Date.now();
    connectionState[venue].messages++;
    connectionState[venue].lastMessageAt = receivedAt;
    try { onMessage(JSON.parse(textData(event.data)), receivedAt); }
    catch (error) { console.warn(`leadlag ${venue} parse`, error); }
  });
  ws.addEventListener('error', () => { connectionState[venue].connected = false; });
  ws.addEventListener('close', () => {
    connectionState[venue].connected = false;
    connectionState[venue].reconnects++;
    if (!shuttingDown) setTimeout(() => connect(venue, url, onOpen, onMessage), RECONNECT_MS);
  });
}

function startHyperliquid(): void {
  connect('hl', 'wss://api.hyperliquid.xyz/ws', (ws) => {
    for (const { coin } of MARKETS) {
      for (const type of ['bbo', 'l2Book', 'trades']) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type, coin } }));
    }
  }, (payload, receivedAt) => {
    const message = payload as { channel?: string; data?: unknown };
    if (message.channel === 'bbo') {
      const data = message.data as { coin?: string; time?: number; bbo?: Array<{ px?: string; sz?: string; n?: number } | null> };
      const state = data.coin ? states.get(data.coin) : null;
      const bid = data.bbo?.[0]; const ask = data.bbo?.[1];
      if (!state || !bid || !ask) return;
      Object.assign(state.books.hl, {
        bid: finite(bid.px), ask: finite(ask.px), bidSize: finite(bid.sz), askSize: finite(ask.sz),
        exchangeAt: finite(data.time), receivedAt,
      });
    } else if (message.channel === 'l2Book') {
      const data = message.data as { coin?: string; time?: number; levels?: Array<Array<{ px?: string; sz?: string }>> };
      const state = data.coin ? states.get(data.coin) : null;
      const bids = data.levels?.[0] ?? []; const asks = data.levels?.[1] ?? [];
      if (!state || !bids[0] || !asks[0]) return;
      Object.assign(state.books.hl, {
        bid: finite(bids[0].px), ask: finite(asks[0].px), bidSize: finite(bids[0].sz), askSize: finite(asks[0].sz),
        bid5: bids.slice(0, 5).reduce((sum, level) => sum + finite(level.sz), 0),
        ask5: asks.slice(0, 5).reduce((sum, level) => sum + finite(level.sz), 0),
        exchangeAt: finite(data.time), receivedAt,
      });
    } else if (message.channel === 'trades' && Array.isArray(message.data)) {
      for (const trade of message.data as Array<{ coin?: string; side?: string; px?: string; sz?: string }>) {
        const state = trade.coin ? states.get(trade.coin) : null;
        if (state) appendFlow(state.flows.hl, trade.side === 'B' ? 'buy' : 'sell', finite(trade.px), finite(trade.sz));
      }
    }
  });
}

function startBinance(): void {
  const streams = MARKETS.flatMap(({ symbol }) => [`${symbol.toLowerCase()}@bookTicker`, `${symbol.toLowerCase()}@aggTrade`]);
  connect('binance', `wss://fstream.binance.com/stream?streams=${streams.join('/')}`, () => {}, (payload, receivedAt) => {
    const wrapper = payload as { data?: Record<string, unknown> };
    const data = wrapper.data;
    const symbol = typeof data?.s === 'string' ? data.s : '';
    const coin = bySymbol.get(symbol); const state = coin ? states.get(coin) : null;
    if (!data || !state) return;
    if (data.e === 'bookTicker') {
      Object.assign(state.books.binance, {
        bid: finite(data.b), ask: finite(data.a), bidSize: finite(data.B), askSize: finite(data.A),
        bid5: finite(data.B), ask5: finite(data.A), exchangeAt: finite(data.T ?? data.E), receivedAt,
      });
    } else if (data.e === 'aggTrade') {
      appendFlow(state.flows.binance, data.m === true ? 'sell' : 'buy', finite(data.p), finite(data.q));
    }
  });
}

function startBybit(): void {
  connect('bybit', 'wss://stream.bybit.com/v5/public/linear', (ws) => {
    ws.send(JSON.stringify({ op: 'subscribe', args: MARKETS.flatMap(({ symbol }) => [`orderbook.1.${symbol}`, `publicTrade.${symbol}`]) }));
  }, (payload, receivedAt) => {
    const message = payload as { topic?: string; ts?: number; cts?: number; data?: unknown };
    if (message.topic?.startsWith('orderbook.1.')) {
      const symbol = message.topic.slice('orderbook.1.'.length);
      const coin = bySymbol.get(symbol); const state = coin ? states.get(coin) : null;
      const data = message.data as { b?: string[][]; a?: string[][]; ts?: number; cts?: number };
      if (!state || !data.b?.[0] || !data.a?.[0]) return;
      Object.assign(state.books.bybit, {
        bid: finite(data.b[0][0]), ask: finite(data.a[0][0]), bidSize: finite(data.b[0][1]), askSize: finite(data.a[0][1]),
        bid5: finite(data.b[0][1]), ask5: finite(data.a[0][1]), exchangeAt: finite(message.cts ?? data.cts ?? message.ts ?? data.ts), receivedAt,
      });
    } else if (message.topic?.startsWith('publicTrade.') && Array.isArray(message.data)) {
      for (const trade of message.data as Array<{ s?: string; S?: string; p?: string; v?: string }>) {
        const coin = trade.s ? bySymbol.get(trade.s) : null; const state = coin ? states.get(coin) : null;
        if (state) appendFlow(state.flows.bybit, trade.S === 'Buy' ? 'buy' : 'sell', finite(trade.p), finite(trade.v));
      }
    }
  });
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`leadlag shutdown ${signal}`);
  clearInterval(sampleTimer);
  clearInterval(statusTimer);
  writeStatus();
  const closingFile = file;
  if (closingFile) closingFile.once('finish', () => process.exit(0));
  gzip?.end();
  setTimeout(() => process.exit(0), 2_000).unref();
}

mkdirSync(DATA_DIR, { recursive: true });
startedAt = Date.now();
openHour(startedAt);
startHyperliquid();
startBinance();
startBybit();
const sampleTimer = setInterval(sample, SAMPLE_MS);
const statusTimer = setInterval(writeStatus, 10_000);
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.warn(`leadlag collector started: ${MARKETS.map((m) => m.coin).join(',')} @ ${SAMPLE_MS}ms -> ${DATA_DIR}`);

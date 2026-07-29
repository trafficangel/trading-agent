/**
 * Read-only Binance + Extended -> Lighter lead-lag execution shadow.
 *
 * Binance is used as the fast public signal and Extended must confirm its
 * direction before an entry is modeled. Entries and exits are modeled against
 * the live Lighter BBO after explicit execution latency, top-level capacity
 * checks and a configurable round-trip execution buffer. There are no private
 * clients, keys or order methods in this process.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  leadLagResidualBps,
  leadLagReturnBps,
  lighterRoundTripNetBps,
  summarizeLeadLag,
  topLevelDepthUsd,
  type LeadLagSide,
} from '../lib/lighter-leadlag.js';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

type Market = {
  coin: string;
  symbol: string;
  lighterMarketId: number;
};

type Quote = {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  exchangeAt: number;
  receivedAt: number;
  updates: number;
};

type Point = {
  at: number;
  binanceMid: number;
  extendedMid: number;
  lighterMid: number;
};

type Config = {
  id: string;
  lookbackMs: number;
  holdMs: number;
  thresholdBps: number;
};

type Probe = {
  id: string;
  configId: string;
  coin: string;
  side: LeadLagSide;
  state: 'awaiting_entry' | 'open';
  signalAt: number;
  signalLeaderBps: number;
  signalConfirmBps: number;
  signalResidualBps: number;
  entryDueAt: number;
  openedAt: number | null;
  exitDueAt: number | null;
  entryPrice: number | null;
  entryDepthUsd: number | null;
};

type Result = {
  id: string;
  configId: string;
  coin: string;
  side: LeadLagSide;
  signalAt: number;
  openedAt: number | null;
  closedAt: number;
  signalLeaderBps: number;
  signalConfirmBps: number;
  signalResidualBps: number;
  entryPrice: number | null;
  exitPrice: number | null;
  entryDepthUsd: number | null;
  exitDepthUsd: number | null;
  netBps: number | null;
  netUsd: number | null;
  passed: boolean;
  reason:
    | 'completed'
    | 'stale_at_entry'
    | 'depth_at_entry'
    | 'signal_decayed'
    | 'stale_at_exit'
    | 'depth_at_exit';
};

type Connection = {
  connected: boolean;
  messages: number;
  reconnects: number;
  lastMessageAt: number;
};

const MARKETS: readonly Market[] = [
  { coin: 'BTC', symbol: 'BTCUSDT', lighterMarketId: 1 },
  { coin: 'ETH', symbol: 'ETHUSDT', lighterMarketId: 0 },
  { coin: 'SOL', symbol: 'SOLUSDT', lighterMarketId: 2 },
  { coin: 'HYPE', symbol: 'HYPEUSDT', lighterMarketId: 24 },
  { coin: 'XRP', symbol: 'XRPUSDT', lighterMarketId: 7 },
  { coin: 'DOGE', symbol: 'DOGEUSDT', lighterMarketId: 3 },
  { coin: 'ADA', symbol: 'ADAUSDT', lighterMarketId: 39 },
  { coin: 'BNB', symbol: 'BNBUSDT', lighterMarketId: 25 },
  { coin: 'LTC', symbol: 'LTCUSDT', lighterMarketId: 35 },
] as const;

function finiteEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function listEnv(name: string, fallback: readonly number[]): number[] {
  const parsed = (process.env[name] ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length ? [...new Set(parsed)] : [...fallback];
}

const DATA_DIR = resolve(
  process.env.LIGHTER_LEADLAG_DATA_DIR ?? 'data/lighter-leadlag',
);
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const RESULTS_PATH = resolve(DATA_DIR, 'results.ndjson');
const SAMPLE_MS = finiteEnv('LIGHTER_LEADLAG_SAMPLE_MS', 50);
const FRESH_MS = finiteEnv('LIGHTER_LEADLAG_FRESH_MS', 250);
const ENTRY_LATENCY_MS = finiteEnv('LIGHTER_LEADLAG_ENTRY_LATENCY_MS', 100);
const NOTIONAL_USD = finiteEnv('LIGHTER_LEADLAG_NOTIONAL_USD', 100);
const EXECUTION_BUFFER_BPS = finiteEnv(
  'LIGHTER_LEADLAG_EXECUTION_BUFFER_BPS',
  1,
);
const CONFIRM_RATIO = finiteEnv('LIGHTER_LEADLAG_CONFIRM_RATIO', 0.5);
const INDEPENDENCE_MS = finiteEnv(
  'LIGHTER_LEADLAG_INDEPENDENCE_MS',
  5_000,
);
const MAX_RESULTS = finiteEnv('LIGHTER_LEADLAG_MAX_RESULTS', 50_000);
const LOOKBACKS_MS = listEnv(
  'LIGHTER_LEADLAG_LOOKBACKS_MS',
  [100, 250, 500],
);
const HOLDS_MS = listEnv(
  'LIGHTER_LEADLAG_HOLDS_MS',
  [100, 250, 500, 1_000, 2_000],
);
const THRESHOLDS_BPS = listEnv(
  'LIGHTER_LEADLAG_THRESHOLDS_BPS',
  [2, 3, 5, 7, 10],
);
const MAX_HISTORY_MS = Math.max(...LOOKBACKS_MS) + ENTRY_LATENCY_MS + 1_000;
const CONFIGS: readonly Config[] = LOOKBACKS_MS.flatMap((lookbackMs) => (
  HOLDS_MS.flatMap((holdMs) => THRESHOLDS_BPS.map((thresholdBps) => ({
    id: `lb${lookbackMs}-h${holdMs}-t${thresholdBps}`,
    lookbackMs,
    holdMs,
    thresholdBps,
  })))
));
const configById = new Map(CONFIGS.map((config) => [config.id, config]));
const bySymbol = new Map(MARKETS.map((market) => [market.symbol, market]));
const byCoin = new Map(MARKETS.map((market) => [market.coin, market]));
const byLighterId = new Map(
  MARKETS.map((market) => [market.lighterMarketId, market]),
);
const binanceQuotes = new Map(
  MARKETS.map((market) => [market.coin, emptyQuote()]),
);
const lighterQuotes = new Map(
  MARKETS.map((market) => [market.coin, emptyQuote()]),
);
const extendedQuotes = new Map(
  MARKETS.map((market) => [market.coin, emptyQuote()]),
);
const extendedDepth = new Map(MARKETS.map((market) => [
  market.coin,
  { bids: new Map<number, number>(), asks: new Map<number, number>() },
]));
const history = new Map(
  MARKETS.map((market) => [market.coin, [] as Point[]]),
);
const probes = new Map<string, Probe>();
const lastSignalAt = new Map<string, number>();
const connections: Record<'binance' | 'lighter' | 'extended', Connection> = {
  binance: {
    connected: false,
    messages: 0,
    reconnects: 0,
    lastMessageAt: 0,
  },
  lighter: {
    connected: false,
    messages: 0,
    reconnects: 0,
    lastMessageAt: 0,
  },
  extended: {
    connected: false,
    messages: 0,
    reconnects: 0,
    lastMessageAt: 0,
  },
};
let results: Result[] = loadResults();
let startedAt = Date.now();
let sequence = 0;
let evaluations = 0;
let signals = 0;
let shuttingDown = false;

function emptyQuote(): Quote {
  return {
    bid: 0,
    ask: 0,
    bidSize: 0,
    askSize: 0,
    exchangeAt: 0,
    receivedAt: 0,
    updates: 0,
  };
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTimestamp(value: unknown, receivedAt: number): number {
  let timestamp = finite(value);
  while (timestamp > 5_000_000_000_000) timestamp /= 1_000;
  if (!(timestamp > 0) || Math.abs(receivedAt - timestamp) > 60_000) {
    return receivedAt;
  }
  return timestamp;
}

function loadResults(): Result[] {
  try {
    return readFileSync(RESULTS_PATH, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_RESULTS)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Result];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function atomicJson(path: string, data: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(data));
  renameSync(temporary, path);
}

function textData(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function connect(
  venue: 'binance' | 'lighter' | 'extended',
  url: string,
  onOpen: (socket: WebSocket) => void,
  onMessage: (payload: unknown, receivedAt: number) => void,
  options?: ClientOptions,
): void {
  if (shuttingDown) return;
  const socket = new WebSocket(url, options);
  socket.on('open', () => {
    connections[venue].connected = true;
    onOpen(socket);
    console.warn(`lighter-leadlag ${venue} connected`);
  });
  socket.on('message', (data) => {
    const receivedAt = Date.now();
    connections[venue].messages++;
    connections[venue].lastMessageAt = receivedAt;
    try {
      onMessage(JSON.parse(textData(data)), receivedAt);
    } catch (error) {
      console.warn(`lighter-leadlag ${venue} parse`, error);
    }
  });
  socket.on('error', () => {
    connections[venue].connected = false;
  });
  socket.on('close', () => {
    connections[venue].connected = false;
    connections[venue].reconnects++;
    if (!shuttingDown) {
      setTimeout(
        () => connect(venue, url, onOpen, onMessage, options),
        2_000,
      ).unref();
    }
  });
}

function lighterMarketId(channel: unknown): number | null {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/[:/](\d+)$/);
  return match ? finite(match[1]) : null;
}

function startLighter(): void {
  connect(
    'lighter',
    'wss://mainnet.zklighter.elliot.ai/stream',
    (socket) => {
      for (const market of MARKETS) {
        socket.send(JSON.stringify({
          type: 'subscribe',
          channel: `ticker/${market.lighterMarketId}`,
        }));
      }
      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('{}');
        else clearInterval(timer);
      }, 30_000);
      timer.unref();
    },
    (payload, receivedAt) => {
      const message = payload as {
        channel?: unknown;
        timestamp?: unknown;
        last_updated_at?: unknown;
        ticker?: {
          a?: { price?: unknown; size?: unknown };
          b?: { price?: unknown; size?: unknown };
          last_updated_at?: unknown;
        };
      };
      if (!message.ticker) return;
      const marketId = lighterMarketId(message.channel);
      const market = marketId == null ? null : byLighterId.get(marketId);
      const quote = market ? lighterQuotes.get(market.coin) : null;
      if (!quote) return;
      const bid = finite(message.ticker.b?.price);
      const ask = finite(message.ticker.a?.price);
      if (!(bid > 0) || !(ask > bid)) return;
      Object.assign(quote, {
        bid,
        ask,
        bidSize: finite(message.ticker.b?.size),
        askSize: finite(message.ticker.a?.size),
        exchangeAt: normalizeTimestamp(
          message.timestamp
            ?? message.last_updated_at
            ?? message.ticker.last_updated_at,
          receivedAt,
        ),
        receivedAt,
        updates: quote.updates + 1,
      });
    },
  );
}

function startBinance(): void {
  const streams = MARKETS.map(
    ({ symbol }) => `${symbol.toLowerCase()}@bookTicker`,
  );
  connect(
    'binance',
    `wss://fstream.binance.com/stream?streams=${streams.join('/')}`,
    () => {},
    (payload, receivedAt) => {
      const wrapper = payload as { data?: Record<string, unknown> };
      const data = wrapper.data;
      const market = typeof data?.s === 'string'
        ? bySymbol.get(data.s)
        : null;
      const quote = market ? binanceQuotes.get(market.coin) : null;
      if (!data || !quote) return;
      const bid = finite(data.b);
      const ask = finite(data.a);
      if (!(bid > 0) || !(ask > bid)) return;
      Object.assign(quote, {
        bid,
        ask,
        bidSize: finite(data.B),
        askSize: finite(data.A),
        exchangeAt: normalizeTimestamp(data.T ?? data.E, receivedAt),
        receivedAt,
        updates: quote.updates + 1,
      });
    },
  );
}

function updateExtendedLevels(
  target: Map<number, number>,
  rows: unknown,
  replace: boolean,
): void {
  if (replace) target.clear();
  if (!Array.isArray(rows)) return;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { p?: unknown; q?: unknown; c?: unknown };
    const price = finite(row.p);
    const size = finite(replace ? row.q ?? row.c : row.c ?? row.q);
    if (!(price > 0) || size < 0) continue;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

function startExtended(): void {
  connect(
    'extended',
    'wss://api.starknet.extended.exchange/stream.extended.exchange/v1/orderbooks',
    (socket) => {
      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
        else clearInterval(timer);
      }, 10_000);
      timer.unref();
    },
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
      const depth = market ? extendedDepth.get(market.coin) : null;
      const quote = market ? extendedQuotes.get(market.coin) : null;
      if (!depth || !quote) return;
      if (message.type === 'SNAPSHOT') {
        updateExtendedLevels(depth.bids, message.data.b, true);
        updateExtendedLevels(depth.asks, message.data.a, true);
      } else if (message.type === 'DELTA') {
        updateExtendedLevels(depth.bids, message.data.b, false);
        updateExtendedLevels(depth.asks, message.data.a, false);
      } else {
        return;
      }
      const bids = [...depth.bids.entries()]
        .filter(([price, size]) => price > 0 && size > 0)
        .sort((left, right) => right[0] - left[0]);
      const asks = [...depth.asks.entries()]
        .filter(([price, size]) => price > 0 && size > 0)
        .sort((left, right) => left[0] - right[0]);
      const bid = bids[0];
      const ask = asks[0];
      if (!bid || !ask || !(ask[0] > bid[0])) return;
      Object.assign(quote, {
        bid: bid[0],
        ask: ask[0],
        bidSize: bid[1],
        askSize: ask[1],
        exchangeAt: normalizeTimestamp(message.ts, receivedAt),
        receivedAt,
        updates: quote.updates + 1,
      });
    },
    {
      headers: { 'User-Agent': 'RobotClaude-LighterLeadLag/1.0' },
    },
  );
}

function quoteFresh(quote: Quote, now: number): boolean {
  return (
    quote.bid > 0
    && quote.ask > quote.bid
    && now - quote.receivedAt <= FRESH_MS
    && now - quote.exchangeAt <= FRESH_MS
  );
}

function pointAt(points: readonly Point[], targetAt: number): Point | null {
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point && point.at <= targetAt) return point;
  }
  return null;
}

function probeKey(configId: string, coin: string): string {
  return `${configId}:${coin}`;
}

function appendResult(result: Result): void {
  appendFileSync(RESULTS_PATH, `${JSON.stringify(result)}\n`);
  results.push(result);
  if (results.length > MAX_RESULTS) results = results.slice(-MAX_RESULTS);
}

function completeRejected(
  probe: Probe,
  now: number,
  reason: Exclude<Result['reason'], 'completed'>,
): void {
  appendResult({
    id: probe.id,
    configId: probe.configId,
    coin: probe.coin,
    side: probe.side,
    signalAt: probe.signalAt,
    openedAt: probe.openedAt,
    closedAt: now,
    signalLeaderBps: probe.signalLeaderBps,
    signalConfirmBps: probe.signalConfirmBps,
    signalResidualBps: probe.signalResidualBps,
    entryPrice: probe.entryPrice,
    exitPrice: null,
    entryDepthUsd: probe.entryDepthUsd,
    exitDepthUsd: null,
    netBps: null,
    netUsd: null,
    passed: false,
    reason,
  });
  probes.delete(probeKey(probe.configId, probe.coin));
}

function currentResidual(
  probe: Probe,
  now: number,
): { leaderBps: number; confirmBps: number; residualBps: number } | null {
  const config = configById.get(probe.configId);
  const points = history.get(probe.coin);
  const binance = binanceQuotes.get(probe.coin);
  const extended = extendedQuotes.get(probe.coin);
  const lighter = lighterQuotes.get(probe.coin);
  if (!config || !points || !binance || !extended || !lighter) return null;
  const before = pointAt(points, probe.signalAt - config.lookbackMs);
  if (!before) return null;
  const binanceMid = (binance.bid + binance.ask) / 2;
  const extendedMid = (extended.bid + extended.ask) / 2;
  const lighterMid = (lighter.bid + lighter.ask) / 2;
  const leaderBps = leadLagReturnBps(binanceMid, before.binanceMid);
  const confirmBps = leadLagReturnBps(extendedMid, before.extendedMid);
  const residualBps = leadLagResidualBps(
    binanceMid,
    before.binanceMid,
    lighterMid,
    before.lighterMid,
  );
  if (
    leaderBps == null
    || confirmBps == null
    || residualBps == null
    || now < probe.signalAt
  ) {
    return null;
  }
  return { leaderBps, confirmBps, residualBps };
}

function updateProbes(now: number): void {
  for (const probe of [...probes.values()]) {
    const config = configById.get(probe.configId);
    const lighter = lighterQuotes.get(probe.coin);
    const binance = binanceQuotes.get(probe.coin);
    const extended = extendedQuotes.get(probe.coin);
    if (!config || !lighter || !binance || !extended) {
      completeRejected(probe, now, 'stale_at_entry');
      continue;
    }
    if (probe.state === 'awaiting_entry') {
      if (now < probe.entryDueAt) continue;
      if (
        !quoteFresh(lighter, now)
        || !quoteFresh(binance, now)
        || !quoteFresh(extended, now)
      ) {
        completeRejected(probe, now, 'stale_at_entry');
        continue;
      }
      const residual = currentResidual(probe, now);
      const signedResidual = residual == null
        ? -Infinity
        : probe.side === 'long'
          ? residual.residualBps
          : -residual.residualBps;
      const signedLeader = residual == null
        ? -Infinity
        : probe.side === 'long'
          ? residual.leaderBps
          : -residual.leaderBps;
      const signedConfirm = residual == null
        ? -Infinity
        : probe.side === 'long'
          ? residual.confirmBps
          : -residual.confirmBps;
      if (
        signedResidual < config.thresholdBps / 2
        || signedLeader < config.thresholdBps / 2
        || signedConfirm < config.thresholdBps * CONFIRM_RATIO
      ) {
        completeRejected(probe, now, 'signal_decayed');
        continue;
      }
      const entryPrice = probe.side === 'long' ? lighter.ask : lighter.bid;
      const entrySize = probe.side === 'long'
        ? lighter.askSize
        : lighter.bidSize;
      const entryDepthUsd = topLevelDepthUsd(entryPrice, entrySize);
      if (entryDepthUsd < NOTIONAL_USD) {
        completeRejected(probe, now, 'depth_at_entry');
        continue;
      }
      probe.state = 'open';
      probe.openedAt = now;
      probe.exitDueAt = now + config.holdMs;
      probe.entryPrice = entryPrice;
      probe.entryDepthUsd = entryDepthUsd;
      continue;
    }
    if (probe.exitDueAt == null || now < probe.exitDueAt) continue;
    if (!quoteFresh(lighter, now)) {
      completeRejected(probe, now, 'stale_at_exit');
      continue;
    }
    const exitPrice = probe.side === 'long' ? lighter.bid : lighter.ask;
    const exitSize = probe.side === 'long' ? lighter.bidSize : lighter.askSize;
    const exitDepthUsd = topLevelDepthUsd(exitPrice, exitSize);
    if (exitDepthUsd < NOTIONAL_USD) {
      completeRejected(probe, now, 'depth_at_exit');
      continue;
    }
    const netBps = lighterRoundTripNetBps(
      probe.side,
      probe.entryPrice ?? 0,
      exitPrice,
      EXECUTION_BUFFER_BPS,
    );
    appendResult({
      id: probe.id,
      configId: probe.configId,
      coin: probe.coin,
      side: probe.side,
      signalAt: probe.signalAt,
      openedAt: probe.openedAt,
      closedAt: now,
      signalLeaderBps: probe.signalLeaderBps,
      signalConfirmBps: probe.signalConfirmBps,
      signalResidualBps: probe.signalResidualBps,
      entryPrice: probe.entryPrice,
      exitPrice,
      entryDepthUsd: probe.entryDepthUsd,
      exitDepthUsd,
      netBps,
      netUsd: netBps == null ? null : netBps / 10_000 * NOTIONAL_USD,
      passed: Number(netBps) > 0,
      reason: 'completed',
    });
    probes.delete(probeKey(probe.configId, probe.coin));
  }
}

function evaluateSignals(now: number, market: Market, point: Point): void {
  const points = history.get(market.coin);
  if (!points) return;
  for (const config of CONFIGS) {
    const before = pointAt(points, now - config.lookbackMs);
    if (!before) continue;
    const leaderBps = leadLagReturnBps(point.binanceMid, before.binanceMid);
    const confirmBps = leadLagReturnBps(
      point.extendedMid,
      before.extendedMid,
    );
    const residualBps = leadLagResidualBps(
      point.binanceMid,
      before.binanceMid,
      point.lighterMid,
      before.lighterMid,
    );
    if (leaderBps == null || confirmBps == null || residualBps == null) {
      continue;
    }
    let side: LeadLagSide | null = null;
    if (
      leaderBps >= config.thresholdBps
      && residualBps >= config.thresholdBps
      && confirmBps >= config.thresholdBps * CONFIRM_RATIO
    ) {
      side = 'long';
    } else if (
      leaderBps <= -config.thresholdBps
      && residualBps <= -config.thresholdBps
      && confirmBps <= -config.thresholdBps * CONFIRM_RATIO
    ) {
      side = 'short';
    }
    if (!side) continue;
    const key = probeKey(config.id, market.coin);
    if (probes.has(key)) continue;
    if (now - (lastSignalAt.get(key) ?? 0) < INDEPENDENCE_MS) continue;
    const id = `LL${now}-${market.coin}-${config.id}-${sequence++}`;
    probes.set(key, {
      id,
      configId: config.id,
      coin: market.coin,
      side,
      state: 'awaiting_entry',
      signalAt: now,
      signalLeaderBps: leaderBps,
      signalConfirmBps: confirmBps,
      signalResidualBps: residualBps,
      entryDueAt: now + ENTRY_LATENCY_MS,
      openedAt: null,
      exitDueAt: null,
      entryPrice: null,
      entryDepthUsd: null,
    });
    lastSignalAt.set(key, now);
    signals++;
  }
}

function sample(): void {
  const now = Date.now();
  updateProbes(now);
  for (const market of MARKETS) {
    const binance = binanceQuotes.get(market.coin)!;
    const extended = extendedQuotes.get(market.coin)!;
    const lighter = lighterQuotes.get(market.coin)!;
    if (
      !quoteFresh(binance, now)
      || !quoteFresh(extended, now)
      || !quoteFresh(lighter, now)
    ) {
      continue;
    }
    const point: Point = {
      at: now,
      binanceMid: (binance.bid + binance.ask) / 2,
      extendedMid: (extended.bid + extended.ask) / 2,
      lighterMid: (lighter.bid + lighter.ask) / 2,
    };
    const points = history.get(market.coin)!;
    points.push(point);
    while (points[0] && points[0].at < now - MAX_HISTORY_MS) points.shift();
    evaluateSignals(now, market, point);
    evaluations++;
  }
}

function statusRows(): Array<Record<string, unknown>> {
  return CONFIGS.map((config) => {
    const completed = results.filter(
      (row) => row.configId === config.id && row.reason === 'completed',
    );
    const summary = summarizeLeadLag(completed.map((row) => ({
      netBps: Number(row.netBps),
      passed: row.passed,
    })));
    const attempted = results.filter((row) => row.configId === config.id);
    return {
      ...config,
      attempts: attempted.length,
      rejected: attempted.length - completed.length,
      ...summary,
      researchGate: (
        summary.samples >= 50
        && Number(summary.averageNetBps) >= 1
        && Number(summary.profitFactor) >= 1.2
        && summary.netBps > 0
      ),
    };
  }).sort((left, right) => {
    if (left.researchGate !== right.researchGate) {
      return left.researchGate ? -1 : 1;
    }
    const averageDelta = Number(right.averageNetBps ?? -Infinity)
      - Number(left.averageNetBps ?? -Infinity);
    if (averageDelta) return averageDelta;
    return Number(right.samples) - Number(left.samples);
  });
}

function writeStatus(): void {
  const now = Date.now();
  const ranked = statusRows();
  atomicJson(STATUS_PATH, {
    version: 'lighter-leadlag-shadow-v2',
    readOnly: true,
    researchOnly: true,
    startedAt,
    updatedAt: now,
    config: {
      sampleMs: SAMPLE_MS,
      freshMs: FRESH_MS,
      entryLatencyMs: ENTRY_LATENCY_MS,
      notionalUsd: NOTIONAL_USD,
      executionBufferBps: EXECUTION_BUFFER_BPS,
      confirmRatio: CONFIRM_RATIO,
      independenceMs: INDEPENDENCE_MS,
      lookbacksMs: LOOKBACKS_MS,
      holdsMs: HOLDS_MS,
      thresholdsBps: THRESHOLDS_BPS,
      requiredResearchSamples: 50,
    },
    connections,
    evaluations,
    signals,
    active: [...probes.values()],
    results: results.length,
    ranked: ranked.filter((row) => Number(row.attempts) > 0).slice(0, 50),
    pending: ranked.filter((row) => Number(row.attempts) === 0),
    freshnessMs: Object.fromEntries(MARKETS.map((market) => [
      market.coin,
      {
        binance: binanceQuotes.get(market.coin)?.receivedAt
          ? now - binanceQuotes.get(market.coin)!.receivedAt
          : null,
        lighter: lighterQuotes.get(market.coin)?.receivedAt
          ? now - lighterQuotes.get(market.coin)!.receivedAt
          : null,
        extended: extendedQuotes.get(market.coin)?.receivedAt
          ? now - extendedQuotes.get(market.coin)!.receivedAt
          : null,
      },
    ])),
    recent: results.slice(-50).reverse(),
  });
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sampleTimer);
  clearInterval(statusTimer);
  writeStatus();
  console.warn(`lighter-leadlag shutdown ${signal}`);
  setTimeout(() => process.exit(0), 100).unref();
}

mkdirSync(DATA_DIR, { recursive: true });
startedAt = Date.now();
startLighter();
startBinance();
startExtended();
const sampleTimer = setInterval(sample, SAMPLE_MS);
const statusTimer = setInterval(writeStatus, 2_000);
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.warn(
  `lighter-leadlag shadow started: ${MARKETS.map((market) => market.coin).join(',')} `
  + `· ${CONFIGS.length} configs · ${SAMPLE_MS}ms`,
);

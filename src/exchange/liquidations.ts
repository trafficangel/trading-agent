import WebSocket from 'ws';
import { logger } from '../lib/logger.js';

/**
 * Live aggregator of forced liquidations on Bybit USDT-perp.
 *
 * Why this matters: a cascade of liquidations is one of the most predictive
 * short-term signals in crypto. When $5M+ of longs get force-closed in 5
 * minutes, the residual order flow is mostly mechanical (forced sells), not
 * informed — price typically reverts soon after the cascade exhausts.
 * Mirror for shorts. Conversely, sustained one-sided liquidations confirm
 * a trending move.
 *
 * Implementation:
 *   - Persistent WebSocket to wss://stream.bybit.com/v5/public/linear
 *   - On open, subscribes to allLiquidation.<symbol> for a fixed list of
 *     top-volume symbols (any pair we'd realistically trade).
 *   - Per-symbol rolling 5-minute bucket of events >= MIN_EVENT_USD.
 *   - On every decide / monitor call, getLiquidations(symbol) sums the
 *     bucket and returns a snapshot with USD totals + the largest single
 *     event.
 *
 * Why Bybit, not Binance:
 *   We tested both. Bybit's WS reliably delivers liquidation frames; Binance
 *   futures WebSocket (fstream) had silent-stall issues from our environment
 *   at deploy time. Since Bybit is also our PRIMARY trading venue, Bybit
 *   liquidations are the most directly relevant to our trade thesis anyway
 *   (we exit on Bybit; Bybit cascade = Bybit price action). When Binance
 *   fstream is healthy again we can layer it in as a confirming source.
 *
 * Reconnection: on close/error we reschedule with exponential backoff
 * capped at 60s. The rolling window naturally drains when no new events
 * arrive.
 */

const STREAM_URL = 'wss://stream.bybit.com/v5/public/linear';
const WINDOW_MS = 5 * 60 * 1000;
const MIN_EVENT_USD = 1_000; // ignore noise

// Top USDT-perp symbols by 24h volume. Subscribe upfront so any inbound
// signal symbol is already covered. Add new ones as we expand coverage.
const SUBSCRIBED_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'TONUSDT',
  'BNBUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'ADAUSDT',
  'PEPEUSDT',
  'TRXUSDT',
  'SUIUSDT',
  'NEARUSDT',
  'LTCUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'ARBUSDT',
  'OPUSDT',
  'WLDUSDT',
];

type LiquidationEvent = {
  ts: number;
  side: 'long_liquidated' | 'short_liquidated';
  usd: number;
  price: number;
};

const buckets = new Map<string, LiquidationEvent[]>();

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelayMs = 1_000;
let lastMessageAt = 0;
let started = false;

function pruneBucket(symbol: string, now: number): LiquidationEvent[] {
  const arr = buckets.get(symbol);
  if (!arr) return [];
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i]!.ts < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  return arr;
}

type BybitLiqMsg = {
  topic?: string;
  type?: string;
  ts?: number;
  data?: { T: number; s: string; S: 'Buy' | 'Sell'; v: string; p: string }[];
  op?: string;
  success?: boolean;
};

function handleMessage(raw: WebSocket.RawData): void {
  lastMessageAt = Date.now();
  let msg: BybitLiqMsg;
  try {
    msg = JSON.parse(raw.toString()) as BybitLiqMsg;
  } catch {
    return;
  }
  // Ignore subscribe acks, pong responses, etc.
  if (!msg.topic || !msg.topic.startsWith('allLiquidation.') || !msg.data) return;

  for (const ev of msg.data) {
    const qty = Number(ev.v);
    const price = Number(ev.p);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) continue;

    const usd = qty * price;
    if (usd < MIN_EVENT_USD) continue;

    // Bybit side semantics for liquidations:
    //   S = "Buy"  → forced buy  = SHORT was liquidated (closing short = buy)
    //   S = "Sell" → forced sell = LONG  was liquidated (closing long = sell)
    const side: 'long_liquidated' | 'short_liquidated' =
      ev.S === 'Sell' ? 'long_liquidated' : 'short_liquidated';

    const evt: LiquidationEvent = { ts: ev.T || Date.now(), side, usd, price };
    const arr = buckets.get(ev.s) ?? [];
    arr.push(evt);
    buckets.set(ev.s, arr);
  }
}

function subscribe(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Bybit allows up to ~20 args per subscribe message; we have 20 so one shot.
  const args = SUBSCRIBED_SYMBOLS.map((s) => `allLiquidation.${s}`);
  ws.send(JSON.stringify({ op: 'subscribe', args }));

  // Ping every 20s to keep alive (Bybit closes idle connections at 30s)
  const pingInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearInterval(pingInterval);
      return;
    }
    ws.send(JSON.stringify({ op: 'ping' }));
  }, 20_000);
  ws.once('close', () => clearInterval(pingInterval));
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
}

function connect(): void {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      // ignore
    }
  }
  logger.info({ url: STREAM_URL, symbols: SUBSCRIBED_SYMBOLS.length }, 'liquidations: connecting');
  ws = new WebSocket(STREAM_URL, { handshakeTimeout: 15_000 });

  ws.on('open', () => {
    logger.info('liquidations: WS connected, subscribing');
    reconnectDelayMs = 1_000;
    subscribe();
  });

  ws.on('message', handleMessage);

  ws.on('close', (code, reason) => {
    logger.warn({ code, reason: reason.toString() }, 'liquidations: WS closed, reconnecting');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    logger.error({ err: err.message }, 'liquidations: WS error');
  });
}

/** Start the listener. Idempotent. */
export function startLiquidationsListener(): void {
  if (started) return;
  started = true;
  connect();

  setInterval(() => {
    if (lastMessageAt > 0 && Date.now() - lastMessageAt > 120_000) {
      logger.warn(
        { silence_ms: Date.now() - lastMessageAt },
        'liquidations: stale, forcing reconnect',
      );
      lastMessageAt = 0;
      scheduleReconnect();
    }
  }, 30_000).unref();

  // Periodic global prune: getLiquidations(symbol) only prunes the queried
  // symbol's bucket. Symbols we subscribe to but never query (because they
  // don't match config.SYMBOLS) would accumulate forever otherwise. With
  // 20 subscribed symbols × bursty cascades that could be hundreds of KB
  // of dead events stuck in memory over days/weeks.
  setInterval(() => {
    const now = Date.now();
    let totalKept = 0;
    for (const sym of buckets.keys()) {
      const remaining = pruneBucket(sym, now);
      totalKept += remaining.length;
    }
    logger.debug(
      { symbols: buckets.size, events_in_memory: totalKept },
      'liquidations: global prune done',
    );
  }, 60_000).unref();
}

export type LiquidationsSnapshot = {
  symbol: string;
  longLiqUsd5m: number;
  shortLiqUsd5m: number;
  largestEventUsd: number;
  eventCount: number;
  cascade: 'long' | 'short' | null;
  fetchedAt: number;
};

const CASCADE_USD_THRESHOLD = 5_000_000;
const CASCADE_RATIO = 5;

export function getLiquidations(symbol: string): LiquidationsSnapshot {
  const now = Date.now();
  const arr = pruneBucket(symbol, now);

  let longLiqUsd5m = 0;
  let shortLiqUsd5m = 0;
  let largestEventUsd = 0;
  for (const e of arr) {
    if (e.side === 'long_liquidated') longLiqUsd5m += e.usd;
    else shortLiqUsd5m += e.usd;
    if (e.usd > largestEventUsd) largestEventUsd = e.usd;
  }

  let cascade: 'long' | 'short' | null = null;
  if (longLiqUsd5m >= CASCADE_USD_THRESHOLD && longLiqUsd5m >= shortLiqUsd5m * CASCADE_RATIO) {
    cascade = 'long';
  } else if (
    shortLiqUsd5m >= CASCADE_USD_THRESHOLD &&
    shortLiqUsd5m >= longLiqUsd5m * CASCADE_RATIO
  ) {
    cascade = 'short';
  }

  return {
    symbol,
    longLiqUsd5m: Math.round(longLiqUsd5m),
    shortLiqUsd5m: Math.round(shortLiqUsd5m),
    largestEventUsd: Math.round(largestEventUsd),
    eventCount: arr.length,
    cascade,
    fetchedAt: now,
  };
}

export function formatLiquidations(snap: LiquidationsSnapshot | null): string {
  if (!snap) return '  (liquidations stream unavailable)';
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1e3).toFixed(0)}k` : `$${n}`;

  const lines = [
    `  Long liquidated:  ${fmt(snap.longLiqUsd5m)}  (forced sells — bullish exhaustion if cascade)`,
    `  Short liquidated: ${fmt(snap.shortLiqUsd5m)} (forced buys — bearish exhaustion if cascade)`,
    `  Largest single:   ${fmt(snap.largestEventUsd)}    Events: ${snap.eventCount}`,
  ];
  if (snap.cascade) {
    const direction = snap.cascade === 'long' ? 'LONG-side' : 'SHORT-side';
    const reversion = snap.cascade === 'long' ? 'bullish' : 'bearish';
    lines.push(
      `  ⚠️ ${direction} CASCADE detected — high probability of ${reversion} mean reversion`,
    );
  }
  return lines.join('\n');
}

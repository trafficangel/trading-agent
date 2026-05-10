import WebSocket from 'ws';
import { logger } from '../lib/logger.js';

/**
 * Live aggregator of forced liquidations on Binance USDS-M perpetuals.
 *
 * Why this matters: a cascade of liquidations is one of the most predictive
 * short-term signals in crypto. When $5M+ of longs get force-closed in 5
 * minutes, the residual order flow is mostly mechanical (forced sells), not
 * informed — price typically reverts soon after the cascade exhausts.
 * Mirror for shorts. Conversely, sustained one-sided liquidations confirm
 * a trending move.
 *
 * Implementation:
 *   - One persistent WebSocket to wss://fstream.binance.com/ws/!forceOrder@arr
 *     receives EVERY forceOrder event for ALL Binance perpetual symbols.
 *   - We keep a rolling 5-minute bucket per symbol containing
 *     { ts, side: 'long_liquidated'|'short_liquidated', usd, price }.
 *   - On every decide / monitor call, getLiquidations(symbol) sums the
 *     bucket and returns a snapshot with USD totals + the largest single
 *     event (so the model sees "biggest liquidation in window: $1.2M").
 *
 * Bybit and OKX don't broadcast all-symbol forceOrder streams as easily.
 * Binance is the largest perp market by volume so its liquidation tape
 * is a strong proxy for the whole market — when Binance cascades, Bybit
 * + OKX cascade in sympathy.
 *
 * Reconnection: on close/error we reschedule with exponential backoff
 * capped at 60s. Stale data is fine (just stale, not wrong) — the rolling
 * window naturally drains when no new events arrive.
 */

const STREAM_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const WINDOW_MS = 5 * 60 * 1000;
const MIN_EVENT_USD = 1_000; // ignore noise

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
  // events arrive newest, oldest is at index 0; drop expired
  let i = 0;
  while (i < arr.length && arr[i]!.ts < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  return arr;
}

function handleMessage(raw: WebSocket.RawData): void {
  lastMessageAt = Date.now();
  let msg: { e?: string; o?: { s: string; S: string; q: string; p: string; ap: string; T: number } };
  try {
    msg = JSON.parse(raw.toString()) as typeof msg;
  } catch {
    return;
  }
  if (msg.e !== 'forceOrder' || !msg.o) return;

  const o = msg.o;
  const qty = Number(o.q);
  const price = Number(o.ap || o.p);
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) return;

  const usd = qty * price;
  if (usd < MIN_EVENT_USD) return;

  // Binance forceOrder side semantics:
  //   o.S = "SELL" → forced sell = LONG position got liquidated
  //   o.S = "BUY"  → forced buy  = SHORT position got liquidated
  const side: 'long_liquidated' | 'short_liquidated' =
    o.S === 'SELL' ? 'long_liquidated' : 'short_liquidated';

  const evt: LiquidationEvent = { ts: o.T || Date.now(), side, usd, price };
  const arr = buckets.get(o.s) ?? [];
  arr.push(evt);
  buckets.set(o.s, arr);
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
  logger.info({ url: STREAM_URL }, 'liquidations: connecting');
  ws = new WebSocket(STREAM_URL, { handshakeTimeout: 15_000 });

  ws.on('open', () => {
    logger.info('liquidations: WS connected');
    reconnectDelayMs = 1_000; // reset backoff on success
  });

  ws.on('message', handleMessage);

  ws.on('close', (code, reason) => {
    logger.warn({ code, reason: reason.toString() }, 'liquidations: WS closed, reconnecting');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    logger.error({ err: err.message }, 'liquidations: WS error');
    // 'close' will follow; reconnection scheduled there.
  });
}

/** Start the listener. Idempotent — multiple calls are no-ops. */
export function startLiquidationsListener(): void {
  if (started) return;
  started = true;
  connect();

  // Liveness probe: if no messages for 2 minutes, force reconnect (Binance
  // closes idle connections; we can also have a half-open TCP).
  setInterval(() => {
    if (lastMessageAt > 0 && Date.now() - lastMessageAt > 120_000) {
      logger.warn({ silence_ms: Date.now() - lastMessageAt }, 'liquidations: stale, forcing reconnect');
      lastMessageAt = 0;
      scheduleReconnect();
    }
  }, 30_000).unref();
}

export type LiquidationsSnapshot = {
  symbol: string;
  /** total USD of LONG positions force-closed in last 5 min */
  longLiqUsd5m: number;
  /** total USD of SHORT positions force-closed in last 5 min */
  shortLiqUsd5m: number;
  /** USD value of the single largest liquidation in the window (any side) */
  largestEventUsd: number;
  /** how many discrete liquidation events in the window */
  eventCount: number;
  /** is there a one-sided cascade? heuristic: $5M+ on one side AND >= 5x the other side */
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

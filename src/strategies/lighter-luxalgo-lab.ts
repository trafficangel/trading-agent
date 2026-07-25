import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  estimatedFundingPnlPct,
  pricePnlPct,
  quoteNotionalVwap,
  type PriceLevel,
} from '../lib/lighter-luxalgo-math.js';
import {
  deriveActionSide,
  type LuxAlgoStrategyPayload,
} from '../webhooks/luxalgo.schema.js';
import { getLang, pageShell } from './landing.js';

type Lang = 'ru' | 'en';
type Side = 'long' | 'short';

const t = (lang: Lang, ru: string, en: string): string => lang === 'en' ? en : ru;
const STRATEGY_ID = 'sol-lg-mf50';
const MARKET_ID = 2;
const NOTIONAL_USD = 1_000;
const STANDARD_DELAY_MS = 300;
const MAX_BOOK_AGE_MS = 1_000;
const VALIDATION_TARGET = 20;
const LIGHTER_WS = 'wss://mainnet.zklighter.elliot.ai/stream';

type FeedState = {
  connected: boolean;
  connectedAt: number | null;
  lastBookAt: number | null;
  exchangeAt: number | null;
  reconnects: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  fundingRatePctH: number;
  indexPrice: number | null;
  markPrice: number | null;
};

type ExecutionSnapshot = {
  capturedAt: number;
  exchangeAt: number;
  bookAgeMs: number;
  bid: number;
  ask: number;
  buyVwap: number;
  sellVwap: number;
  spreadPct: number;
  buySlippagePct: number;
  sellSlippagePct: number;
  fundingRatePctH: number;
  indexPrice: number | null;
  markPrice: number | null;
};

type SignalRow = {
  id: number;
  received_at: number;
  captured_at: number | null;
  side: Side;
  capture_status: string;
  capture_error: string | null;
  bid: number | null;
  ask: number | null;
  buy_vwap_1000: number | null;
  sell_vwap_1000: number | null;
  spread_pct: number | null;
  buy_slippage_pct: number | null;
  sell_slippage_pct: number | null;
  funding_rate_pct_h: number | null;
};

type TradeRow = {
  id: number;
  side: Side;
  opened_at: number;
  closed_at: number | null;
  entry_price: number;
  exit_price: number | null;
  gross_pnl_pct: number | null;
  funding_pnl_pct: number | null;
  net_pnl_pct: number | null;
};

const feed: FeedState = {
  connected: false,
  connectedAt: null,
  lastBookAt: null,
  exchangeAt: null,
  reconnects: 0,
  bids: new Map(),
  asks: new Map(),
  fundingRatePctH: 0,
  indexPrice: null,
  markPrice: null,
};

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

const insertSignal = db.prepare(`
  INSERT OR IGNORE INTO lighter_lux_signals
    (dedup_key, strategy_id, symbol, side, strategy_event, bar_time,
     received_at, capture_due_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const markCaptureError = db.prepare(`
  UPDATE lighter_lux_signals
  SET captured_at = ?, capture_status = 'error', capture_error = ?
  WHERE id = ?`);
const markCaptured = db.prepare(`
  UPDATE lighter_lux_signals
  SET captured_at = ?, capture_status = 'captured', capture_error = NULL,
      book_exchange_at = ?, book_age_ms = ?, bid = ?, ask = ?,
      buy_vwap_1000 = ?, sell_vwap_1000 = ?, spread_pct = ?,
      buy_slippage_pct = ?, sell_slippage_pct = ?, funding_rate_pct_h = ?,
      index_price = ?, mark_price = ?
  WHERE id = ?`);
const findOpenTrade = db.prepare<[string], TradeRow>(`
  SELECT id, side, opened_at, closed_at, entry_price, exit_price,
         gross_pnl_pct, funding_pnl_pct, net_pnl_pct
  FROM lighter_lux_trades
  WHERE strategy_id = ? AND closed_at IS NULL
  LIMIT 1`);
const insertTrade = db.prepare(`
  INSERT INTO lighter_lux_trades
    (strategy_id, symbol, side, entry_signal_id, opened_at, entry_price,
     entry_funding_pct_h, notional_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const closeTrade = db.prepare(`
  UPDATE lighter_lux_trades
  SET exit_signal_id = ?, closed_at = ?, exit_price = ?,
      exit_funding_pct_h = ?, gross_pnl_pct = ?, funding_pnl_pct = ?,
      net_pnl_pct = ?, close_reason = 'reverse_signal'
  WHERE id = ? AND closed_at IS NULL`);
const entryFunding = db.prepare<[number], { entry_funding_pct_h: number }>(`
  SELECT entry_funding_pct_h FROM lighter_lux_trades WHERE id = ?`);

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function updateLevels(
  target: Map<number, number>,
  rows: unknown,
): void {
  if (!Array.isArray(rows)) return;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { price?: unknown; size?: unknown };
    const price = finite(row.price);
    const size = finite(row.size);
    if (price == null || size == null) continue;
    if (size > 0) target.set(price, size);
    else target.delete(price);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2_000);
  reconnectTimer.unref();
}

function connect(): void {
  try {
    ws = new WebSocket(LIGHTER_WS);
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'lighter-lux: WS construct');
    scheduleReconnect();
    return;
  }
  ws.on('open', () => {
    feed.connected = true;
    feed.connectedAt = Date.now();
    feed.bids.clear();
    feed.asks.clear();
    ws?.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${MARKET_ID}` }));
    ws?.send(JSON.stringify({ type: 'subscribe', channel: `market_stats/${MARKET_ID}` }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try { ws?.ping(); } catch { /* reconnect handler owns recovery */ }
    }, 20_000);
    pingTimer.unref();
    logger.info({ marketId: MARKET_ID }, 'lighter-lux: read-only feed connected');
  });
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(rawText(data)) as {
        timestamp?: unknown;
        order_book?: { bids?: unknown; asks?: unknown };
        market_stats?: Record<string, unknown>;
      };
      if (message.market_stats) {
        feed.fundingRatePctH = finite(message.market_stats.current_funding_rate) ?? 0;
        feed.indexPrice = finite(message.market_stats.index_price);
        feed.markPrice = finite(message.market_stats.mark_price);
      }
      if (!message.order_book) return;
      updateLevels(feed.bids, message.order_book.bids);
      updateLevels(feed.asks, message.order_book.asks);
      if (!feed.bids.size || !feed.asks.size) return;
      feed.lastBookAt = Date.now();
      feed.exchangeAt = finite(message.timestamp) ?? feed.lastBookAt;
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'lighter-lux: bad message');
    }
  });
  ws.on('close', () => {
    feed.connected = false;
    feed.reconnects += 1;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    scheduleReconnect();
  });
  ws.on('error', (error) => {
    logger.warn({ error: error.message }, 'lighter-lux: WS error');
  });
}

export function startLighterLuxalgoShadowFeed(): void {
  if (started) return;
  started = true;
  db.prepare(`
    UPDATE lighter_lux_signals
    SET capture_status = 'error', capture_error = 'restart_before_capture',
        captured_at = ?
    WHERE capture_status = 'pending' AND capture_due_at < ?`)
    .run(Date.now(), Date.now());
  connect();
}

function executionSnapshot(): ExecutionSnapshot | { error: string } {
  const now = Date.now();
  if (!feed.connected || feed.lastBookAt == null || feed.exchangeAt == null)
    return { error: 'lighter_feed_offline' };
  const bookAgeMs = now - feed.lastBookAt;
  if (bookAgeMs > MAX_BOOK_AGE_MS) return { error: `stale_book_${bookAgeMs}ms` };

  const bids = [...feed.bids.entries()].sort((a, b) => b[0] - a[0]) as PriceLevel[];
  const asks = [...feed.asks.entries()].sort((a, b) => a[0] - b[0]) as PriceLevel[];
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (!bestBid || !bestAsk) return { error: 'empty_book' };
  const bid = bestBid[0];
  const ask = bestAsk[0];
  if (!(bid > 0) || !(ask > bid)) return { error: 'invalid_bbo' };
  const buyVwap = quoteNotionalVwap(asks, NOTIONAL_USD);
  const sellVwap = quoteNotionalVwap(bids, NOTIONAL_USD);
  if (buyVwap == null || sellVwap == null) return { error: 'depth_below_1000' };
  const mid = (bid + ask) / 2;
  return {
    capturedAt: now,
    exchangeAt: feed.exchangeAt,
    bookAgeMs,
    bid,
    ask,
    buyVwap,
    sellVwap,
    spreadPct: ((ask - bid) / mid) * 100,
    buySlippagePct: ((buyVwap - ask) / ask) * 100,
    sellSlippagePct: ((bid - sellVwap) / bid) * 100,
    fundingRatePctH: feed.fundingRatePctH,
    indexPrice: feed.indexPrice,
    markPrice: feed.markPrice,
  };
}

const applyCapturedSignal = db.transaction((
  signalId: number,
  side: Side,
  snap: ExecutionSnapshot,
) => {
  markCaptured.run(
    snap.capturedAt, snap.exchangeAt, snap.bookAgeMs, snap.bid, snap.ask,
    snap.buyVwap, snap.sellVwap, snap.spreadPct, snap.buySlippagePct,
    snap.sellSlippagePct, snap.fundingRatePctH, snap.indexPrice,
    snap.markPrice, signalId,
  );

  const open = findOpenTrade.get(STRATEGY_ID);
  if (open?.side === side) return;
  if (open) {
    const exitPrice = open.side === 'long' ? snap.sellVwap : snap.buyVwap;
    const gross = pricePnlPct(open.side, open.entry_price, exitPrice);
    const entryRate = entryFunding.get(open.id)?.entry_funding_pct_h ?? 0;
    const funding = estimatedFundingPnlPct(
      open.side,
      entryRate,
      snap.fundingRatePctH,
      snap.capturedAt - open.opened_at,
    );
    closeTrade.run(
      signalId, snap.capturedAt, exitPrice, snap.fundingRatePctH,
      gross, funding, gross + funding, open.id,
    );
  }

  const entryPrice = side === 'long' ? snap.buyVwap : snap.sellVwap;
  insertTrade.run(
    STRATEGY_ID, 'SOL', side, signalId, snap.capturedAt, entryPrice,
    snap.fundingRatePctH, NOTIONAL_USD,
  );
});

function capture(signalId: number, side: Side): void {
  try {
    const snap = executionSnapshot();
    if ('error' in snap) {
      markCaptureError.run(Date.now(), snap.error, signalId);
      return;
    }
    applyCapturedSignal(signalId, side, snap);
  } catch (error) {
    markCaptureError.run(Date.now(), `capture_exception:${(error as Error).message}`, signalId);
    logger.error({ error, signalId }, 'lighter-lux: capture failed');
  }
}

/** Called after authentication/parsing. It never delays or changes Track C. */
export function queueLighterLuxalgoSignal(payload: LuxAlgoStrategyPayload): void {
  if (payload.strategy_id !== STRATEGY_ID) return;
  const derived = deriveActionSide(payload);
  if (derived.action !== 'entry' || !derived.side) return;
  const side = derived.side;
  const receivedAt = Date.now();
  const dueAt = receivedAt + STANDARD_DELAY_MS;
  const key = createHash('sha256')
    .update(`${payload.strategy_id}|${payload.symbol}|${side}|${payload.bar_time}`)
    .digest('hex');
  const result = insertSignal.run(
    key, payload.strategy_id, payload.symbol, side,
    String(payload.strategy_event ?? side), payload.bar_time,
    receivedAt, dueAt,
  );
  if (result.changes !== 1) return;
  const signalId = Number(result.lastInsertRowid);
  const timer = setTimeout(() => capture(signalId, side), Math.max(0, dueAt - Date.now()));
  timer.unref();
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]!));
}
function signedPct(value: number, digits = 3): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`;
}
function signedUsd(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
}
function pnlClass(value: number): string {
  return value > 0 ? 'pos' : value < 0 ? 'neg' : '';
}
function utc(value: number | null): string {
  return value ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') : '—';
}
function held(opened: number, closed: number | null): string {
  const ms = (closed ?? Date.now()) - opened;
  const hours = ms / 3_600_000;
  return hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}

function recentSignals(limit = 20): SignalRow[] {
  return db.prepare<[string, number], SignalRow>(`
    SELECT id, received_at, captured_at, side, capture_status, capture_error,
           bid, ask, buy_vwap_1000, sell_vwap_1000, spread_pct,
           buy_slippage_pct, sell_slippage_pct, funding_rate_pct_h
    FROM lighter_lux_signals
    WHERE strategy_id = ?
    ORDER BY received_at DESC
    LIMIT ?`).all(STRATEGY_ID, limit);
}
function recentTrades(limit = 30): TradeRow[] {
  return db.prepare<[string, number], TradeRow>(`
    SELECT id, side, opened_at, closed_at, entry_price, exit_price,
           gross_pnl_pct, funding_pnl_pct, net_pnl_pct
    FROM lighter_lux_trades
    WHERE strategy_id = ?
    ORDER BY opened_at DESC
    LIMIT ?`).all(STRATEGY_ID, limit);
}

type Summary = {
  feedLive: boolean;
  signals: number;
  captureErrors: number;
  closed: number;
  open: number;
  netPct: number;
  netUsd: number;
  wins: number;
  profitFactor: number | null;
  firstHalfPct: number;
  secondHalfPct: number;
  currentSpreadPct: number | null;
  currentRoundTripCostPct: number | null;
};

function summary(): Summary {
  const signalCounts = db.prepare<[string], {
    total: number; errors: number;
  }>(`SELECT COUNT(*) total,
      SUM(CASE WHEN capture_status = 'error' THEN 1 ELSE 0 END) errors
    FROM lighter_lux_signals WHERE strategy_id = ?`).get(STRATEGY_ID);
  const trades = db.prepare<[string], {
    net_pnl_pct: number; closed_at: number;
  }>(`SELECT net_pnl_pct, closed_at FROM lighter_lux_trades
    WHERE strategy_id = ? AND closed_at IS NOT NULL ORDER BY closed_at`).all(STRATEGY_ID);
  const open = db.prepare<[string], { count: number }>(`
    SELECT COUNT(*) count FROM lighter_lux_trades
    WHERE strategy_id = ? AND closed_at IS NULL`).get(STRATEGY_ID)?.count ?? 0;
  const netPct = trades.reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const positive = trades.filter((row) => row.net_pnl_pct > 0);
  const negative = trades.filter((row) => row.net_pnl_pct < 0);
  const grossWin = positive.reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const grossLoss = Math.abs(negative.reduce((sum, row) => sum + row.net_pnl_pct, 0));
  const split = Math.floor(trades.length / 2);
  const firstHalfPct = trades.slice(0, split).reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const secondHalfPct = trades.slice(split).reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const snap = executionSnapshot();
  const currentSpreadPct = 'error' in snap ? null : snap.spreadPct;
  const currentRoundTripCostPct = 'error' in snap ? null
    : snap.spreadPct + snap.buySlippagePct + snap.sellSlippagePct;
  return {
    feedLive: feed.connected && feed.lastBookAt != null && Date.now() - feed.lastBookAt < 2_000,
    signals: signalCounts?.total ?? 0,
    captureErrors: signalCounts?.errors ?? 0,
    closed: trades.length,
    open,
    netPct,
    netUsd: netPct / 100 * NOTIONAL_USD,
    wins: positive.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : trades.length ? Infinity : null,
    firstHalfPct,
    secondHalfPct,
    currentSpreadPct,
    currentRoundTripCostPct,
  };
}

function gate(s: Summary, lang: Lang): { cls: string; label: string } {
  if (s.closed < VALIDATION_TARGET) return {
    cls: 'collect',
    label: t(lang, `КОПИМ ${s.closed}/${VALIDATION_TARGET}`, `COLLECTING ${s.closed}/${VALIDATION_TARGET}`),
  };
  const passed = s.netPct > 0
    && (s.profitFactor ?? 0) >= 1.2
    && s.firstHalfPct > 0
    && s.secondHalfPct > 0;
  return passed
    ? { cls: 'pass', label: t(lang, 'ПРОШЛА ГЕЙТ', 'GATE PASSED') }
    : { cls: 'fail', label: t(lang, 'НЕ ПРОШЛА ГЕЙТ', 'GATE FAILED') };
}

export const LIGHTER_LUXALGO_CSS = `
.ll-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:0 0 14px;padding:17px 20px;border:1px solid rgba(163,106,255,.36);border-radius:14px;background:linear-gradient(135deg,rgba(122,71,255,.15),var(--bg-card));color:var(--text);text-decoration:none}.ll-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(163,106,255,.15);color:#bd91ff;font-size:11px;font-weight:750;letter-spacing:.04em}.ll-title{font-size:19px;font-weight:700;margin-top:8px}.ll-sub{font-size:13px;color:var(--text-dim);margin-top:3px}.ll-stats{display:flex;gap:22px}.ll-stats span{display:grid;text-align:right}.ll-stats b{font-size:18px}.ll-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}.ll-stats .pos,.ll-card .pos,.pos{color:#38d996}.ll-stats .neg,.ll-card .neg,.neg{color:#ff6577}.ll-wrap{max-width:1120px;margin:0 auto}.ll-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}.ll-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.ll-head h1{font-size:34px;margin:10px 0 7px}.ll-head p{max-width:760px;color:var(--text-dim)}.ll-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.ll-engine i{width:8px;height:8px;border-radius:50%;background:#ff6577}.ll-engine.live i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}.ll-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.ll-card,.ll-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.ll-card{padding:16px;display:grid;gap:5px}.ll-card small,.ll-card em{color:var(--text-faint);font-size:11px;font-style:normal}.ll-card b{font-size:23px;font-variant-numeric:tabular-nums}.ll-panel{padding:18px;margin:12px 0}.ll-panel h2{font-size:17px;margin:0 0 14px}.ll-progress{height:8px;border-radius:9px;background:var(--bg);overflow:hidden}.ll-progress i{display:block;height:100%;background:linear-gradient(90deg,#8a5cff,#38d996)}.ll-gate{display:flex;justify-content:space-between;gap:12px;margin-bottom:9px;font-size:12px;color:var(--text-dim)}.ll-gate b.collect{color:#bd91ff}.ll-gate b.pass{color:#38d996}.ll-gate b.fail{color:#ff6577}.ll-table{overflow:auto}.ll-table table{width:100%;border-collapse:collapse;font-size:12px}.ll-table th,.ll-table td{text-align:left;padding:9px;border-bottom:1px solid var(--border);white-space:nowrap}.ll-table th{color:var(--text-faint);font-size:10px;text-transform:uppercase}.ll-note{font-size:12px;color:var(--text-faint);line-height:1.55}.ll-empty{padding:24px;text-align:center;color:var(--text-faint)}@media(max-width:760px){.ll-stats{width:100%;justify-content:space-between;gap:8px}.ll-grid{grid-template-columns:repeat(2,1fr)}.ll-head{display:block}.ll-engine{margin-top:10px;width:max-content}}`;

export async function lighterLuxalgoHero(lang: Lang): Promise<string> {
  const s = summary();
  const g = gate(s, lang);
  return `<a class="ll-hero" href="/lab/lighter-luxalgo">
    <div><span class="ll-badge">🟣 LUXALGO → LIGHTER · ZERO FEE · SHADOW</span>
      <div class="ll-title">SOL 5m · Liquidity Grab + Money Flow 50</div>
      <div class="ll-sub">${t(lang, 'Реальный L2 через 300 мс · $1000 · spread/slippage/funding учтены →', 'Actual L2 after 300 ms · $1,000 · spread/slippage/funding included →')}</div>
    </div>
    <div class="ll-stats">
      <span><b class="${s.feedLive ? 'pos' : 'neg'}">${s.feedLive ? 'L2 LIVE' : 'OFFLINE'}</b><small>Lighter</small></span>
      <span><b>${s.signals}</b><small>${t(lang, 'сигналов', 'signals')}</small></span>
      <span><b>${s.closed}/${VALIDATION_TARGET}</b><small>${esc(g.label)}</small></span>
      <span><b class="${pnlClass(s.netPct)}">${signedPct(s.netPct)}</b><small>net · ${signedUsd(s.netUsd)}</small></span>
    </div>
  </a>`;
}

function tradeRows(rows: TradeRow[], lang: Lang): string {
  if (!rows.length) return `<div class="ll-empty">${t(lang, 'Закрытых Lighter-shadow сделок пока нет.', 'No closed Lighter shadow trades yet.')}</div>`;
  return rows.map((row) => {
    const net = row.net_pnl_pct ?? 0;
    return `<tr><td>#${row.id}</td><td>${utc(row.opened_at)}</td><td>${utc(row.closed_at)}</td>
      <td>${held(row.opened_at, row.closed_at)}</td><td><b>${row.side.toUpperCase()}</b></td>
      <td>$${NOTIONAL_USD.toFixed(0)}</td><td>${row.entry_price.toFixed(4)} → ${row.exit_price?.toFixed(4) ?? '—'}</td>
      <td>${row.gross_pnl_pct == null ? '—' : signedPct(row.gross_pnl_pct)}</td>
      <td>${row.funding_pnl_pct == null ? '—' : signedPct(row.funding_pnl_pct)}</td>
      <td class="${pnlClass(net)}"><b>${row.net_pnl_pct == null ? t(lang, 'открыта', 'open') : `${signedPct(net)} · ${signedUsd(net / 100 * NOTIONAL_USD)}`}</b></td></tr>`;
  }).join('');
}

function signalRows(rows: SignalRow[], lang: Lang): string {
  if (!rows.length) return `<div class="ll-empty">${t(lang, 'Ждём первый alert STRAT-010.', 'Waiting for the first STRAT-010 alert.')}</div>`;
  return rows.map((row) => {
    const price = row.side === 'long' ? row.buy_vwap_1000 : row.sell_vwap_1000;
    const slip = row.side === 'long' ? row.buy_slippage_pct : row.sell_slippage_pct;
    return `<tr><td>${utc(row.received_at)}</td><td>${row.side.toUpperCase()}</td>
      <td>${row.capture_status === 'captured' ? '✓ +300 ms' : esc(row.capture_error ?? row.capture_status)}</td>
      <td>${row.bid?.toFixed(4) ?? '—'} / ${row.ask?.toFixed(4) ?? '—'}</td>
      <td>${price?.toFixed(4) ?? '—'}</td><td>${row.spread_pct == null ? '—' : `${row.spread_pct.toFixed(4)}%`}</td>
      <td>${slip == null ? '—' : `${slip.toFixed(4)}%`}</td>
      <td>${row.funding_rate_pct_h == null ? '—' : `${row.funding_rate_pct_h.toFixed(4)}%/h`}</td></tr>`;
  }).join('');
}

async function render(lang: Lang): Promise<string> {
  const s = summary();
  const g = gate(s, lang);
  const trades = recentTrades().filter((row) => row.closed_at != null);
  const signals = recentSignals();
  const progress = Math.min(100, s.closed / VALIDATION_TARGET * 100);
  const wr = s.closed ? s.wins / s.closed * 100 : 0;
  const pf = s.profitFactor == null ? '—' : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞';
  return pageShell(
    t(lang, 'LuxAlgo → Lighter — shadow', 'LuxAlgo → Lighter — shadow'),
    `<style>${LIGHTER_LUXALGO_CSS}</style><div class="ll-wrap">
      <a class="ll-back" href="/lab">${t(lang, '← Лаборатория', '← Lab')}</a>
      <div class="ll-head"><div><span class="ll-badge">STRAT-010 · PROSPECTIVE FORWARD</span>
        <h1>SOL 5m · LuxAlgo → Lighter</h1>
        <p>${t(lang, 'Сигнал: Liquidity Grab + Money Flow 50. Исполнение моделируется по живому стакану Lighter Standard через обязательные 300 мс. Реальные ордера выключены.', 'Signal: Liquidity Grab + Money Flow 50. Execution is modeled on the live Lighter Standard book after its mandatory 300 ms. Real orders are disabled.')}</p>
      </div><div class="ll-engine ${s.feedLive ? 'live' : ''}"><i></i>${s.feedLive ? 'Lighter L2 live' : 'Lighter L2 offline'}</div></div>

      <div class="ll-grid">
        <div class="ll-card"><small>${t(lang, 'Сигналы / ошибки', 'Signals / errors')}</small><b>${s.signals} / ${s.captureErrors}</b><em>STRAT-010 webhook</em></div>
        <div class="ll-card"><small>${t(lang, 'Закрыто / открыто', 'Closed / open')}</small><b>${s.closed} / ${s.open}</b><em>$${NOTIONAL_USD} notional</em></div>
        <div class="ll-card"><small>Net P&amp;L</small><b class="${pnlClass(s.netPct)}">${signedPct(s.netPct)}</b><em>${signedUsd(s.netUsd)} · fee 0%</em></div>
        <div class="ll-card"><small>WR / PF</small><b>${s.closed ? `${wr.toFixed(0)}% / ${pf}` : '—'}</b><em>${t(lang, 'после всех издержек', 'after all costs')}</em></div>
        <div class="ll-card"><small>${t(lang, 'Текущий spread', 'Current spread')}</small><b>${s.currentSpreadPct == null ? '—' : `${s.currentSpreadPct.toFixed(4)}%`}</b><em>Lighter SOL</em></div>
        <div class="ll-card"><small>${t(lang, 'Стоимость круга', 'Round-trip cost')}</small><b>${s.currentRoundTripCostPct == null ? '—' : `≈${s.currentRoundTripCostPct.toFixed(4)}%`}</b><em>spread + $1000 depth</em></div>
        <div class="ll-card"><small>${t(lang, 'Первая половина', 'First half')}</small><b class="${pnlClass(s.firstHalfPct)}">${signedPct(s.firstHalfPct)}</b><em>${t(lang, 'защита от одного удачного режима', 'regime robustness')}</em></div>
        <div class="ll-card"><small>${t(lang, 'Вторая половина', 'Second half')}</small><b class="${pnlClass(s.secondHalfPct)}">${signedPct(s.secondHalfPct)}</b><em>${t(lang, 'должна быть > 0%', 'must be > 0%')}</em></div>
      </div>

      <div class="ll-panel"><div class="ll-gate"><span>${t(lang, 'Гейт к минимальному real-canary', 'Gate to a minimal real canary')}</span><b class="${g.cls}">${esc(g.label)}</b></div>
        <div class="ll-progress"><i style="width:${progress.toFixed(0)}%"></i></div>
        <p class="ll-note">${t(lang, 'Требования: минимум 20 закрытых forward-сделок, положительный net, PF ≥ 1.20, положительные первая и вторая половины. Выполнение гейта не включает реал автоматически.', 'Requirements: at least 20 closed forward trades, positive net, PF ≥ 1.20, and positive first and second halves. Passing the gate never enables real trading automatically.')}</p>
      </div>

      <div class="ll-panel"><h2>${t(lang, 'Сделки — вход и выход в одной строке', 'Trades — entry and exit in one row')}</h2><div class="ll-table"><table>
        <thead><tr><th>ID</th><th>${t(lang, 'Открыта UTC', 'Opened UTC')}</th><th>${t(lang, 'Закрыта UTC', 'Closed UTC')}</th><th>${t(lang, 'Жизнь', 'Held')}</th><th>Side</th><th>${t(lang, 'Размер', 'Size')}</th><th>Entry → Exit</th><th>Price P&amp;L</th><th>Funding*</th><th>Net</th></tr></thead>
        <tbody>${tradeRows(trades, lang)}</tbody></table></div></div>

      <div class="ll-panel"><h2>${t(lang, 'Последние исполнения сигналов', 'Latest signal executions')}</h2><div class="ll-table"><table>
        <thead><tr><th>${t(lang, 'Сигнал UTC', 'Signal UTC')}</th><th>Side</th><th>Capture</th><th>Bid / Ask</th><th>VWAP $1000</th><th>Spread</th><th>Slippage</th><th>Funding</th></tr></thead>
        <tbody>${signalRows(signals, lang)}</tbody></table></div></div>

      <p class="ll-note">* ${t(lang, 'Комиссия Lighter Standard — 0%. Spread и проскальзывание уже находятся внутри entry/exit VWAP. Funding в shadow оценивается по средней ставке на входе и выходе; точный account ledger появится только при реальной позиции.', 'Lighter Standard fee is 0%. Spread and slippage are already embedded in entry/exit VWAP. Shadow funding uses the mean entry/exit rate; an exact account ledger exists only for a real position.')}</p>
    </div>`,
    { autoRefreshSec: 30, lang },
  );
}

export async function lighterLuxalgoLabRoute(app: FastifyInstance): Promise<void> {
  app.get('/lab/lighter-luxalgo', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=15');
    return render(getLang(req));
  });
}

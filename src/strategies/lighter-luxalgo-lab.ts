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
type Action = 'entry' | 'exit';

type StrategySpec = {
  id: string;
  code: string;
  name: string;
  symbol: string;
  asset: string;
  marketId: number;
  stopPct: number;
  backtest: {
    period: string;
    trades: number;
    winRatePct: number;
    profitFactor: number;
    netPct: number;
    maxDrawdownPct: number;
  };
};

const t = (lang: Lang, ru: string, en: string): string => lang === 'en' ? en : ru;
const NOTIONAL_USD = 1_000;
const MAX_SOCKET_AGE_MS = 5_000;
const CAPTURE_RETRY_MS = 100;
const MAX_CAPTURE_ATTEMPTS = 50;
const VALIDATION_TARGET = 20;
const STOP_CHECK_MS = 250;
const LIGHTER_WS = 'wss://mainnet.zklighter.elliot.ai/stream';

// Selection frozen on 2026-07-26 from commission-net prospective evidence:
// SOL +7.58%/30 and ETH +0.71%/12 (both halves positive). AVAX STRAT-012
// was removed on 2026-07-26: its second forward half was negative and its
// fixed-notional backtest drawdown (17.26%) no longer passed this track's
// admission standard. The earlier BTC STRAT-008 remains excluded; STRAT-015
// is a different 5m setup that passed a fresh 161-trade fixed-notional audit.
// STRAT-016 LTC through STRAT-019 HBAR passed the same chronological audit.
// STRAT-020 AAVE was admitted only after full trade-log normalization to
// $1,000 notional; it stayed positive in every chronological third with a
// conservative 5% stop. A new BNB candidate also passed the numerical gate,
// but is excluded until LuxAlgo can persist its webhook alert. BCH, DOGE, XLM,
// TRX, POL, JUP, ADA and SUI candidates remain excluded.
const STRATEGIES: readonly StrategySpec[] = [
  {
    id: 'sol-lg-mf50',
    code: '010',
    name: 'Liquidity Grab · Money Flow 50',
    symbol: 'SOLUSDT',
    asset: 'SOL',
    marketId: 2,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 145,
      winRatePct: 70.34,
      profitFactor: 1.714,
      netPct: 54.295,
      maxDrawdownPct: 15.12,
    },
  },
  {
    id: 'eth-cntr-st',
    code: '013',
    name: 'Contrarian Any · Smart Trail',
    symbol: 'ETHUSDT',
    asset: 'ETH',
    marketId: 0,
    stopPct: 4,
    backtest: {
      period: '2026-03-15 → 2026-05-22',
      trades: 144,
      winRatePct: 63.89,
      profitFactor: 1.67,
      netPct: 26.38,
      maxDrawdownPct: 8.37,
    },
  },
  {
    id: 'btc-choch-cfm-tc',
    code: '015',
    name: 'CHoCH · Confirmation · Trend Catcher',
    symbol: 'BTCUSDT',
    asset: 'BTC',
    marketId: 1,
    stopPct: 3.5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 161,
      winRatePct: 67.08,
      profitFactor: 1.917,
      netPct: 42.589,
      maxDrawdownPct: 5.602,
    },
  },
  {
    id: 'ltc-tcs-smart-trail',
    code: '016',
    name: 'Trend Catcher Switch · Smart Trail',
    symbol: 'LTCUSDT',
    asset: 'LTC',
    marketId: 35,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 181,
      winRatePct: 70.17,
      profitFactor: 2.035,
      netPct: 48.856,
      maxDrawdownPct: 5.316,
    },
  },
  {
    id: 'uni-cfm-smart-weak',
    code: '017',
    name: 'Confirmation · Smart Trail · Weak Confluence',
    symbol: 'UNIUSDT',
    asset: 'UNI',
    marketId: 30,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 181,
      winRatePct: 75.69,
      profitFactor: 2.038,
      netPct: 60.731,
      maxDrawdownPct: 10.892,
    },
  },
  {
    id: 'dot-cntr-tc-hw',
    code: '018',
    name: 'Contrarian · Trend Catcher · HyperWave',
    symbol: 'DOTUSDT',
    asset: 'DOT',
    marketId: 11,
    stopPct: 5,
    backtest: {
      period: '2026-04-08 → 2026-06-15',
      trades: 180,
      winRatePct: 75,
      profitFactor: 1.915,
      netPct: 47.657,
      maxDrawdownPct: 12.2,
    },
  },
  {
    id: 'hbar-cfm-smart-weak',
    code: '019',
    name: 'Confirmation · Smart Trail · Weak Confluence',
    symbol: 'HBARUSDT',
    asset: 'HBAR',
    marketId: 59,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-14',
      trades: 184,
      winRatePct: 65.76,
      profitFactor: 2.151,
      netPct: 55.507,
      maxDrawdownPct: 5.683,
    },
  },
  {
    id: 'aave-cntr-strong',
    code: '020',
    name: 'Contrarian Any · Strong Confluence',
    symbol: 'AAVEUSDT',
    asset: 'AAVE',
    marketId: 27,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 152,
      winRatePct: 66.45,
      profitFactor: 2.789,
      netPct: 14.843,
      maxDrawdownPct: 5.396,
    },
  },
] as const;

const STRATEGY_BY_ID = new Map(STRATEGIES.map((spec) => [spec.id, spec]));
const STRATEGY_IDS = STRATEGIES.map((spec) => spec.id);
const SQL_MARKS = STRATEGIES.map(() => '?').join(', ');
const ASSET_LABEL = STRATEGIES.map((spec) => spec.asset).join(' · ');
const CODE_LABEL = STRATEGIES.map((spec) => spec.code).join(' · ');

type FeedState = {
  connected: boolean;
  connectedAt: number | null;
  lastSocketAt: number | null;
  lastBookAt: number | null;
  exchangeAt: number | null;
  bookNonce: number | null;
  tickerNonce: number | null;
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
  strategy_id: string;
  symbol: string;
  received_at: number;
  captured_at: number | null;
  action: Action;
  side: Side;
  source_price: number | null;
  capture_status: string;
  capture_error: string | null;
  book_age_ms: number | null;
  bid: number | null;
  ask: number | null;
  buy_vwap_1000: number | null;
  sell_vwap_1000: number | null;
  spread_pct: number | null;
  buy_slippage_pct: number | null;
  sell_slippage_pct: number | null;
  funding_rate_pct_h: number | null;
};

type OpenTradeRow = {
  id: number;
  side: Side;
  opened_at: number;
  entry_price: number;
};

type TradeRow = {
  id: number;
  strategy_id: string;
  symbol: string;
  side: Side;
  entry_signal_id: number;
  exit_signal_id: number | null;
  opened_at: number;
  closed_at: number | null;
  entry_price: number;
  entry_funding_pct_h: number;
  exit_price: number | null;
  gross_pnl_pct: number | null;
  funding_pnl_pct: number | null;
  net_pnl_pct: number | null;
  notional_usd: number;
  close_reason: string | null;
  cumulative_net_pct: number | null;
  strategy_cumulative_net_pct: number | null;
};

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
  avgNetPct: number;
  maxDrawdownPct: number;
  firstHalfPct: number;
  secondHalfPct: number;
  currentSpreadPct: number | null;
  currentRoundTripCostPct: number | null;
};

function emptyFeed(): FeedState {
  return {
    connected: false,
    connectedAt: null,
    lastSocketAt: null,
    lastBookAt: null,
    exchangeAt: null,
    bookNonce: null,
    tickerNonce: null,
    reconnects: 0,
    bids: new Map(),
    asks: new Map(),
    fundingRatePctH: 0,
    indexPrice: null,
    markPrice: null,
  };
}

const feeds = new Map(STRATEGIES.map((spec) => [spec.marketId, emptyFeed()]));
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

const insertSignal = db.prepare(`
  INSERT OR IGNORE INTO lighter_lux_signals
    (dedup_key, strategy_id, symbol, action, side, strategy_event, bar_time,
     received_at, capture_due_at, source_price)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
const findOpenTrade = db.prepare<[string], OpenTradeRow>(`
  SELECT id, side, opened_at, entry_price
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
      net_pnl_pct = ?, close_reason = ?
  WHERE id = ? AND closed_at IS NULL`);
const stopTrade = db.prepare(`
  UPDATE lighter_lux_trades
  SET closed_at = ?, exit_price = ?, exit_funding_pct_h = ?,
      gross_pnl_pct = ?, funding_pnl_pct = ?, net_pnl_pct = ?,
      close_reason = ?
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

function updateLevels(target: Map<number, number>, rows: unknown): void {
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

function resetFeed(feed: FeedState, connected: boolean): void {
  feed.connected = connected;
  feed.connectedAt = connected ? Date.now() : null;
  feed.lastSocketAt = connected ? feed.connectedAt : null;
  feed.lastBookAt = null;
  feed.exchangeAt = null;
  feed.bookNonce = null;
  feed.tickerNonce = null;
  feed.bids.clear();
  feed.asks.clear();
}

function marketIdFromChannel(channel: unknown): number | null {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/:(\d+)$/);
  return match ? finite(match[1]) : null;
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
    for (const [marketId, feed] of feeds) {
      resetFeed(feed, true);
      ws?.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${marketId}` }));
      ws?.send(JSON.stringify({ type: 'subscribe', channel: `ticker/${marketId}` }));
      ws?.send(JSON.stringify({ type: 'subscribe', channel: `market_stats/${marketId}` }));
    }
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try { ws?.ping(); } catch { /* close handler owns recovery */ }
    }, 2_000);
    pingTimer.unref();
    logger.info(
      { markets: STRATEGIES.map((spec) => `${spec.asset}:${spec.marketId}`) },
      'lighter-lux: portfolio read-only feeds connected',
    );
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(rawText(data)) as {
        channel?: unknown;
        timestamp?: unknown;
        nonce?: unknown;
        order_book?: {
          bids?: unknown; asks?: unknown; nonce?: unknown; begin_nonce?: unknown;
        };
        ticker?: Record<string, unknown>;
        market_stats?: Record<string, unknown>;
      };
      const marketId = marketIdFromChannel(message.channel);
      if (marketId == null) return;
      const feed = feeds.get(marketId);
      if (!feed) return;
      feed.lastSocketAt = Date.now();

      const tickerNonce = message.ticker ? finite(message.nonce) : null;
      if (tickerNonce != null) feed.tickerNonce = tickerNonce;
      if (message.market_stats) {
        feed.fundingRatePctH = finite(message.market_stats.current_funding_rate) ?? 0;
        feed.indexPrice = finite(message.market_stats.index_price);
        feed.markPrice = finite(message.market_stats.mark_price);
      }
      if (!message.order_book) return;

      const nonce = finite(message.order_book.nonce);
      const beginNonce = finite(message.order_book.begin_nonce);
      if (feed.bookNonce != null && beginNonce != null && beginNonce !== feed.bookNonce) {
        logger.warn(
          { marketId, previousNonce: feed.bookNonce, beginNonce, nonce },
          'lighter-lux: order-book nonce gap; resubscribing',
        );
        resetFeed(feed, true);
        ws?.send(JSON.stringify({ type: 'unsubscribe', channel: `order_book/${marketId}` }));
        ws?.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${marketId}` }));
        return;
      }

      updateLevels(feed.bids, message.order_book.bids);
      updateLevels(feed.asks, message.order_book.asks);
      if (!feed.bids.size || !feed.asks.size) return;
      feed.lastBookAt = Date.now();
      feed.exchangeAt = finite(message.timestamp) ?? feed.lastBookAt;
      if (nonce != null) feed.bookNonce = nonce;
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'lighter-lux: bad message');
    }
  });

  ws.on('pong', () => {
    const now = Date.now();
    for (const feed of feeds.values()) {
      if (feed.connected) feed.lastSocketAt = now;
    }
  });
  ws.on('close', () => {
    for (const feed of feeds.values()) {
      feed.reconnects += 1;
      resetFeed(feed, false);
    }
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
  stopTimer = setInterval(checkSafetyStops, STOP_CHECK_MS);
  stopTimer.unref();
}

function executionSnapshot(spec: StrategySpec): ExecutionSnapshot | { error: string } {
  const feed = feeds.get(spec.marketId);
  const now = Date.now();
  if (
    !feed
    || !feed.connected
    || feed.lastSocketAt == null
    || feed.lastBookAt == null
    || feed.exchangeAt == null
    || feed.bookNonce == null
  ) return { error: `${spec.asset.toLowerCase()}_feed_offline` };

  const socketAgeMs = now - feed.lastSocketAt;
  if (socketAgeMs > MAX_SOCKET_AGE_MS)
    return { error: `${spec.asset.toLowerCase()}_stale_socket_${socketAgeMs}ms` };
  // Ticker nonce is engine-global while an individual market's book nonce
  // advances only when that book changes. Comparing them rejects perfectly
  // healthy, quieter altcoin books, which can lag the ticker by thousands of
  // engine events. Per-book begin_nonce continuity plus socket heartbeat is the
  // valid freshness check.

  const bids = [...feed.bids.entries()].sort((a, b) => b[0] - a[0]) as PriceLevel[];
  const asks = [...feed.asks.entries()].sort((a, b) => a[0] - b[0]) as PriceLevel[];
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (!bestBid || !bestAsk) return { error: `${spec.asset.toLowerCase()}_empty_book` };
  const bid = bestBid[0];
  const ask = bestAsk[0];
  if (!(bid > 0) || !(ask > bid)) return { error: `${spec.asset.toLowerCase()}_invalid_bbo` };

  const buyVwap = quoteNotionalVwap(asks, NOTIONAL_USD);
  const sellVwap = quoteNotionalVwap(bids, NOTIONAL_USD);
  if (buyVwap == null || sellVwap == null)
    return { error: `${spec.asset.toLowerCase()}_depth_below_1000` };

  const mid = (bid + ask) / 2;
  return {
    capturedAt: now,
    exchangeAt: feed.exchangeAt,
    bookAgeMs: now - feed.lastBookAt,
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
  spec: StrategySpec,
  signalId: number,
  action: Action,
  side: Side,
  snap: ExecutionSnapshot,
) => {
  markCaptured.run(
    snap.capturedAt, snap.exchangeAt, snap.bookAgeMs, snap.bid, snap.ask,
    snap.buyVwap, snap.sellVwap, snap.spreadPct, snap.buySlippagePct,
    snap.sellSlippagePct, snap.fundingRatePctH, snap.indexPrice,
    snap.markPrice, signalId,
  );

  const open = findOpenTrade.get(spec.id);
  const shouldClose = open && (
    (action === 'entry' && open.side !== side)
    || (action === 'exit' && open.side === side)
  );
  if (open && shouldClose) {
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
      gross, funding, gross + funding,
      action === 'exit' ? 'strategy_exit' : 'reverse_signal',
      open.id,
    );
  }

  if (action === 'exit' || open?.side === side) return;
  const entryPrice = side === 'long' ? snap.buyVwap : snap.sellVwap;
  insertTrade.run(
    spec.id, spec.asset, side, signalId, snap.capturedAt, entryPrice,
    snap.fundingRatePctH, NOTIONAL_USD,
  );
});

function capture(
  spec: StrategySpec,
  signalId: number,
  action: Action,
  side: Side,
  attempt = 1,
): void {
  try {
    const snap = executionSnapshot(spec);
    if ('error' in snap) {
      if (attempt < MAX_CAPTURE_ATTEMPTS) {
        const timer = setTimeout(
          () => capture(spec, signalId, action, side, attempt + 1),
          CAPTURE_RETRY_MS,
        );
        timer.unref();
        return;
      }
      const failedAt = Date.now();
      // A temporary feed problem must never fabricate an incomplete close.
      // Keep the existing shadow position open and close/reverse it only after
      // a later signal has a real executable L2 snapshot.
      markCaptureError.run(failedAt, snap.error, signalId);
      return;
    }
    applyCapturedSignal(spec, signalId, action, side, snap);
  } catch (error) {
    markCaptureError.run(Date.now(), `capture_exception:${(error as Error).message}`, signalId);
    logger.error({ error, signalId, strategyId: spec.id }, 'lighter-lux: capture failed');
  }
}

/** Independent portfolio shadow; it never delays or changes Track C. */
export function queueLighterLuxalgoSignal(payload: LuxAlgoStrategyPayload): void {
  const spec = STRATEGY_BY_ID.get(payload.strategy_id);
  if (!spec || payload.symbol !== spec.symbol) return;
  const derived = deriveActionSide(payload);
  if (!derived.side) return;
  const action = derived.action;
  const side = derived.side;
  const receivedAt = Date.now();
  const key = createHash('sha256')
    .update(`${payload.strategy_id}|${payload.symbol}|${action}|${side}|${payload.strategy_event}|${payload.bar_time}`)
    .digest('hex');
  const result = insertSignal.run(
    key, payload.strategy_id, payload.symbol, action, side,
    String(payload.strategy_event ?? side), payload.bar_time,
    receivedAt, receivedAt, finite(payload.price),
  );
  if (result.changes !== 1) return;
  capture(spec, Number(result.lastInsertRowid), action, side);
}

function checkSafetyStops(): void {
  for (const spec of STRATEGIES) {
    try {
      const open = findOpenTrade.get(spec.id);
      if (!open) continue;
      const snap = executionSnapshot(spec);
      if ('error' in snap) continue;
      const exitPrice = open.side === 'long' ? snap.sellVwap : snap.buyVwap;
      const gross = pricePnlPct(open.side, open.entry_price, exitPrice);
      if (gross > -spec.stopPct) continue;
      const entryRate = entryFunding.get(open.id)?.entry_funding_pct_h ?? 0;
      const funding = estimatedFundingPnlPct(
        open.side,
        entryRate,
        snap.fundingRatePctH,
        snap.capturedAt - open.opened_at,
      );
      stopTrade.run(
        snap.capturedAt, exitPrice, snap.fundingRatePctH,
        gross, funding, gross + funding,
        `safety_stop_${spec.stopPct}pct`,
        open.id,
      );
    } catch (error) {
      logger.error({ error, strategyId: spec.id }, 'lighter-lux: safety-stop check failed');
    }
  }
}

function rowsForSummary(spec?: StrategySpec): Array<{ net_pnl_pct: number; closed_at: number }> {
  if (spec) {
    return db.prepare<[string], { net_pnl_pct: number; closed_at: number }>(`
      SELECT net_pnl_pct, closed_at FROM lighter_lux_trades
      WHERE strategy_id = ? AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
      ORDER BY closed_at, id`).all(spec.id);
  }
  return db.prepare<string[], { net_pnl_pct: number; closed_at: number }>(`
    SELECT net_pnl_pct, closed_at FROM lighter_lux_trades
    WHERE strategy_id IN (${SQL_MARKS})
      AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at, id`).all(...STRATEGY_IDS);
}

function summary(spec?: StrategySpec): Summary {
  const where = spec ? 'strategy_id = ?' : `strategy_id IN (${SQL_MARKS})`;
  const params = spec ? [spec.id] : STRATEGY_IDS;
  const signalCounts = db.prepare<string[], { total: number; errors: number }>(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN capture_status = 'error' THEN 1 ELSE 0 END), 0) errors
    FROM lighter_lux_signals WHERE ${where}`).get(...params);
  const trades = rowsForSummary(spec);
  const open = db.prepare<string[], { count: number }>(`
    SELECT COUNT(*) count FROM lighter_lux_trades
    WHERE ${where} AND closed_at IS NULL`).get(...params)?.count ?? 0;

  const netPct = trades.reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const positive = trades.filter((row) => row.net_pnl_pct > 0);
  const negative = trades.filter((row) => row.net_pnl_pct < 0);
  const grossWin = positive.reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const grossLoss = Math.abs(negative.reduce((sum, row) => sum + row.net_pnl_pct, 0));
  const split = Math.floor(trades.length / 2);
  const firstHalfPct = trades.slice(0, split).reduce((sum, row) => sum + row.net_pnl_pct, 0);
  const secondHalfPct = trades.slice(split).reduce((sum, row) => sum + row.net_pnl_pct, 0);

  let equityPct = 0;
  let peakPct = 0;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equityPct += trade.net_pnl_pct;
    peakPct = Math.max(peakPct, equityPct);
    maxDrawdownPct = Math.max(maxDrawdownPct, peakPct - equityPct);
  }

  const snapshots = (spec ? [spec] : STRATEGIES)
    .map((item) => executionSnapshot(item))
    .filter((snap): snap is ExecutionSnapshot => !('error' in snap));
  const feedLive = snapshots.length === (spec ? 1 : STRATEGIES.length);
  const avg = (values: number[]): number | null =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return {
    feedLive,
    signals: signalCounts?.total ?? 0,
    captureErrors: signalCounts?.errors ?? 0,
    closed: trades.length,
    open,
    netPct,
    netUsd: netPct / 100 * NOTIONAL_USD,
    wins: positive.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : trades.length ? Infinity : null,
    avgNetPct: trades.length ? netPct / trades.length : 0,
    maxDrawdownPct,
    firstHalfPct,
    secondHalfPct,
    currentSpreadPct: avg(snapshots.map((snap) => snap.spreadPct)),
    currentRoundTripCostPct: avg(snapshots.map(
      (snap) => snap.spreadPct + snap.buySlippagePct + snap.sellSlippagePct,
    )),
  };
}

function recentSignals(limit = 40): SignalRow[] {
  return db.prepare<[...string[], number], SignalRow>(`
    SELECT id, strategy_id, symbol, received_at, captured_at, action, side,
           source_price, capture_status, capture_error, book_age_ms, bid, ask,
           buy_vwap_1000, sell_vwap_1000, spread_pct, buy_slippage_pct,
           sell_slippage_pct, funding_rate_pct_h
    FROM lighter_lux_signals
    WHERE strategy_id IN (${SQL_MARKS})
    ORDER BY received_at DESC
    LIMIT ?`).all(...STRATEGY_IDS, limit);
}

function recentTrades(limit = 60): TradeRow[] {
  const rows = db.prepare<string[], TradeRow>(`
    SELECT id, strategy_id, symbol, side, entry_signal_id, exit_signal_id,
           opened_at, closed_at, entry_price, entry_funding_pct_h,
           exit_price, gross_pnl_pct,
           funding_pnl_pct, net_pnl_pct, notional_usd, close_reason,
           NULL cumulative_net_pct, NULL strategy_cumulative_net_pct
    FROM lighter_lux_trades
    WHERE strategy_id IN (${SQL_MARKS})
    ORDER BY opened_at, id`).all(...STRATEGY_IDS);
  let portfolioTotal = 0;
  const strategyTotals = new Map<string, number>();
  for (const row of rows) {
    if (row.net_pnl_pct == null) continue;
    portfolioTotal += row.net_pnl_pct;
    const strategyTotal = (strategyTotals.get(row.strategy_id) ?? 0) + row.net_pnl_pct;
    strategyTotals.set(row.strategy_id, strategyTotal);
    row.cumulative_net_pct = portfolioTotal;
    row.strategy_cumulative_net_pct = strategyTotal;
  }
  return rows.slice(-limit).reverse();
}

function gate(s: Summary, lang: Lang): { cls: string; label: string; passed: boolean } {
  if (s.closed < VALIDATION_TARGET) return {
    cls: 'collect',
    label: t(lang, `КОПИМ ${s.closed}/${VALIDATION_TARGET}`, `COLLECTING ${s.closed}/${VALIDATION_TARGET}`),
    passed: false,
  };
  const passed = s.netPct > 0
    && (s.profitFactor ?? 0) >= 1.2
    && s.firstHalfPct > 0
    && s.secondHalfPct > 0;
  return passed
    ? { cls: 'pass', label: t(lang, 'ГЕЙТ ПРОЙДЕН', 'GATE PASSED'), passed }
    : { cls: 'fail', label: t(lang, 'ГЕЙТ НЕ ПРОЙДЕН', 'GATE FAILED'), passed };
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
function utcShort(value: number | null): string {
  return value ? new Date(value).toISOString().slice(5, 16).replace('T', ' ') : '—';
}
function held(opened: number, closed: number | null): string {
  const hours = ((closed ?? Date.now()) - opened) / 3_600_000;
  return hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}
function pfLabel(value: number | null): string {
  return value == null ? '—' : Number.isFinite(value) ? value.toFixed(2) : '∞';
}

export const LIGHTER_LUXALGO_CSS = `
.ll-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:0 0 14px;padding:17px 20px;border:1px solid rgba(163,106,255,.36);border-radius:14px;background:linear-gradient(135deg,rgba(122,71,255,.15),var(--bg-card));color:var(--text);text-decoration:none}
.ll-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(163,106,255,.15);color:#bd91ff;font-size:11px;font-weight:750;letter-spacing:.04em}
.ll-title{font-size:19px;font-weight:700;margin-top:8px}.ll-sub{font-size:13px;color:var(--text-dim);margin-top:3px}
.ll-stats{display:flex;gap:22px}.ll-stats span{display:grid;text-align:right}.ll-stats b{font-size:18px}.ll-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}
.ll-stats .pos,.ll-card .pos,.pos{color:#38d996}.ll-stats .neg,.ll-card .neg,.neg{color:#ff6577}
.ll-wrap{max-width:1280px;margin:0 auto}.ll-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}
.ll-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.ll-head h1{font-size:34px;margin:10px 0 7px}.ll-head p{max-width:860px;color:var(--text-dim)}
.ll-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.ll-engine i{width:8px;height:8px;border-radius:50%;background:#ff6577}.ll-engine.live i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}
.ll-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.ll-card,.ll-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.ll-card{padding:13px 14px;display:grid;gap:4px}.ll-card small,.ll-card em{color:var(--text-faint);font-size:10px;font-style:normal}.ll-card b{font-size:20px;font-variant-numeric:tabular-nums}
.ll-panel{padding:15px;margin:10px 0}.ll-panel h2{font-size:16px;margin:0 0 11px}
.ll-signal-list{border:1px solid var(--border);border-radius:10px;overflow:hidden}.ll-signal-row{display:grid;grid-template-columns:minmax(120px,1.1fr) 92px 118px 120px 120px;align-items:center;gap:10px;min-height:38px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:11px}.ll-signal-row:last-child{border-bottom:0}.ll-signal-row:hover{background:rgba(255,255,255,.018)}.ll-signal-labels{min-height:30px;color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-signal-strategy b{font-size:11px}.ll-signal-time{color:var(--text-faint);font-variant-numeric:tabular-nums}.ll-signal-event{font-weight:760}.ll-signal-value{font-variant-numeric:tabular-nums}
.ll-live{display:inline-block;margin-left:5px;padding:2px 5px;border-radius:999px;background:rgba(56,217,150,.12);color:#38d996;font-size:9px;letter-spacing:.04em}
.ll-table{width:100%;overflow:hidden}.ll-table table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}.ll-table th,.ll-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);white-space:normal;overflow-wrap:anywhere;vertical-align:middle}.ll-table th{color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.025em}.ll-table small{color:var(--text-faint);font-size:9px}.ll-table .num{font-variant-numeric:tabular-nums}
.ll-strategy-table th:nth-child(1){width:22%}.ll-strategy-table th:nth-child(2){width:7%}.ll-strategy-table th:nth-child(3){width:20%}.ll-strategy-table th:nth-child(4){width:14%}.ll-strategy-table th:nth-child(5){width:13%}.ll-strategy-table th:nth-child(6){width:10%}.ll-strategy-table th:nth-child(7){width:14%}
.ll-signal-table th:nth-child(1){width:22%}.ll-signal-table th:nth-child(2){width:16%}.ll-signal-table th:nth-child(3){width:20%}.ll-signal-table th:nth-child(4){width:18%}.ll-signal-table th:nth-child(5){width:24%}
.ll-trades th:nth-child(1){width:14%}.ll-trades th:nth-child(2){width:19%}.ll-trades th:nth-child(3){width:11%}.ll-trades th:nth-child(4){width:13%}.ll-trades th:nth-child(5){width:16%}.ll-trades th:nth-child(6){width:13%}.ll-trades th:nth-child(7){width:14%}
.ll-tech th:nth-child(1){width:20%}.ll-tech th:nth-child(2){width:18%}.ll-tech th:nth-child(3){width:15%}.ll-tech th:nth-child(4){width:18%}.ll-tech th:nth-child(5){width:29%}
.ll-note{font-size:11px;color:var(--text-faint);line-height:1.45}.ll-empty{padding:18px;text-align:center;color:var(--text-faint)}.collect{color:#bd91ff}.pass{color:#38d996}.fail{color:#ff6577}
.ll-details{padding:0}.ll-details>summary{cursor:pointer;list-style:none;padding:14px 15px;font-size:15px;font-weight:700}.ll-details>summary::-webkit-details-marker{display:none}.ll-details>summary::after{content:'＋';float:right;color:var(--text-faint)}.ll-details[open]>summary::after{content:'−'}.ll-details[open]>.ll-table{padding:0 15px 14px}
@media(max-width:760px){.ll-stats{width:100%;justify-content:space-between;gap:8px}.ll-grid{grid-template-columns:repeat(2,1fr)}.ll-head{display:block}.ll-engine{margin-top:10px;width:max-content}.ll-signal-labels{display:none}.ll-signal-row{grid-template-columns:1fr auto;gap:3px 10px;padding:8px 10px}.ll-signal-row>span:nth-child(n+3){font-size:10px}.ll-table table{font-size:10px}.ll-table th,.ll-table td{padding:6px 4px}.ll-strategy-table th:nth-child(3),.ll-strategy-table td:nth-child(3),.ll-strategy-table th:nth-child(6),.ll-strategy-table td:nth-child(6){display:none}.ll-trades th:nth-child(3),.ll-trades td:nth-child(3){display:none}}`;

export async function lighterLuxalgoHero(lang: Lang): Promise<string> {
  const s = summary();
  const individual = STRATEGIES.map((spec) => ({ spec, gate: gate(summary(spec), lang) }));
  const passed = individual.filter((row) => row.gate.passed).length;
  return `<a class="ll-hero" href="/lab/lighter-luxalgo">
    <div><span class="ll-badge">🟣 LUXALGO → LIGHTER · ZERO FEE · SHADOW</span>
      <div class="ll-title">${ASSET_LABEL} — единый портфель сигналов</div>
      <div class="ll-sub">${t(lang, 'Одна карточка и одна таблица · $1000 на позицию · индивидуальная и общая статистика →', 'One card and one table · $1,000 per position · individual and aggregate statistics →')}</div>
    </div>
    <div class="ll-stats">
      <span><b class="${s.feedLive ? 'pos' : 'neg'}">${s.feedLive ? `${STRATEGIES.length}/${STRATEGIES.length} LIVE` : 'DEGRADED'}</b><small>Lighter L2</small></span>
      <span><b>${s.signals}</b><small>${t(lang, 'сигналов', 'signals')}</small></span>
      <span><b>${passed}/${STRATEGIES.length}</b><small>${t(lang, 'прошли гейт', 'gates passed')}</small></span>
      <span><b class="${pnlClass(s.netPct)}">${signedPct(s.netPct)}</b><small>net · ${signedUsd(s.netUsd)}</small></span>
    </div>
  </a>`;
}

function strategyRows(lang: Lang): string {
  return STRATEGIES.map((spec) => {
    const s = summary(spec);
    const g = gate(s, lang);
    const wr = s.closed ? s.wins / s.closed * 100 : null;
    const feed = executionSnapshot(spec);
    return `<tr>
      <td><b>STRAT-${spec.code} · ${spec.asset}</b><br><small>${esc(spec.name)}</small></td>
      <td class="${'error' in feed ? 'neg' : 'pos'}">${'error' in feed ? 'OFF' : 'LIVE'}</td>
      <td class="num"><b>${spec.backtest.trades} · ${spec.backtest.winRatePct.toFixed(1)}% · ${spec.backtest.profitFactor.toFixed(2)}</b><br><small>${signedPct(spec.backtest.netPct)} · SL ${spec.stopPct.toFixed(1)}%</small></td>
      <td class="num"><b>${s.closed} / ${s.open}</b><br><small>WR ${wr == null ? '—' : `${wr.toFixed(0)}%`} · PF ${pfLabel(s.profitFactor)}</small></td>
      <td class="${pnlClass(s.netPct)}"><b>${signedPct(s.netPct)} · ${signedUsd(s.netUsd)}</b></td>
      <td class="num">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}<br><small>½ ${signedPct(s.firstHalfPct)} · ½ ${signedPct(s.secondHalfPct)}</small></td>
      <td class="${g.cls}"><b>${esc(g.label)}</b></td>
    </tr>`;
  }).join('');
}

function openTradeMark(row: TradeRow): {
  exitPrice: number;
  grossPct: number;
  fundingPct: number;
  netPct: number;
} | null {
  if (row.closed_at != null) return null;
  const spec = STRATEGY_BY_ID.get(row.strategy_id);
  if (!spec) return null;
  const snap = executionSnapshot(spec);
  if ('error' in snap) return null;
  const exitPrice = row.side === 'long' ? snap.sellVwap : snap.buyVwap;
  const grossPct = pricePnlPct(row.side, row.entry_price, exitPrice);
  const fundingPct = estimatedFundingPnlPct(
    row.side,
    row.entry_funding_pct_h,
    snap.fundingRatePctH,
    snap.capturedAt - row.opened_at,
  );
  return { exitPrice, grossPct, fundingPct, netPct: grossPct + fundingPct };
}

function tradeRows(rows: TradeRow[], lang: Lang): string {
  if (!rows.length) return `<tr><td colspan="7" class="ll-empty">${t(lang, 'Lighter-shadow сделок пока нет.', 'No Lighter shadow trades yet.')}</td></tr>`;
  return rows.map((row) => {
    const spec = STRATEGY_BY_ID.get(row.strategy_id);
    const mark = openTradeMark(row);
    const net = row.net_pnl_pct ?? mark?.netPct ?? 0;
    const gross = row.gross_pnl_pct ?? mark?.grossPct ?? null;
    const funding = row.funding_pnl_pct ?? mark?.fundingPct ?? null;
    const stopPct = spec?.stopPct ?? null;
    const stopPrice = stopPct == null
      ? null
      : row.side === 'long'
        ? row.entry_price * (1 - stopPct / 100)
        : row.entry_price * (1 + stopPct / 100);
    const complete = row.net_pnl_pct != null;
    return `<tr>
      <td><b>${spec ? `STRAT-${spec.code}` : esc(row.strategy_id)} · ${esc(row.symbol)}</b><br><small>#${row.id} · S${row.entry_signal_id}→${row.exit_signal_id ?? '—'}</small></td>
      <td class="num">${utcShort(row.opened_at)} → ${utcShort(row.closed_at)}<br><small>${held(row.opened_at, row.closed_at)}</small></td>
      <td><b>${row.side.toUpperCase()}</b><br><small>$${row.notional_usd.toFixed(0)}</small></td>
      <td class="num">${row.entry_price.toFixed(5)}</td>
      <td class="num"><b>${stopPct == null ? '—' : `${stopPct.toFixed(1)}%`}</b><br><small>${stopPrice?.toFixed(5) ?? '—'}</small></td>
      <td class="num">${row.closed_at == null ? '—' : (row.exit_price?.toFixed(5) ?? '—')}</td>
      <td class="${pnlClass(net)}"><b>${complete || mark ? `${signedPct(net)} · ${signedUsd(net / 100 * row.notional_usd)}${mark ? '<span class="ll-live">LIVE</span>' : ''}` : (row.closed_at == null ? t(lang, 'ожидаем L2', 'waiting for L2') : t(lang, 'неполные данные', 'incomplete'))}</b><br><small>fee 0 · fund ${funding == null ? '—' : signedPct(funding, 4)} · price ${gross == null ? '—' : signedPct(gross)}</small></td>
    </tr>`;
  }).join('');
}

function signalRows(rows: SignalRow[], lang: Lang): string {
  if (!rows.length) return `<tr><td colspan="5" class="ll-empty">${t(lang, 'Ждём первый alert.', 'Waiting for the first alert.')}</td></tr>`;
  return rows.map((row) => {
    const spec = STRATEGY_BY_ID.get(row.strategy_id);
    const price = row.side === 'long' ? row.buy_vwap_1000 : row.sell_vwap_1000;
    const latency = row.captured_at == null ? null : row.captured_at - row.received_at;
    const deviation = price == null || row.source_price == null
      ? null
      : row.side === 'long'
        ? (price - row.source_price) / row.source_price * 100
        : (row.source_price - price) / row.source_price * 100;
    return `<tr>
      <td>${spec ? `STRAT-${spec.code}` : esc(row.strategy_id)} · ${esc(row.symbol)}</td>
      <td>${utc(row.received_at)}</td><td>${row.action.toUpperCase()} ${row.side.toUpperCase()}</td>
      <td>${row.capture_status === 'captured' ? `✓ ${latency ?? 0} ms` : esc(row.capture_error ?? row.capture_status)}</td>
      <td class="num">${row.source_price?.toFixed(5) ?? '—'} → ${price?.toFixed(5) ?? '—'}<br><small>spread ${row.spread_pct == null ? '—' : `${row.spread_pct.toFixed(4)}%`} · Δ <span class="${deviation != null && deviation > 0.2 ? 'neg' : ''}">${deviation == null ? '—' : signedPct(deviation, 4)}</span></small></td>
    </tr>`;
  }).join('');
}

function latestSignalRows(rows: SignalRow[], lang: Lang): string {
  const latest = new Map<string, SignalRow>();
  for (const row of rows) {
    if (!latest.has(row.strategy_id)) latest.set(row.strategy_id, row);
  }
  return STRATEGIES.map((spec) => {
    const row = latest.get(spec.id);
    if (!row) return `<tr>
      <td><b>STRAT-${spec.code} · ${spec.asset}</b></td>
      <td class="ll-signal-time">—</td>
      <td class="collect"><b>${t(lang, 'ОЖИДАНИЕ', 'WAITING')}</b></td>
      <td>—</td><td class="collect">${t(lang, 'нет сигнала', 'no signal')}</td>
    </tr>`;
    const latency = row.captured_at == null ? null : row.captured_at - row.received_at;
    const captured = row.capture_status === 'captured';
    return `<tr>
      <td><b>STRAT-${spec.code} · ${spec.asset}</b></td>
      <td class="ll-signal-time">${utcShort(row.received_at)} UTC</td>
      <td class="${row.side === 'long' ? 'pos' : 'neg'}"><b>${row.action.toUpperCase()} · ${row.side.toUpperCase()}</b></td>
      <td class="num">${row.source_price?.toFixed(5) ?? '—'}</td>
      <td class="${captured ? 'pos' : 'neg'}"><b>${captured ? `✓ ${latency ?? 0} ms` : esc(row.capture_error ?? row.capture_status)}</b></td>
    </tr>`;
  }).join('');
}

async function render(lang: Lang): Promise<string> {
  const s = summary();
  const trades = recentTrades();
  const signals = recentSignals();
  const wr = s.closed ? s.wins / s.closed * 100 : 0;
  const passed = STRATEGIES.filter((spec) => gate(summary(spec), lang).passed).length;
  return pageShell(
    t(lang, 'LuxAlgo → Lighter — единый shadow-портфель', 'LuxAlgo → Lighter — unified shadow portfolio'),
    `<style>${LIGHTER_LUXALGO_CSS}</style><div class="ll-wrap">
      <a class="ll-back" href="/lab">${t(lang, '← Лаборатория', '← Lab')}</a>
      <div class="ll-head"><div><span class="ll-badge">STRAT-${CODE_LABEL} · PROSPECTIVE FORWARD</span>
        <h1>LuxAlgo → Lighter · единый портфель</h1>
        <p>${t(lang, `Все подходящие alerts собраны в одной системе и одной таблице. ${ASSET_LABEL} независимо снимают живой L2 Lighter без фиксированной задержки; каждая позиция моделируется на $1000. Комиссия Standard — 0%, spread, $1000 VWAP и funding учтены.`, `All selected alerts share one system and one table. ${ASSET_LABEL} independently sample live Lighter L2 with no fixed delay; every position is modeled at $1,000. Standard trading fee is 0%, while spread, $1,000 VWAP, and funding are included.`)}</p>
      </div><div class="ll-engine ${s.feedLive ? 'live' : ''}"><i></i>${s.feedLive ? `Lighter L2 · ${STRATEGIES.length}/${STRATEGIES.length} live` : 'Lighter L2 · degraded'}</div></div>

      <div class="ll-grid">
        <div class="ll-card"><small>${t(lang, 'Стратегии / гейт', 'Strategies / gates')}</small><b>${STRATEGIES.length} / ${passed}</b><em>${ASSET_LABEL}</em></div>
        <div class="ll-card"><small>${t(lang, 'Сигналы / ошибки', 'Signals / errors')}</small><b>${s.signals} / ${s.captureErrors}</b><em>${t(lang, 'все выбранные alerts', 'all selected alerts')}</em></div>
        <div class="ll-card"><small>${t(lang, 'Закрыто / открыто', 'Closed / open')}</small><b>${s.closed} / ${s.open}</b><em>$${NOTIONAL_USD} ${t(lang, 'на позицию', 'per position')}</em></div>
        <div class="ll-card"><small>${t(lang, 'Общий net PnL', 'Aggregate net PnL')}</small><b class="${pnlClass(s.netPct)}">${signedPct(s.netPct)}</b><em>${signedUsd(s.netUsd)} · fee 0%</em></div>
        <div class="ll-card"><small>${t(lang, 'Общий WR / PF', 'Aggregate WR / PF')}</small><b>${s.closed ? `${wr.toFixed(0)}% / ${pfLabel(s.profitFactor)}` : '—'}</b><em>${t(lang, 'после всех издержек', 'after all costs')}</em></div>
        <div class="ll-card"><small>${t(lang, 'Средняя сделка', 'Average trade')}</small><b class="${pnlClass(s.avgNetPct)}">${s.closed ? signedPct(s.avgNetPct) : '—'}</b><em>net</em></div>
        <div class="ll-card"><small>Max drawdown</small><b class="${s.maxDrawdownPct > 0 ? 'neg' : ''}">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}</b><em>${t(lang, 'общая кривая', 'aggregate curve')}</em></div>
        <div class="ll-card"><small>${t(lang, 'Средний spread / круг', 'Average spread / round trip')}</small><b>${s.currentSpreadPct == null ? '—' : `${s.currentSpreadPct.toFixed(4)}%`}</b><em>${s.currentRoundTripCostPct == null ? '—' : `≈${s.currentRoundTripCostPct.toFixed(4)}%`}</em></div>
      </div>

      <div class="ll-panel"><h2>${t(lang, 'Индивидуальная статистика стратегий', 'Individual strategy statistics')}</h2><div class="ll-table"><table class="ll-strategy-table">
        <thead><tr><th>Strategy</th><th>L2</th><th>Backtest · N / WR / PF</th><th>Forward · closed / open</th><th>Net</th><th>DD / halves</th><th>Gate</th></tr></thead>
        <tbody>${strategyRows(lang)}</tbody>
      </table></div>
      <p class="ll-note">${t(lang, 'Индивидуальный гейт: ≥20 закрытых Lighter-forward сделок, net > 0%, PF ≥1.20, обе половины >0%. Общий результат — сумма PnL при $1000 на каждую одновременно открытую позицию.', 'Individual gate: ≥20 closed Lighter-forward trades, net > 0%, PF ≥1.20, and both halves >0%. Aggregate PnL sums results assuming $1,000 for every concurrently open position.')}</p></div>

      <div class="ll-panel"><h2>${t(lang, 'Входящие сигналы стратегий', 'Incoming strategy signals')}</h2>
        <div class="ll-table"><table class="ll-signal-table">
          <thead><tr><th>Strategy</th><th>${t(lang, 'Время UTC', 'Time UTC')}</th><th>Event</th><th>Lux price</th><th>Lighter L2</th></tr></thead>
          <tbody>${latestSignalRows(signals, lang)}</tbody>
        </table></div>
      </div>

      <div class="ll-panel"><h2>${t(lang, 'Сделки', 'Trades')}</h2><div class="ll-table"><table class="ll-trades">
        <thead><tr><th>Strategy</th><th>${t(lang, 'Открыта → закрыта UTC', 'Opened → closed UTC')}</th><th>Side / size</th><th>${t(lang, 'Цена входа', 'Entry price')}</th><th>${t(lang, 'Стоп-лосс', 'Stop-loss')}</th><th>${t(lang, 'Цена выхода', 'Exit price')}</th><th>Net after costs</th></tr></thead>
        <tbody>${tradeRows(trades, lang)}</tbody>
      </table></div></div>

      <details class="ll-panel ll-details"><summary>${t(lang, 'Технические детали сигналов', 'Signal technical details')}</summary><div class="ll-table"><table class="ll-tech">
        <thead><tr><th>Strategy</th><th>${t(lang, 'Сигнал UTC', 'Signal UTC')}</th><th>Event</th><th>Capture</th><th>Lux → VWAP / spread / Δ</th></tr></thead>
        <tbody>${signalRows(signals, lang)}</tbody>
      </table></div></details>

      <div class="ll-panel"><h2>${t(lang, 'Реальная торговля', 'Live trading')}</h2>
        <p class="ll-note"><b class="fail">OFF · 0 REAL TRADES.</b> ${t(lang, `Shadow включён для ${STRATEGIES.length} выбранных стратегий. Каждая получит индивидуальный допуск; плохой результат одной стратегии не будет маскироваться общей прибылью другой. Реальный canary $100 можно включать только отдельно для стратегии, прошедшей собственный гейт.`, `Shadow is enabled for ${STRATEGIES.length} selected strategies. Each must earn an individual approval; one weak strategy cannot hide behind another strategy’s profit. A $100 live canary may only be enabled separately for a strategy that passes its own gate.`)}</p>
      </div>

      <p class="ll-note">${t(lang, 'Комиссия Lighter Standard — 0%. Spread и slippage уже включены в entry/exit VWAP; funding учитывается отдельно. Расхождение Lux→VWAP измеряется, но не блокирует shadow-вход; значения выше 0.2% подсвечиваются.', 'Lighter Standard trading fee is 0%. Spread and slippage are embedded in entry/exit VWAP; funding is accounted separately. Lux→VWAP deviation is measured but does not block shadow entry; values above 0.2% are highlighted.')}</p>
    </div>`,
    { autoRefreshSec: 5, lang },
  );
}

export async function lighterLuxalgoLabRoute(app: FastifyInstance): Promise<void> {
  app.get('/lab/lighter-luxalgo', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=2');
    return render(getLang(req));
  });
}

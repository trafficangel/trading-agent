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
type PortfolioDataset = 'shadow' | 'real';
type ChartUnit = 'usd' | 'pct';

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
const LIVE_NOTIONAL_USD = 100;
const SIGNAL_PAGE_SIZE = 20;
const TRADE_PAGE_SIZE = 20;
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
// conservative 5% stop. STRAT-021 XRP passed the same audit (148 trades, both
// sides PF >2.1 before the stop, every chronological third positive). It is
// intentionally shadow-only: the independent Python real runner does not list
// it and must not do so until at least 20 prospective closes pass the gate.
// STRAT-022 BNB is shadow-only under the same rule; its full 180-trade log
// stayed positive in both halves and every chronological third after
// fixed-notional normalization. STRAT-023 is an independent two-sided BNB
// setup. After exact entry/exit-price normalization and a conservative 5%
// safety stop, its long and short books, both chronological halves and the
// portfolio without its five best trades all remained profitable. It is also
// shadow-only and is deliberately absent from the Python real runner.
// STRAT-024 DOGE is another independent two-sided shadow-only setup. With the
// same exact-price normalization and 5% safety stop, its long and short books,
// both chronological halves and every portfolio third remained profitable;
// the result also survived removing the five best trades. STRAT-025 and
// STRAT-026 are independent two-sided ADA setups; both sides and both
// chronological halves remained profitable after the same 5% stop model.
// STRAT-026 is explicitly borderline because its first long third was nearly
// flat (-0.74%), so it remains shadow-only. STRAT-027 POL also kept both sides,
// both halves and the portfolio excluding its five best trades profitable.
// STRAT-028 SUI and STRAT-029 SOL were added on 2026-07-30 after full
// fixed-notional normalization and adversarial 6/12 bps cost tests. Both are
// two-sided and shadow-only. SUI kept all five chronological folds positive
// even at 12 bps; SOL kept all five positive at 6 bps but one fold was
// negative at 12 bps, so it is explicitly the weaker secondary candidate.
// Neither strategy is present in the independent Python real runner.
// BCH, XLM, TRX and JUP candidates remain excluded.
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
  {
    id: 'xrp-choch-mf50',
    code: '021',
    name: 'CHoCH · Money Flow 50',
    symbol: 'XRPUSDT',
    asset: 'XRP',
    marketId: 7,
    stopPct: 5,
    backtest: {
      period: '2026-03-18 → 2026-05-25',
      trades: 148,
      winRatePct: 65.54,
      // Fixed $1,000 notional, with a conservative 5% safety stop applied
      // to the complete LuxAlgo trade log.
      profitFactor: 1.983,
      netPct: 45.956,
      maxDrawdownPct: 9.104,
    },
  },
  {
    id: 'bnb-fvgm-tc-hw',
    code: '022',
    name: 'FVG Mitigated · Trend Catcher · HyperWave',
    symbol: 'BNBUSDT',
    asset: 'BNB',
    marketId: 25,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 180,
      winRatePct: 53.33,
      // Fixed $1,000 notional, with the same conservative 5% safety stop.
      profitFactor: 1.499,
      netPct: 30.358,
      maxDrawdownPct: 7.132,
    },
  },
  {
    id: 'bnb-cntr-hw-weak',
    code: '023',
    name: 'Contrarian Normal · HyperWave · Weak Confluence',
    symbol: 'BNBUSDT',
    asset: 'BNB',
    marketId: 25,
    stopPct: 5,
    backtest: {
      period: '2026-03-17 → 2026-06-14',
      trades: 117,
      winRatePct: 69.23,
      profitFactor: 2.604,
      netPct: 39.514,
      maxDrawdownPct: 6.327,
    },
  },
  {
    id: 'doge-fvgm-smart-tc',
    code: '024',
    name: 'FVG Mitigated · Smart Trail · Trend Catcher',
    symbol: 'DOGEUSDT',
    asset: 'DOGE',
    marketId: 3,
    stopPct: 5,
    backtest: {
      period: '2026-03-17 → 2026-06-14',
      trades: 114,
      winRatePct: 57.89,
      profitFactor: 1.970,
      netPct: 57.126,
      maxDrawdownPct: 11.391,
    },
  },
  {
    id: 'ada-cntr-mf-hw',
    code: '025',
    name: 'Contrarian Normal · Money Flow · HyperWave',
    symbol: 'ADAUSDT',
    asset: 'ADA',
    marketId: 39,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-14',
      trades: 120,
      winRatePct: 70,
      profitFactor: 1.958,
      netPct: 54.485,
      maxDrawdownPct: 10.206,
    },
  },
  {
    id: 'ada-cfm-cntr-hw',
    code: '026',
    name: 'Confirmation Any · Contrarian · HyperWave',
    symbol: 'ADAUSDT',
    asset: 'ADA',
    marketId: 39,
    stopPct: 5,
    backtest: {
      period: '2026-03-17 → 2026-06-14',
      trades: 122,
      winRatePct: 60.66,
      profitFactor: 1.842,
      netPct: 47.333,
      maxDrawdownPct: 8.743,
    },
  },
  {
    id: 'pol-fvgm-neo-tsr',
    code: '027',
    name: 'FVG Mitigated · Neo Cloud · Trend Strength Ranging',
    symbol: 'POLUSDT',
    asset: 'POL',
    marketId: 14,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-14',
      trades: 120,
      winRatePct: 66.67,
      profitFactor: 1.680,
      netPct: 46.973,
      maxDrawdownPct: 10,
    },
  },
  {
    id: 'sui-ob-mf-hw',
    code: '028',
    name: 'OB Exited · Money Flow · HyperWave',
    symbol: 'SUIUSDT',
    asset: 'SUI',
    marketId: 16,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-15',
      trades: 239,
      winRatePct: 69.87,
      // Exact entry/exit normalization at fixed $1,000 notional. The raw
      // zero-fee result is used here; live shadow spread, slippage, and funding
      // are measured from Lighter L2 on every signal.
      profitFactor: 1.625,
      netPct: 80.038,
      maxDrawdownPct: 21.132,
    },
  },
  {
    id: 'sol-sts-tc-tsr',
    code: '029',
    name: 'Smart Trail Switch · Trend Catcher · Trend Strength Ranging',
    symbol: 'SOLUSDT',
    asset: 'SOL',
    marketId: 2,
    stopPct: 5,
    backtest: {
      period: '2026-04-07 → 2026-06-14',
      trades: 109,
      winRatePct: 46.79,
      // Exact entry/exit normalization at fixed $1,000 notional. This
      // candidate is intentionally secondary because one of five folds turns
      // negative under the 12 bps stress assumption.
      profitFactor: 1.644,
      netPct: 37.972,
      maxDrawdownPct: 8.581,
    },
  },
] as const;

const STRATEGY_BY_ID = new Map(STRATEGIES.map((spec) => [spec.id, spec]));
const STRATEGY_IDS = STRATEGIES.map((spec) => spec.id);
const SQL_MARKS = STRATEGIES.map(() => '?').join(', ');
const ASSET_LABEL = [...new Set(STRATEGIES.map((spec) => spec.asset))].join(' · ');
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
  shadow_entry_trade_id: number | null;
  shadow_entry_trade_status: 'open' | 'closed' | null;
  shadow_exit_trade_id: number | null;
  shadow_exit_trade_status: 'open' | 'closed' | null;
  live_entry_trade_id: number | null;
  live_entry_trade_status: 'opening' | 'open' | 'closing' | 'closed' | 'error' | null;
  live_exit_trade_id: number | null;
  live_exit_trade_status: 'opening' | 'open' | 'closing' | 'closed' | 'error' | null;
  live_decision: 'enter' | 'close' | 'skip' | 'error' | null;
  live_decision_reason: string | null;
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

type LiveStateRow = {
  enabled: number;
  last_signal_id: number | null;
  started_at: number | null;
  heartbeat_at: number | null;
  status: string;
  last_error: string | null;
  cumulative_net_usd: number;
  equity_peak_usd: number;
  current_drawdown_usd: number;
  max_drawdown_usd: number;
  portfolio_paused_at: number | null;
  portfolio_pause_reason: string | null;
};

type LiveTradeRow = {
  id: number;
  strategy_id: string;
  symbol: string;
  side: Side;
  entry_signal_id: number;
  exit_signal_id: number | null;
  opened_at: number;
  closed_at: number | null;
  requested_notional_usd: number;
  filled_notional_usd: number | null;
  leverage: number;
  quantity: number | null;
  entry_price: number | null;
  stop_pct: number;
  stop_price: number | null;
  exit_price: number | null;
  gross_pnl_usd: number | null;
  funding_pnl_usd: number;
  fee_usd: number;
  net_pnl_usd: number | null;
  net_pnl_pct: number | null;
  close_reason: string | null;
  status: string;
  error: string | null;
  entry_reference_source: number | null;
  entry_reference_l2: number | null;
  entry_slippage_pct: number | null;
  entry_book_age_ms: number | null;
  exit_reference_source: number | null;
  exit_reference_l2: number | null;
  exit_slippage_pct: number | null;
  entry_signal_received_at: number | null;
  entry_signal_captured_at: number | null;
  exit_signal_received_at: number | null;
  entry_started_at: number | null;
  entry_order_sent_at: number | null;
  entry_order_accepted_at: number | null;
  entry_position_seen_at: number | null;
  stop_order_sent_at: number | null;
  protected_at: number | null;
  exit_order_sent_at: number | null;
  exit_order_accepted_at: number | null;
  exit_position_gone_at: number | null;
  entry_fill_at: number | null;
  entry_fill_count: number | null;
  exit_fill_at: number | null;
  exit_fill_count: number | null;
};

type LiveStrategyStateRow = {
  strategy_id: string;
  enabled: number;
  closed_trades: number;
  net_pnl_usd: number;
  profit_factor: number | null;
  first_half_net_usd: number;
  second_half_net_usd: number;
  max_drawdown_usd: number;
  gate_status: 'collecting' | 'watch' | 'passed' | 'paused';
  paused_at: number | null;
  pause_reason: string | null;
  updated_at: number;
};

type LiveMetrics = {
  closed: number;
  wins: number;
  netUsd: number;
  netPct: number;
  profitFactor: number | null;
  firstHalfUsd: number;
  secondHalfUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
};

type LiveTradeCounts = {
  closed: number;
  open: number;
  errors: number;
};

type LiveDecisionCounts = {
  total: number;
  errors: number;
  skipped: number;
};

type ExecutionComparison = {
  matched: number;
  shadowPct: number;
  realPct: number;
  avgGapPct: number | null;
};

type LatencyMetrics = {
  measured: number;
  signalToOrderMs: number | null;
  orderToPositionMs: number | null;
  signalToProtectedMs: number | null;
};

type PnlPoint = {
  at: number;
  pnlUsd: number;
  pnlPct: number;
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

function recentSignals(
  limit: number,
  offset: number,
  strategyId: string | null = null,
): SignalRow[] {
  const where = strategyId ? 'signal.strategy_id = ?' : `signal.strategy_id IN (${SQL_MARKS})`;
  const strategyParams = strategyId ? [strategyId] : STRATEGY_IDS;
  return db.prepare<Array<string | number>, SignalRow>(`
    SELECT signal.id,signal.strategy_id,signal.symbol,signal.received_at,
           signal.captured_at,signal.action,signal.side,signal.source_price,
           signal.capture_status,signal.capture_error,signal.book_age_ms,
           signal.bid,signal.ask,signal.buy_vwap_1000,signal.sell_vwap_1000,
           signal.spread_pct,signal.buy_slippage_pct,signal.sell_slippage_pct,
           signal.funding_rate_pct_h,
           (SELECT id FROM lighter_lux_trades
            WHERE entry_signal_id=signal.id LIMIT 1) shadow_entry_trade_id,
           (SELECT CASE WHEN closed_at IS NULL THEN 'open' ELSE 'closed' END
            FROM lighter_lux_trades
            WHERE entry_signal_id=signal.id LIMIT 1) shadow_entry_trade_status,
           (SELECT id FROM lighter_lux_trades
            WHERE exit_signal_id=signal.id ORDER BY id LIMIT 1) shadow_exit_trade_id,
           (SELECT CASE WHEN closed_at IS NULL THEN 'open' ELSE 'closed' END
            FROM lighter_lux_trades
            WHERE exit_signal_id=signal.id ORDER BY id LIMIT 1) shadow_exit_trade_status,
           (SELECT id FROM lighter_lux_live_trades
            WHERE entry_signal_id=signal.id LIMIT 1) live_entry_trade_id,
           (SELECT status FROM lighter_lux_live_trades
            WHERE entry_signal_id=signal.id LIMIT 1) live_entry_trade_status,
           (SELECT id FROM lighter_lux_live_trades
            WHERE exit_signal_id=signal.id ORDER BY id LIMIT 1) live_exit_trade_id,
           (SELECT status FROM lighter_lux_live_trades
            WHERE exit_signal_id=signal.id ORDER BY id LIMIT 1) live_exit_trade_status,
           decision.decision live_decision,
           decision.reason live_decision_reason
    FROM lighter_lux_signals signal
    LEFT JOIN lighter_lux_live_decisions decision ON decision.signal_id=signal.id
    WHERE ${where}
    ORDER BY signal.received_at DESC
    LIMIT ? OFFSET ?`).all(...strategyParams, limit, offset);
}

function signalTotal(strategyId: string | null = null): number {
  const where = strategyId ? 'strategy_id = ?' : `strategy_id IN (${SQL_MARKS})`;
  const strategyParams = strategyId ? [strategyId] : STRATEGY_IDS;
  return db.prepare<string[], { total: number }>(`
    SELECT COUNT(*) total FROM lighter_lux_signals
    WHERE ${where}`).get(...strategyParams)?.total ?? 0;
}

function recentTrades(
  limit: number,
  offset: number,
  strategyId: string | null = null,
): TradeRow[] {
  const where = strategyId ? 'strategy_id = ?' : `strategy_id IN (${SQL_MARKS})`;
  const strategyParams = strategyId ? [strategyId] : STRATEGY_IDS;
  const rows = db.prepare<string[], TradeRow>(`
    SELECT id, strategy_id, symbol, side, entry_signal_id, exit_signal_id,
           opened_at, closed_at, entry_price, entry_funding_pct_h,
           exit_price, gross_pnl_pct,
           funding_pnl_pct, net_pnl_pct, notional_usd, close_reason,
           NULL cumulative_net_pct, NULL strategy_cumulative_net_pct
    FROM lighter_lux_trades
    WHERE ${where}
    ORDER BY opened_at, id`).all(...strategyParams);
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
  return rows.reverse().slice(offset, offset + limit);
}

function tradeTotal(strategyId: string | null = null): number {
  const where = strategyId ? 'strategy_id = ?' : `strategy_id IN (${SQL_MARKS})`;
  const strategyParams = strategyId ? [strategyId] : STRATEGY_IDS;
  return db.prepare<string[], { total: number }>(`
    SELECT COUNT(*) total FROM lighter_lux_trades
    WHERE ${where}`).get(...strategyParams)?.total ?? 0;
}

function lighterLiveState(): LiveStateRow | null {
  return db.prepare<[], LiveStateRow>(`
    SELECT enabled,last_signal_id,started_at,heartbeat_at,status,last_error,
           cumulative_net_usd,equity_peak_usd,current_drawdown_usd,
           max_drawdown_usd,portfolio_paused_at,portfolio_pause_reason
    FROM lighter_lux_live_state WHERE id=1`).get() ?? null;
}

function recentLiveTrades(
  limit = 30,
  strategyId: string | null = null,
): LiveTradeRow[] {
  const filter = strategyId ? 'WHERE real.strategy_id = ?' : '';
  const params: Array<string | number> = strategyId ? [strategyId, limit] : [limit];
  return db.prepare<Array<string | number>, LiveTradeRow>(`
    SELECT real.id,real.strategy_id,real.symbol,real.side,real.entry_signal_id,
           real.exit_signal_id,real.opened_at,real.closed_at,
           real.requested_notional_usd,real.filled_notional_usd,
           leverage,quantity,entry_price,stop_pct,stop_price,exit_price,
           gross_pnl_usd,funding_pnl_usd,fee_usd,net_pnl_usd,net_pnl_pct,
           close_reason,status,error,entry_reference_source,entry_reference_l2,
           entry_slippage_pct,entry_book_age_ms,exit_reference_source,
           exit_reference_l2,exit_slippage_pct,
           entry_signal.received_at entry_signal_received_at,
           entry_signal.captured_at entry_signal_captured_at,
           exit_signal.received_at exit_signal_received_at,
           entry_started_at,entry_order_sent_at,entry_order_accepted_at,
           entry_position_seen_at,stop_order_sent_at,protected_at,
           exit_order_sent_at,exit_order_accepted_at,exit_position_gone_at,
           entry_fill_at,entry_fill_count,exit_fill_at,exit_fill_count
    FROM lighter_lux_live_trades real
    JOIN lighter_lux_signals entry_signal ON entry_signal.id=real.entry_signal_id
    LEFT JOIN lighter_lux_signals exit_signal ON exit_signal.id=real.exit_signal_id
    ${filter}
    ORDER BY real.opened_at DESC,real.id DESC LIMIT ?`).all(...params);
}

function closedLiveTrades(): LiveTradeRow[] {
  return db.prepare<[], LiveTradeRow>(`
    SELECT real.id,real.strategy_id,real.symbol,real.side,real.entry_signal_id,
           real.exit_signal_id,real.opened_at,real.closed_at,
           real.requested_notional_usd,real.filled_notional_usd,
           leverage,quantity,entry_price,stop_pct,stop_price,exit_price,
           gross_pnl_usd,funding_pnl_usd,fee_usd,net_pnl_usd,net_pnl_pct,
           close_reason,status,error,entry_reference_source,entry_reference_l2,
           entry_slippage_pct,entry_book_age_ms,exit_reference_source,
           exit_reference_l2,exit_slippage_pct,
           entry_signal.received_at entry_signal_received_at,
           entry_signal.captured_at entry_signal_captured_at,
           exit_signal.received_at exit_signal_received_at,
           entry_started_at,entry_order_sent_at,entry_order_accepted_at,
           entry_position_seen_at,stop_order_sent_at,protected_at,
           exit_order_sent_at,exit_order_accepted_at,exit_position_gone_at,
           entry_fill_at,entry_fill_count,exit_fill_at,exit_fill_count
    FROM lighter_lux_live_trades real
    JOIN lighter_lux_signals entry_signal ON entry_signal.id=real.entry_signal_id
    LEFT JOIN lighter_lux_signals exit_signal ON exit_signal.id=real.exit_signal_id
    WHERE real.status='closed' AND real.net_pnl_usd IS NOT NULL
    ORDER BY real.closed_at,real.id`).all();
}

function liveTradeCounts(): LiveTradeCounts {
  return db.prepare<[], LiveTradeCounts>(`
    SELECT
      COALESCE(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END),0) closed,
      COALESCE(SUM(CASE WHEN status IN ('opening','open','closing') THEN 1 ELSE 0 END),0) open,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) errors
    FROM lighter_lux_live_trades`).get() ?? { closed: 0, open: 0, errors: 0 };
}

function liveDecisionCounts(): LiveDecisionCounts {
  return db.prepare<[], LiveDecisionCounts>(`
    SELECT
      COUNT(*) total,
      COALESCE(SUM(CASE WHEN decision='error' THEN 1 ELSE 0 END),0) errors,
      COALESCE(SUM(CASE WHEN decision='skip' THEN 1 ELSE 0 END),0) skipped
    FROM lighter_lux_live_decisions`).get() ?? { total: 0, errors: 0, skipped: 0 };
}

function liveStrategyStates(): LiveStrategyStateRow[] {
  return db.prepare<[], LiveStrategyStateRow>(`
    SELECT strategy_id,enabled,closed_trades,net_pnl_usd,profit_factor,
           first_half_net_usd,second_half_net_usd,max_drawdown_usd,
           gate_status,paused_at,pause_reason,updated_at
    FROM lighter_lux_live_strategy_state
    ORDER BY strategy_id`).all();
}

function liveMetrics(rows: LiveTradeRow[]): LiveMetrics {
  const pnl = rows.map((row) => row.net_pnl_usd ?? 0);
  const pnlPct = rows.map((row) => row.net_pnl_pct ?? 0);
  const grossWin = pnl.filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnl.filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  const split = Math.floor(pnl.length / 2);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  let equityPct = 0;
  let peakPct = 0;
  let maxDrawdownPct = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  for (const value of pnlPct) {
    equityPct += value;
    peakPct = Math.max(peakPct, equityPct);
    maxDrawdownPct = Math.max(maxDrawdownPct, peakPct - equityPct);
  }
  return {
    closed: pnl.length,
    wins: pnl.filter((value) => value > 0).length,
    netUsd: equity,
    netPct: equityPct,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : pnl.length ? Infinity : null,
    firstHalfUsd: pnl.slice(0, split).reduce((sum, value) => sum + value, 0),
    secondHalfUsd: pnl.slice(split).reduce((sum, value) => sum + value, 0),
    maxDrawdownUsd,
    maxDrawdownPct,
  };
}

function liveExecutionComparison(): ExecutionComparison {
  const rows = db.prepare<[], {
    shadow_pct: number;
    real_pct: number;
  }>(`
    SELECT shadow.net_pnl_pct shadow_pct,real.net_pnl_pct real_pct
    FROM lighter_lux_live_trades real
    JOIN lighter_lux_trades shadow
      ON shadow.entry_signal_id=real.entry_signal_id
    WHERE real.status='closed' AND real.net_pnl_pct IS NOT NULL
      AND shadow.closed_at IS NOT NULL AND shadow.net_pnl_pct IS NOT NULL
    ORDER BY real.closed_at,real.id`).all();
  const shadowPct = rows.reduce((sum, row) => sum + row.shadow_pct, 0);
  const realPct = rows.reduce((sum, row) => sum + row.real_pct, 0);
  return {
    matched: rows.length,
    shadowPct,
    realPct,
    avgGapPct: rows.length ? (realPct - shadowPct) / rows.length : null,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function liveLatencyMetrics(rows: LiveTradeRow[]): LatencyMetrics {
  const measured = rows.filter((row) => (
    row.entry_signal_received_at != null
    && row.entry_order_sent_at != null
    && row.entry_position_seen_at != null
    && row.protected_at != null
  ));
  return {
    measured: measured.length,
    signalToOrderMs: median(measured.map((row) => (
      row.entry_order_sent_at! - row.entry_signal_received_at!
    ))),
    orderToPositionMs: median(measured.map((row) => (
      row.entry_position_seen_at! - row.entry_order_sent_at!
    ))),
    signalToProtectedMs: median(measured.map((row) => (
      row.protected_at! - row.entry_signal_received_at!
    ))),
  };
}

function cumulativePnlSeries(): { shadow: PnlPoint[]; live: PnlPoint[] } {
  const shadowRows = db.prepare<string[], {
    closed_at: number;
    net_pnl_pct: number;
    notional_usd: number;
  }>(`
    SELECT closed_at,net_pnl_pct,notional_usd
    FROM lighter_lux_trades
    WHERE strategy_id IN (${SQL_MARKS})
      AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at,id`).all(...STRATEGY_IDS);
  const liveRows = db.prepare<[], {
    closed_at: number;
    net_pnl_usd: number;
    net_pnl_pct: number;
  }>(`
    SELECT closed_at,net_pnl_usd,net_pnl_pct
    FROM lighter_lux_live_trades
    WHERE status='closed' AND closed_at IS NOT NULL
      AND net_pnl_usd IS NOT NULL AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at,id`).all();

  const cumulative = <T>(
    rows: T[],
    at: (row: T) => number,
    pnlUsd: (row: T) => number,
    pnlPct: (row: T) => number,
  ): PnlPoint[] => {
    let totalUsd = 0;
    let totalPct = 0;
    return rows.map((row) => {
      totalUsd += pnlUsd(row);
      totalPct += pnlPct(row);
      return { at: at(row), pnlUsd: totalUsd, pnlPct: totalPct };
    });
  };

  return {
    shadow: cumulative(
      shadowRows,
      (row) => row.closed_at,
      (row) => row.net_pnl_pct / 100 * row.notional_usd,
      (row) => row.net_pnl_pct,
    ),
    live: cumulative(
      liveRows,
      (row) => row.closed_at,
      (row) => row.net_pnl_usd,
      (row) => row.net_pnl_pct,
    ),
  };
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
function latency(value: number | null): string {
  if (value == null || value < 0) return '—';
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(2)}s`;
}
function pfLabel(value: number | null): string {
  return value == null ? '—' : Number.isFinite(value) ? value.toFixed(2) : '∞';
}
function positivePage(value: unknown): number {
  const page = Number.parseInt(String(value ?? '1'), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}
function selectedStrategy(value: unknown): StrategySpec | null {
  return STRATEGY_BY_ID.get(String(value ?? '')) ?? null;
}
function selectedDataset(value: unknown): PortfolioDataset {
  return value === 'real' ? 'real' : 'shadow';
}
function selectedChartUnit(value: unknown): ChartUnit {
  return value === 'pct' ? 'pct' : 'usd';
}
function labHref(args: {
  signalsPage: number;
  tradesPage: number;
  strategyId: string | null;
  dataset: PortfolioDataset;
  chartUnit: ChartUnit;
  anchor?: string;
}): string {
  const params = new URLSearchParams({
    signalsPage: String(args.signalsPage),
    tradesPage: String(args.tradesPage),
    dataset: args.dataset,
    chart: args.chartUnit,
  });
  if (args.strategyId) params.set('strategy', args.strategyId);
  return `/lab/lighter-luxalgo?${params.toString()}${args.anchor ? `#${args.anchor}` : ''}`;
}
function pager(args: {
  lang: Lang;
  page: number;
  total: number;
  pageSize: number;
  signalsPage: number;
  tradesPage: number;
  target: 'signals' | 'trades';
  strategyId: string | null;
  dataset: PortfolioDataset;
  chartUnit: ChartUnit;
}): string {
  const pages = Math.max(1, Math.ceil(args.total / args.pageSize));
  const from = args.total ? (args.page - 1) * args.pageSize + 1 : 0;
  const to = Math.min(args.total, args.page * args.pageSize);
  const href = (page: number): string => {
    const signalsPage = args.target === 'signals' ? page : args.signalsPage;
    const tradesPage = args.target === 'trades' ? page : args.tradesPage;
    return labHref({
      signalsPage,
      tradesPage,
      strategyId: args.strategyId,
      dataset: args.dataset,
      chartUnit: args.chartUnit,
      anchor: args.target === 'signals' ? 'signal-history' : 'shadow-trades',
    });
  };
  const first = Math.max(1, Math.min(args.page - 2, pages - 4));
  const last = Math.min(pages, first + 4);
  const numbers = Array.from({ length: last - first + 1 }, (_, index) => first + index)
    .map((page) => page === args.page
      ? `<span class="active">${page}</span>`
      : `<a href="${href(page)}">${page}</a>`)
    .join('');
  return `<div class="ll-pager">
    <small>${from}–${to} ${t(args.lang, 'из', 'of')} ${args.total}</small>
    <nav>
      ${args.page > 1 ? `<a href="${href(args.page - 1)}" aria-label="${t(args.lang, 'Предыдущая страница', 'Previous page')}">←</a>` : '<span class="disabled">←</span>'}
      ${numbers}
      ${args.page < pages ? `<a href="${href(args.page + 1)}" aria-label="${t(args.lang, 'Следующая страница', 'Next page')}">→</a>` : '<span class="disabled">→</span>'}
    </nav>
  </div>`;
}

export const LIGHTER_LUXALGO_CSS = `
.ll-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:0 0 14px;padding:17px 20px;border:1px solid rgba(163,106,255,.36);border-radius:14px;background:linear-gradient(135deg,rgba(122,71,255,.15),var(--bg-card));color:var(--text);text-decoration:none}
.ll-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(163,106,255,.15);color:#bd91ff;font-size:11px;font-weight:750;letter-spacing:.04em}
.ll-title{font-size:19px;font-weight:700;margin-top:8px}.ll-sub{font-size:13px;color:var(--text-dim);margin-top:3px}
.ll-stats{display:flex;gap:22px}.ll-stats span{display:grid;text-align:right}.ll-stats b{font-size:18px}.ll-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}
.ll-stats .pos,.ll-card .pos,.pos{color:#38d996}.ll-stats .neg,.ll-card .neg,.neg{color:#ff6577}
.ll-wrap{max-width:1440px;margin:0 auto}.ll-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}
.ll-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.ll-head h1{font-size:34px;margin:10px 0 7px}.ll-head p{max-width:860px;color:var(--text-dim)}
.ll-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.ll-engine i{width:8px;height:8px;border-radius:50%;background:#ff6577}.ll-engine.live i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}
.ll-modebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:18px 0 0;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}.ll-modebar>div{display:grid;gap:4px}.ll-modebar small{color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-tabs{display:flex;align-items:center;gap:5px}.ll-tabs a{display:grid;place-items:center;min-width:82px;height:31px;padding:0 11px;border:1px solid var(--border);border-radius:8px;color:var(--text-dim);font-size:10px;font-weight:750;text-decoration:none}.ll-tabs a:hover{border-color:#bd91ff;color:var(--text)}.ll-tabs a.active{border-color:rgba(163,106,255,.58);background:rgba(163,106,255,.16);color:#bd91ff}.ll-tabs a.real.active{border-color:rgba(56,217,150,.5);background:rgba(56,217,150,.12);color:#38d996}
.ll-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.ll-card,.ll-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.ll-card{padding:13px 14px;display:grid;gap:4px}.ll-card small,.ll-card em{color:var(--text-faint);font-size:10px;font-style:normal}.ll-card b{font-size:20px;font-variant-numeric:tabular-nums}
.ll-panel{padding:15px;margin:10px 0}.ll-panel h2{font-size:16px;margin:0 0 11px}
.ll-filter{display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:10px 0;padding:11px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}.ll-filter label{display:grid;gap:5px;color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-filter select{min-width:285px;height:34px;padding:0 32px 0 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:11px}.ll-filter button{height:34px;padding:0 13px;border:1px solid rgba(163,106,255,.5);border-radius:8px;background:rgba(163,106,255,.14);color:#bd91ff;font:inherit;font-size:10px;font-weight:700;cursor:pointer}.ll-filter small{color:var(--text-faint);font-size:10px}
.ll-signal-list{border:1px solid var(--border);border-radius:10px;overflow:hidden}.ll-signal-row{display:grid;grid-template-columns:minmax(120px,1.1fr) 92px 118px 120px 120px;align-items:center;gap:10px;min-height:38px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:11px}.ll-signal-row:last-child{border-bottom:0}.ll-signal-row:hover{background:rgba(255,255,255,.018)}.ll-signal-labels{min-height:30px;color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-signal-strategy b{font-size:11px}.ll-signal-time{color:var(--text-faint);font-variant-numeric:tabular-nums}.ll-signal-event{font-weight:760}.ll-signal-value{font-variant-numeric:tabular-nums}
.ll-live{display:inline-block;margin-left:5px;padding:2px 5px;border-radius:999px;background:rgba(56,217,150,.12);color:#38d996;font-size:9px;letter-spacing:.04em}
.ll-table{width:100%;overflow:hidden}.ll-table table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}.ll-table th,.ll-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);white-space:normal;overflow-wrap:anywhere;vertical-align:middle}.ll-table th{color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.025em}.ll-table small{color:var(--text-faint);font-size:9px}.ll-table .num{font-variant-numeric:tabular-nums}
.ll-strategy-table{font-size:10px!important}.ll-strategy-table th,.ll-strategy-table td{padding:9px 6px!important;white-space:nowrap!important;overflow-wrap:normal!important;overflow:hidden;text-overflow:clip}.ll-strategy-table small{display:inline;font-size:8px}.ll-strategy-table th:nth-child(1){width:24%}.ll-strategy-table th:nth-child(2){width:7%}.ll-strategy-table th:nth-child(3){width:20%}.ll-strategy-table th:nth-child(4){width:14%}.ll-strategy-table th:nth-child(5){width:11%}.ll-strategy-table th:nth-child(6){width:12%}.ll-strategy-table th:nth-child(7){width:12%}
.ll-signal-table{font-size:9px!important}.ll-signal-table th,.ll-signal-table td{padding:7px 6px!important;white-space:nowrap!important;overflow-wrap:normal!important;overflow:hidden;text-overflow:clip}.ll-signal-table small{display:inline;font-size:8px}.ll-signal-table th:nth-child(1){width:14%}.ll-signal-table th:nth-child(2){width:6%}.ll-signal-table th:nth-child(3){width:15%}.ll-signal-table th:nth-child(4){width:11%}.ll-signal-table th:nth-child(5){width:20%}.ll-signal-table th:nth-child(6){width:18%}.ll-signal-table th:nth-child(7){width:16%}.ll-signal-table td:nth-child(7){white-space:normal!important;line-height:1.35}.ll-signal-table td:nth-child(2){font-weight:750;font-variant-numeric:tabular-nums}.ll-signal-table .ll-trade-ref{display:inline;white-space:nowrap;font-variant-numeric:tabular-nums}.ll-signal-status{display:inline-block;padding:2px 6px;border-radius:999px;font-size:9px;font-weight:800;letter-spacing:.025em;white-space:nowrap}.ll-signal-status.work{background:rgba(56,217,150,.12);color:#38d996}.ll-signal-status.done{background:rgba(92,163,255,.12);color:#76adff}.ll-signal-status.skip{background:rgba(255,190,92,.12);color:#ffc56e}.ll-signal-status.shadow{background:rgba(163,106,255,.13);color:#bd91ff}.ll-signal-status.error{background:rgba(255,101,119,.12);color:#ff6577}.ll-signal-status.wait{background:rgba(255,255,255,.06);color:var(--text-dim)}
.ll-trades th:nth-child(1){width:14%}.ll-trades th:nth-child(2){width:21%}.ll-trades th:nth-child(3){width:9%}.ll-trades th:nth-child(4){width:12%}.ll-trades th:nth-child(5){width:13%}.ll-trades th:nth-child(6){width:11%}.ll-trades th:nth-child(7){width:8%}.ll-trades th:nth-child(8){width:12%}
.ll-shadow-trades,.ll-live-trades{font-size:10px!important}.ll-shadow-trades th,.ll-shadow-trades td,.ll-live-trades th,.ll-live-trades td{padding:9px 6px!important;white-space:nowrap!important;overflow-wrap:normal!important;overflow:hidden;text-overflow:clip}.ll-shadow-trades small,.ll-live-trades small{display:inline;font-size:8px}.ll-shadow-trades th:nth-child(1),.ll-live-trades th:nth-child(1){width:16%}.ll-shadow-trades th:nth-child(2),.ll-live-trades th:nth-child(2){width:21%}.ll-shadow-trades th:nth-child(3),.ll-live-trades th:nth-child(3){width:9%}.ll-shadow-trades th:nth-child(4),.ll-live-trades th:nth-child(4){width:11%}.ll-shadow-trades th:nth-child(5),.ll-live-trades th:nth-child(5){width:12%}.ll-shadow-trades th:nth-child(6),.ll-live-trades th:nth-child(6){width:10%}.ll-shadow-trades th:nth-child(7),.ll-live-trades th:nth-child(7){width:7%}.ll-shadow-trades th:nth-child(8),.ll-live-trades th:nth-child(8){width:14%}
.ll-tech th:nth-child(1){width:20%}.ll-tech th:nth-child(2){width:18%}.ll-tech th:nth-child(3){width:15%}.ll-tech th:nth-child(4){width:18%}.ll-tech th:nth-child(5){width:29%}
.ll-note{font-size:11px;color:var(--text-faint);line-height:1.45}.ll-empty{padding:18px;text-align:center;color:var(--text-faint)}.collect{color:#bd91ff}.pass{color:#38d996}.fail{color:#ff6577}
.ll-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:11px}.ll-pager>small{color:var(--text-faint);font-size:10px}.ll-pager nav{display:flex;align-items:center;gap:5px}.ll-pager a,.ll-pager nav>span{display:grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border:1px solid var(--border);border-radius:7px;color:var(--text-dim);font-size:10px;text-decoration:none}.ll-pager a:hover{border-color:#bd91ff;color:var(--text)}.ll-pager .active{border-color:rgba(163,106,255,.55);background:rgba(163,106,255,.16);color:#bd91ff;font-weight:700}.ll-pager .disabled{opacity:.35}
.ll-details{padding:0}.ll-details>summary{cursor:pointer;list-style:none;padding:14px 15px;font-size:15px;font-weight:700}.ll-details>summary::-webkit-details-marker{display:none}.ll-details>summary::after{content:'＋';float:right;color:var(--text-faint)}.ll-details[open]>summary::after{content:'−'}.ll-details[open]>.ll-table{padding:0 15px 14px}
.ll-chart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.ll-chart-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px}.ll-chart-legend span{display:flex;align-items:center;gap:6px;color:var(--text-dim)}.ll-chart-legend i{width:18px;height:3px;border-radius:2px}.ll-chart-legend .shadow i{background:#a36aff}.ll-chart-legend .real i{background:#38d996}.ll-chart-legend b{font-variant-numeric:tabular-nums}.ll-chart{width:100%;margin-top:8px;overflow:hidden}.ll-chart svg{display:block;width:100%;height:auto;min-height:190px}.ll-chart-grid{stroke:rgba(255,255,255,.075);stroke-width:1}.ll-chart-zero{stroke:rgba(255,255,255,.24);stroke-width:1}.ll-chart-axis{fill:var(--text-faint);font-size:10px;font-family:inherit}.ll-chart-shadow{fill:none;stroke:#a36aff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.ll-chart-real{fill:none;stroke:#38d996;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.ll-chart-dot-shadow{fill:#a36aff}.ll-chart-dot-real{fill:#38d996}.ll-chart-empty{display:grid;place-items:center;min-height:170px;color:var(--text-faint);font-size:12px}
.ll-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin:12px 0}.ll-live-metric{padding:10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.015);display:grid;gap:3px}.ll-live-metric small{font-size:9px;color:var(--text-faint);text-transform:uppercase}.ll-live-metric b{font-size:15px;font-variant-numeric:tabular-nums}.ll-live-metric em{font-size:9px;color:var(--text-faint);font-style:normal}.ll-live-strategy th:nth-child(1){width:25%}.ll-live-strategy th:nth-child(2){width:11%}.ll-live-strategy th:nth-child(3){width:10%}.ll-live-strategy th:nth-child(4){width:12%}.ll-live-strategy th:nth-child(5){width:12%}.ll-live-strategy th:nth-child(6){width:18%}.ll-live-strategy th:nth-child(7){width:12%}
@media(max-width:760px){.ll-stats{width:100%;justify-content:space-between;gap:8px}.ll-grid{grid-template-columns:repeat(2,1fr)}.ll-live-grid{grid-template-columns:repeat(2,1fr)}.ll-head{display:block}.ll-engine{margin-top:10px;width:max-content}.ll-modebar{align-items:stretch}.ll-modebar>div{width:100%}.ll-tabs a{flex:1}.ll-filter{align-items:stretch}.ll-filter label,.ll-filter select{width:100%;min-width:0}.ll-signal-labels{display:none}.ll-signal-row{grid-template-columns:1fr auto;gap:3px 10px;padding:8px 10px}.ll-signal-row>span:nth-child(n+3){font-size:10px}.ll-table table{font-size:10px}.ll-table th,.ll-table td{padding:6px 4px}.ll-strategy-table th:nth-child(3),.ll-strategy-table td:nth-child(3),.ll-strategy-table th:nth-child(6),.ll-strategy-table td:nth-child(6){display:none}.ll-signal-table th:nth-child(3),.ll-signal-table td:nth-child(3){display:none}.ll-signal-table th:nth-child(1){width:17%}.ll-signal-table th:nth-child(2){width:9%}.ll-signal-table th:nth-child(4){width:17%}.ll-signal-table th:nth-child(5){width:17%}.ll-signal-table th:nth-child(6){width:16%}.ll-signal-table th:nth-child(7){width:24%}.ll-trades th:nth-child(3),.ll-trades td:nth-child(3){display:none}.ll-shadow-trades th:nth-child(1){width:16%}.ll-shadow-trades th:nth-child(2){width:19%}.ll-shadow-trades th:nth-child(4){width:12%}.ll-shadow-trades th:nth-child(5){width:14%}.ll-shadow-trades th:nth-child(6){width:11%}.ll-shadow-trades th:nth-child(7){width:8%}.ll-shadow-trades th:nth-child(8){width:20%}.ll-live-strategy th:nth-child(5),.ll-live-strategy td:nth-child(5),.ll-live-strategy th:nth-child(6),.ll-live-strategy td:nth-child(6){display:none}}`;

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
      <td><b>STRAT-${spec.code} · ${spec.asset}</b><small> · ${esc(spec.name)}</small></td>
      <td class="${'error' in feed ? 'neg' : 'pos'}">${'error' in feed ? 'OFF' : 'LIVE'}</td>
      <td class="num"><b>${spec.backtest.trades} · ${spec.backtest.winRatePct.toFixed(1)}% · ${spec.backtest.profitFactor.toFixed(2)}</b><small> · ${signedPct(spec.backtest.netPct)} · SL ${spec.stopPct.toFixed(1)}%</small></td>
      <td class="num"><b>${s.closed} / ${s.open}</b><small> · WR ${wr == null ? '—' : `${wr.toFixed(0)}%`} · PF ${pfLabel(s.profitFactor)}</small></td>
      <td class="${pnlClass(s.netPct)}"><b>${signedPct(s.netPct)} · ${signedUsd(s.netUsd)}</b></td>
      <td class="num">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}<small> · ½ ${signedPct(s.firstHalfPct)} · ½ ${signedPct(s.secondHalfPct)}</small></td>
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
  if (!rows.length) return `<tr><td colspan="8" class="ll-empty">${t(lang, 'Lighter-shadow сделок пока нет.', 'No Lighter shadow trades yet.')}</td></tr>`;
  return rows.map((row) => {
    const spec = STRATEGY_BY_ID.get(row.strategy_id);
    const mark = openTradeMark(row);
    const net = row.net_pnl_pct ?? mark?.netPct ?? 0;
    const stopPct = spec?.stopPct ?? null;
    const stopPrice = stopPct == null
      ? null
      : row.side === 'long'
        ? row.entry_price * (1 - stopPct / 100)
        : row.entry_price * (1 + stopPct / 100);
    const complete = row.net_pnl_pct != null;
    return `<tr>
      <td><b>${spec ? `STRAT-${spec.code}` : esc(row.strategy_id)} · ${esc(row.symbol)}</b><small> · #${row.id} · S${row.entry_signal_id}→${row.exit_signal_id ?? '—'}</small></td>
      <td class="num">${utcShort(row.opened_at)} → ${utcShort(row.closed_at)}<small> · ${held(row.opened_at, row.closed_at)}</small></td>
      <td><b>${row.side.toUpperCase()}</b><small> · $${row.notional_usd.toFixed(0)}</small></td>
      <td class="num">${row.entry_price.toFixed(5)}</td>
      <td class="num"><b>${stopPct == null ? '—' : `${stopPct.toFixed(1)}%`}</b><small> · ${stopPrice?.toFixed(5) ?? '—'}</small></td>
      <td class="num">${row.closed_at == null ? '—' : (row.exit_price?.toFixed(5) ?? '—')}</td>
      <td>${row.closed_at == null ? '<span class="ll-live">LIVE</span>' : `<span>${t(lang, 'ЗАКРЫТА', 'CLOSED')}</span>`}</td>
      <td class="${pnlClass(net)}"><b>${complete || mark ? `${signedPct(net)} · ${signedUsd(net / 100 * row.notional_usd)}` : (row.closed_at == null ? t(lang, 'ожидаем L2', 'waiting for L2') : t(lang, 'неполные данные', 'incomplete'))}</b></td>
    </tr>`;
  }).join('');
}

function liveTradeRows(rows: LiveTradeRow[], lang: Lang): string {
  if (!rows.length) return `<tr><td colspan="8" class="ll-empty">${t(lang, 'Live-canary вооружён и ждёт следующий новый сигнал.', 'Live canary is armed and waiting for the next new signal.')}</td></tr>`;
  return rows.map((row) => {
    const spec = STRATEGY_BY_ID.get(row.strategy_id);
    let liveNetUsd: number | null = null;
    let liveNetPct: number | null = null;
    if (
      row.status === 'open'
      && spec
      && row.entry_price != null
      && row.quantity != null
    ) {
      const snap = executionSnapshot(spec);
      if (!('error' in snap)) {
        const mark = row.side === 'long' ? snap.sellVwap : snap.buyVwap;
        liveNetUsd = (row.side === 'long' ? 1 : -1)
          * (mark - row.entry_price) * row.quantity;
        const base = row.filled_notional_usd ?? row.requested_notional_usd;
        liveNetPct = base > 0 ? liveNetUsd / base * 100 : 0;
      }
    }
    const netUsd = row.net_pnl_usd ?? liveNetUsd;
    const netPct = row.net_pnl_pct ?? liveNetPct;
    const isLive = ['opening', 'open', 'closing'].includes(row.status);
    return `<tr>
      <td><b>${spec ? `STRAT-${spec.code}` : esc(row.strategy_id)} · ${esc(row.symbol)}</b><small> · #R${row.id} · S${row.entry_signal_id}→${row.exit_signal_id ?? '—'}</small></td>
      <td class="num">${utcShort(row.opened_at)} → ${utcShort(row.closed_at)}<small> · ${held(row.opened_at, row.closed_at)}</small></td>
      <td><b>${row.side.toUpperCase()}</b><small> · $${(row.filled_notional_usd ?? row.requested_notional_usd).toFixed(2)} · ${row.leverage}x</small></td>
      <td class="num">${row.entry_price?.toFixed(5) ?? '—'}</td>
      <td class="num"><b>${row.stop_pct.toFixed(1)}%</b><small> · ${row.stop_price?.toFixed(5) ?? '—'}</small></td>
      <td class="num">${row.closed_at == null ? '—' : (row.exit_price?.toFixed(5) ?? '—')}</td>
      <td>${isLive ? '<span class="ll-live">LIVE</span>' : row.status === 'closed' ? t(lang, 'ЗАКРЫТА', 'CLOSED') : `<span class="neg">${t(lang, 'ОШИБКА', 'ERROR')}</span>`}</td>
      <td class="${netUsd == null ? '' : pnlClass(netUsd)}"><b>${netUsd == null || netPct == null ? '—' : `${signedPct(netPct)} · ${signedUsd(netUsd)}`}</b></td>
    </tr>`;
  }).join('');
}

function liveStrategyRows(rows: LiveStrategyStateRow[], lang: Lang): string {
  const byId = new Map(rows.map((row) => [row.strategy_id, row]));
  return STRATEGIES.map((spec) => {
    const row = byId.get(spec.id);
    if (!row) {
      return `<tr><td><b>STRAT-${spec.code} · ${spec.asset}</b></td><td class="collect">${t(lang, 'ОЖИДАНИЕ', 'WAITING')}</td><td>0</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
    }
    const status = row.gate_status === 'passed'
      ? t(lang, 'ПРОШЛА', 'PASSED')
      : row.gate_status === 'paused'
        ? t(lang, 'ПАУЗА', 'PAUSED')
        : row.gate_status === 'watch'
          ? t(lang, 'НАБЛЮДЕНИЕ', 'WATCH')
          : `${t(lang, 'КОПИМ', 'COLLECTING')} ${row.closed_trades}/20`;
    const statusClass = row.gate_status === 'passed'
      ? 'pass'
      : row.gate_status === 'paused'
        ? 'fail'
        : 'collect';
    const pf = row.profit_factor == null
      ? row.closed_trades > 0 && row.net_pnl_usd > 0 ? '∞' : '—'
      : row.profit_factor.toFixed(2);
    return `<tr>
      <td><b>STRAT-${spec.code} · ${spec.asset}</b><br><small>${esc(spec.name)}</small></td>
      <td class="${statusClass}"><b>${status}</b>${row.pause_reason ? `<br><small>${esc(row.pause_reason)}</small>` : ''}</td>
      <td class="num">${row.closed_trades}</td>
      <td class="${pnlClass(row.net_pnl_usd)}"><b>${signedUsd(row.net_pnl_usd)}</b></td>
      <td class="num">${pf}</td>
      <td class="num">${signedUsd(row.first_half_net_usd)} / ${signedUsd(row.second_half_net_usd)}</td>
      <td class="num">−${row.max_drawdown_usd.toFixed(2)}</td>
    </tr>`;
  }).join('');
}

function linkedTrade(
  id: number | null,
  status: SignalRow['shadow_entry_trade_status'] | SignalRow['live_entry_trade_status'],
  real: boolean,
  lang: Lang,
): string {
  if (id == null) return '<span class="ll-trade-ref">—</span>';
  const label = status === 'closed'
    ? t(lang, 'отработана', 'completed')
    : status === 'error'
      ? t(lang, 'ошибка', 'error')
      : t(lang, 'в работе', 'active');
  const statusClass = status === 'closed' ? 'done' : status === 'error' ? 'error' : 'work';
  return `<span class="ll-trade-ref"><b>#${real ? 'R' : ''}${id}</b> · <span class="${statusClass}">${label}</span></span>`;
}

function skipReason(reason: string | null, lang: Lang): string {
  if (!reason) return t(lang, 'Real-сделка не создана', 'No real trade created');
  if (/^global slot occupied by (.+)$/.test(reason)) return '';
  if (reason === 'live disabled') return t(lang, 'Реальная торговля выключена', 'Live trading is disabled');
  if (reason === 'strategy exit without open live trade')
    return t(lang, 'Нет открытой Real-сделки для выхода', 'No open real trade to exit');
  return reason;
}

function signalLifecycle(
  row: SignalRow,
  lang: Lang,
): { label: string; css: string; detail: string } {
  const liveStatuses = [row.live_entry_trade_status, row.live_exit_trade_status]
    .filter((status): status is NonNullable<typeof status> => status != null);
  const detail = '';
  if (row.capture_status !== 'captured') {
    return {
      label: t(lang, 'ОШИБКА ДАННЫХ', 'DATA ERROR'),
      css: 'error',
      detail: row.capture_error ?? row.capture_status,
    };
  }
  if (row.live_decision === 'error' || liveStatuses.includes('error')) {
    return {
      label: t(lang, 'ОШИБКА', 'ERROR'),
      css: 'error',
      detail: row.live_decision_reason ?? detail,
    };
  }
  if (
    row.live_decision === 'skip'
    && row.live_decision_reason?.trim().toLowerCase() === 'strategy not live-enabled'
  ) {
    return {
      label: t(lang, 'ТОЛЬКО SHADOW', 'SHADOW ONLY'),
      css: 'shadow',
      detail: '',
    };
  }
  if (row.live_decision === 'skip') {
    return {
      label: t(lang, 'ПРОПУЩЕН', 'SKIPPED'),
      css: 'skip',
      detail: skipReason(row.live_decision_reason, lang),
    };
  }
  if (liveStatuses.some((status) => status === 'opening' || status === 'open' || status === 'closing')) {
    return { label: t(lang, 'В РАБОТЕ', 'ACTIVE'), css: 'work', detail };
  }
  if (liveStatuses.includes('closed')) {
    return { label: t(lang, 'ОТРАБОТАН', 'COMPLETED'), css: 'done', detail };
  }
  if (row.live_decision === 'enter' || row.live_decision === 'close') {
    return { label: t(lang, 'ОБРАБОТКА', 'PROCESSING'), css: 'wait', detail };
  }
  if (row.shadow_entry_trade_id != null || row.shadow_exit_trade_id != null) {
    return {
      label: t(lang, 'ТОЛЬКО SHADOW', 'SHADOW ONLY'),
      css: 'shadow',
      detail: '',
    };
  }
  return { label: t(lang, 'БЕЗ СДЕЛКИ', 'NO TRADE'), css: 'wait', detail };
}

function signalRows(rows: SignalRow[], lang: Lang): string {
  if (!rows.length) return `<tr><td colspan="7" class="ll-empty">${t(lang, 'Ждём первый alert.', 'Waiting for the first alert.')}</td></tr>`;
  return rows.map((row) => {
    const spec = STRATEGY_BY_ID.get(row.strategy_id);
    const shadowRefs = [
      row.shadow_exit_trade_id != null
        ? linkedTrade(row.shadow_exit_trade_id, row.shadow_exit_trade_status, false, lang)
        : '',
      row.shadow_entry_trade_id != null && row.shadow_entry_trade_id !== row.shadow_exit_trade_id
        ? linkedTrade(row.shadow_entry_trade_id, row.shadow_entry_trade_status, false, lang)
        : '',
    ].filter(Boolean).join(' · ') || '—';
    const liveRefs = [
      row.live_exit_trade_id != null
        ? linkedTrade(row.live_exit_trade_id, row.live_exit_trade_status, true, lang)
        : '',
      row.live_entry_trade_id != null && row.live_entry_trade_id !== row.live_exit_trade_id
        ? linkedTrade(row.live_entry_trade_id, row.live_entry_trade_status, true, lang)
        : '',
    ].filter(Boolean).join(' · ') || '—';
    const lifecycle = signalLifecycle(row, lang);
    return `<tr>
      <td><b>${spec ? `STRAT-${spec.code}` : esc(row.strategy_id)}</b><small> · ${esc(row.symbol)}</small></td>
      <td>#${row.id}</td>
      <td>${utc(row.received_at)}</td>
      <td class="${row.side === 'long' ? 'pos' : 'neg'}"><b>${row.action.toUpperCase()} · ${row.side.toUpperCase()}</b></td>
      <td>${shadowRefs}</td>
      <td>${liveRefs}</td>
      <td><span class="ll-signal-status ${lifecycle.css}">${lifecycle.label}</span>${lifecycle.detail ? `<small> · ${esc(lifecycle.detail)}</small>` : ''}</td>
    </tr>`;
  }).join('');
}

function pnlChart(
  lang: Lang,
  dataset: PortfolioDataset,
  unit: ChartUnit,
): string {
  const series = cumulativePnlSeries();
  const points = dataset === 'shadow' ? series.shadow : series.live;
  const netUsd = points.at(-1)?.pnlUsd ?? 0;
  const netPct = points.at(-1)?.pnlPct ?? 0;
  const datasetLabel = dataset === 'shadow' ? 'Shadow · $1,000' : 'Real · $100';
  const unitLabel = unit === 'usd'
    ? t(lang, 'Деньги, $', 'Money, $')
    : t(lang, 'Проценты, %', 'Percent, %');
  const legend = `<div class="ll-chart-legend">
    <span class="${dataset}"><i></i>${datasetLabel} <b class="${pnlClass(netPct)}">${signedUsd(netUsd)} · ${signedPct(netPct)}</b></span>
  </div>`;
  if (!points.length) {
    return `<div class="ll-panel" id="pnl-chart"><div class="ll-chart-head"><h2>${t(lang, 'Накопленный PnL', 'Cumulative PnL')} · ${datasetLabel} · ${unitLabel}</h2>${legend}</div>
      <div class="ll-chart-empty">${t(lang, 'График появится после первой закрытой сделки.', 'The chart will appear after the first closed trade.')}</div></div>`;
  }

  const width = 1120;
  const height = 260;
  const left = 92;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const firstAt = Math.min(...points.map((point) => point.at));
  const lastAt = Math.max(...points.map((point) => point.at));
  const timeSpan = Math.max(1, lastAt - firstAt);
  const pointValue = (point: PnlPoint): number =>
    unit === 'usd' ? point.pnlUsd : point.pnlPct;
  const values = [0, ...points.map(pointValue)];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(unit === 'usd' ? 0.5 : 0.1, (rawMax - rawMin) * 0.12);
  const minPnl = rawMin - padding;
  const maxPnl = rawMax + padding;
  const pnlSpan = Math.max(unit === 'usd' ? 1 : 0.2, maxPnl - minPnl);
  const x = (at: number): number => left + (at - firstAt) / timeSpan * plotWidth;
  const y = (value: number): number =>
    top + (maxPnl - value) / pnlSpan * plotHeight;
  const path = (): string => {
    const start = `${left.toFixed(1)},${y(0).toFixed(1)}`;
    return [start, ...points.map((point) => `${x(point.at).toFixed(1)},${y(pointValue(point)).toFixed(1)}`)].join(' ');
  };
  const circles = (cls: string): string => points.map((point) =>
    `<circle class="${cls}" cx="${x(point.at).toFixed(1)}" cy="${y(pointValue(point)).toFixed(1)}" r="3"><title>${utc(point.at)} · ${signedUsd(point.pnlUsd)} · ${signedPct(point.pnlPct)}</title></circle>`,
  ).join('');
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = maxPnl - index / 4 * pnlSpan;
    const pos = top + index / 4 * plotHeight;
    const axisX = left - 8;
    const label = unit === 'usd'
      ? signedUsd(value)
      : `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(3)}%`;
    return `<line class="${Math.abs(value) < pnlSpan / 100 ? 'll-chart-zero' : 'll-chart-grid'}" x1="${left}" y1="${pos.toFixed(1)}" x2="${width - right}" y2="${pos.toFixed(1)}"/>
      <text class="ll-chart-axis" x="${axisX}" y="${(pos + 3).toFixed(1)}" text-anchor="end">${label}</text>`;
  }).join('');
  const xTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    const at = firstAt + timeSpan * ratio;
    const pos = left + plotWidth * ratio;
    const date = new Date(at);
    const label = `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
    return `<text class="ll-chart-axis" x="${pos.toFixed(1)}" y="${height - 10}" text-anchor="${index === 0 ? 'start' : index === 3 ? 'end' : 'middle'}">${label}</text>`;
  }).join('');

  const lineClass = dataset === 'shadow' ? 'll-chart-shadow' : 'll-chart-real';
  const dotClass = dataset === 'shadow' ? 'll-chart-dot-shadow' : 'll-chart-dot-real';
  return `<div class="ll-panel" id="pnl-chart"><div class="ll-chart-head"><div><h2>${t(lang, 'Накопленный PnL', 'Cumulative PnL')} · ${datasetLabel} · ${unitLabel}</h2>
      <p class="ll-note">${t(lang, 'Только закрытые сделки; открытый плавающий результат не включён.', 'Closed trades only; unrealized PnL is excluded.')}</p></div>${legend}</div>
    <div class="ll-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${t(lang, 'График накопленного PnL', 'Cumulative PnL chart')}">
      ${yTicks}${xTicks}
      <polyline class="${lineClass}" points="${path()}"/>${circles(dotClass)}
    </svg></div></div>`;
}

async function render(
  lang: Lang,
  requested: {
    signalsPage: number;
    tradesPage: number;
    strategy: StrategySpec | null;
    dataset: PortfolioDataset;
    chartUnit: ChartUnit;
  },
): Promise<string> {
  const s = summary();
  const strategyId = requested.strategy?.id ?? null;
  const signalsTotal = signalTotal(strategyId);
  const tradesTotal = tradeTotal(strategyId);
  const signalsPage = Math.min(
    requested.signalsPage,
    Math.max(1, Math.ceil(signalsTotal / SIGNAL_PAGE_SIZE)),
  );
  const tradesPage = Math.min(
    requested.tradesPage,
    Math.max(1, Math.ceil(tradesTotal / TRADE_PAGE_SIZE)),
  );
  const signals = recentSignals(
    SIGNAL_PAGE_SIZE,
    (signalsPage - 1) * SIGNAL_PAGE_SIZE,
    strategyId,
  );
  const trades = recentTrades(
    TRADE_PAGE_SIZE,
    (tradesPage - 1) * TRADE_PAGE_SIZE,
    strategyId,
  );
  const liveState = lighterLiveState();
  const liveTrades = recentLiveTrades(30, strategyId);
  const allLiveClosed = closedLiveTrades();
  const liveCounts = liveTradeCounts();
  const liveDecisions = liveDecisionCounts();
  const liveSummary = liveMetrics(allLiveClosed);
  const execution = liveExecutionComparison();
  const latencyMetrics = liveLatencyMetrics(liveTrades);
  const liveStrategies = liveStrategyStates();
  const livePortfolioPaused = liveState?.portfolio_paused_at != null;
  const liveMonitor = liveState?.status === 'armed'
    && liveState.heartbeat_at != null
    && Date.now() - liveState.heartbeat_at < 15_000;
  const liveEntryEnabled = liveState?.enabled === 1;
  const liveRunnerLabel = !liveMonitor
    ? 'OFFLINE'
    : livePortfolioPaused
      ? 'RISK PAUSED'
      : liveEntryEnabled
        ? 'ARMED'
        : t(
          lang,
          'REAL НА ПАУЗЕ · ВЫХОДЫ И СТОПЫ АКТИВНЫ',
          'REAL PAUSED · EXITS AND STOPS ACTIVE',
        );
  const liveGatePassed = liveSummary.closed >= 30
    && liveSummary.netUsd > 0
    && (liveSummary.profitFactor ?? 0) >= 1.2
    && liveSummary.secondHalfUsd > 0
    && liveSummary.maxDrawdownUsd <= 15;
  const liveWr = liveSummary.closed
    ? liveSummary.wins / liveSummary.closed * 100
    : null;
  const liveNetPct = allLiveClosed.reduce(
    (sum, row) => sum + (row.net_pnl_pct ?? 0),
    0,
  );
  const wr = s.closed ? s.wins / s.closed * 100 : 0;
  const passed = STRATEGIES.filter((spec) => gate(summary(spec), lang).passed).length;
  const liveEnabledStrategies = liveStrategies.filter((row) => row.enabled === 1).length;
  const livePassedStrategies = liveStrategies.filter(
    (row) => row.gate_status === 'passed',
  ).length;
  const datasetHref = (dataset: PortfolioDataset): string => labHref({
    signalsPage,
    tradesPage,
    strategyId,
    dataset,
    chartUnit: requested.chartUnit,
    anchor: 'portfolio-view',
  });
  const chartHref = (chartUnit: ChartUnit): string => labHref({
    signalsPage,
    tradesPage,
    strategyId,
    dataset: requested.dataset,
    chartUnit,
    anchor: 'pnl-chart',
  });
  const shadowCards = `
    <div class="ll-card"><small>${t(lang, 'Стратегии / гейт', 'Strategies / gates')}</small><b>${STRATEGIES.length} / ${passed}</b><em>${ASSET_LABEL}</em></div>
    <div class="ll-card"><small>${t(lang, 'Сигналы / ошибки', 'Signals / errors')}</small><b>${s.signals} / ${s.captureErrors}</b><em>${t(lang, 'все выбранные alerts', 'all selected alerts')}</em></div>
    <div class="ll-card"><small>${t(lang, 'Закрыто / открыто', 'Closed / open')}</small><b>${s.closed} / ${s.open}</b><em>$${NOTIONAL_USD} ${t(lang, 'на позицию', 'per position')}</em></div>
    <div class="ll-card"><small>Shadow net PnL</small><b class="${pnlClass(s.netUsd)}">${signedUsd(s.netUsd)}</b><em>${signedPct(s.netPct)} · $${NOTIONAL_USD.toLocaleString('en-US')} ${t(lang, 'на сделку', 'per trade')}</em></div>
    <div class="ll-card"><small>Shadow WR / PF</small><b>${s.closed ? `${wr.toFixed(0)}% / ${pfLabel(s.profitFactor)}` : '—'}</b><em>${t(lang, 'после всех издержек', 'after all costs')}</em></div>
    <div class="ll-card"><small>${t(lang, 'Средняя сделка', 'Average trade')}</small><b class="${pnlClass(s.avgNetPct)}">${signedPct(s.avgNetPct)}</b><em>${signedUsd(s.avgNetPct / 100 * NOTIONAL_USD)}</em></div>
    <div class="ll-card"><small>Shadow max drawdown</small><b class="${s.maxDrawdownPct > 0 ? 'neg' : ''}">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}</b><em>${s.closed ? `−$${(s.maxDrawdownPct / 100 * NOTIONAL_USD).toFixed(2)}` : '—'}</em></div>
    <div class="ll-card"><small>${t(lang, 'Средний spread / круг', 'Average spread / round trip')}</small><b>${s.currentSpreadPct == null ? '—' : `${s.currentSpreadPct.toFixed(4)}%`}</b><em>${s.currentRoundTripCostPct == null ? '—' : `≈${s.currentRoundTripCostPct.toFixed(4)}%`}</em></div>`;
  const realAverageUsd = liveSummary.closed
    ? liveSummary.netUsd / liveSummary.closed
    : 0;
  const realAveragePct = liveSummary.closed
    ? liveSummary.netPct / liveSummary.closed
    : 0;
  const realCards = `
    <div class="ll-card"><small>${t(lang, 'Стратегии Real / гейт', 'Real strategies / gates')}</small><b>${liveEnabledStrategies} / ${livePassedStrategies}</b><em>${liveRunnerLabel}</em></div>
    <div class="ll-card"><small>${t(lang, 'Решения / ошибки', 'Decisions / errors')}</small><b>${liveDecisions.total} / ${liveDecisions.errors}</b><em>${t(lang, 'пропущено', 'skipped')} ${liveDecisions.skipped}</em></div>
    <div class="ll-card"><small>${t(lang, 'Закрыто / открыто', 'Closed / open')}</small><b>${liveCounts.closed} / ${liveCounts.open}</b><em>$${LIVE_NOTIONAL_USD} · ${liveCounts.errors} ${t(lang, 'ошибок', 'errors')}</em></div>
    <div class="ll-card"><small>Real net PnL</small><b class="${pnlClass(liveSummary.netUsd)}">${signedUsd(liveSummary.netUsd)}</b><em>${signedPct(liveSummary.netPct)} · $${LIVE_NOTIONAL_USD} ${t(lang, 'на сделку', 'per trade')}</em></div>
    <div class="ll-card"><small>Real WR / PF</small><b>${liveWr == null ? '—' : `${liveWr.toFixed(0)}% / ${pfLabel(liveSummary.profitFactor)}`}</b><em>${t(lang, 'после всех издержек', 'after all costs')}</em></div>
    <div class="ll-card"><small>${t(lang, 'Средняя сделка', 'Average trade')}</small><b class="${pnlClass(realAverageUsd)}">${signedUsd(realAverageUsd)}</b><em>${signedPct(realAveragePct)}</em></div>
    <div class="ll-card"><small>Real max drawdown</small><b class="${liveSummary.maxDrawdownUsd > 0 ? 'neg' : ''}">−${signedUsd(liveSummary.maxDrawdownUsd).replace('+', '')}</b><em>−${liveSummary.maxDrawdownPct.toFixed(3)}%</em></div>
    <div class="ll-card"><small>Latency P50</small><b>${latency(latencyMetrics.signalToProtectedMs)}</b><em>S→O ${latency(latencyMetrics.signalToOrderMs)} · N ${latencyMetrics.measured}</em></div>`;
  return pageShell(
    t(lang, 'LuxAlgo → Lighter — единый shadow-портфель', 'LuxAlgo → Lighter — unified shadow portfolio'),
    `<style>${LIGHTER_LUXALGO_CSS}</style><div class="ll-wrap">
      <a class="ll-back" href="/lab">${t(lang, '← Лаборатория', '← Lab')}</a>
      <div class="ll-head"><div><span class="ll-badge">STRAT-${CODE_LABEL} · PROSPECTIVE FORWARD</span>
        <h1>LuxAlgo → Lighter · единый портфель</h1>
        <p>${t(lang, `Все подходящие alerts собраны в одной системе и одной таблице. ${ASSET_LABEL} независимо снимают живой L2 Lighter без фиксированной задержки; каждая позиция моделируется на $1000. Комиссия Standard — 0%, spread, $1000 VWAP и funding учтены.`, `All selected alerts share one system and one table. ${ASSET_LABEL} independently sample live Lighter L2 with no fixed delay; every position is modeled at $1,000. Standard trading fee is 0%, while spread, $1,000 VWAP, and funding are included.`)}</p>
      </div><div class="ll-engine ${s.feedLive ? 'live' : ''}"><i></i>${s.feedLive ? `Lighter L2 · ${STRATEGIES.length}/${STRATEGIES.length} live` : 'Lighter L2 · degraded'}</div></div>

      <div class="ll-modebar" id="portfolio-view">
        <div><small>${t(lang, 'Показатели', 'Dataset')}</small><nav class="ll-tabs">
          <a href="${datasetHref('shadow')}" class="${requested.dataset === 'shadow' ? 'active' : ''}">Shadow</a>
          <a href="${datasetHref('real')}" class="real ${requested.dataset === 'real' ? 'active' : ''}">Real</a>
        </nav></div>
        <div><small>${t(lang, 'Шкала графика', 'Chart scale')}</small><nav class="ll-tabs">
          <a href="${chartHref('usd')}" class="${requested.chartUnit === 'usd' ? 'active' : ''}">${t(lang, 'Деньги $', 'Money $')}</a>
          <a href="${chartHref('pct')}" class="${requested.chartUnit === 'pct' ? 'active' : ''}">${t(lang, 'Проценты %', 'Percent %')}</a>
        </nav></div>
      </div>

      <div class="ll-grid">
        ${requested.dataset === 'shadow' ? shadowCards : realCards}
      </div>

      ${pnlChart(lang, requested.dataset, requested.chartUnit)}

      <form class="ll-filter" action="/lab/lighter-luxalgo" method="get">
        <input type="hidden" name="dataset" value="${requested.dataset}">
        <input type="hidden" name="chart" value="${requested.chartUnit}">
        <label>${t(lang, 'Фильтр сигналов и сделок', 'Signals and trades filter')}
          <select name="strategy" onchange="this.form.submit()">
            <option value="">${t(lang, 'Все стратегии', 'All strategies')}</option>
            ${STRATEGIES.map((spec) => `<option value="${esc(spec.id)}"${strategyId === spec.id ? ' selected' : ''}>STRAT-${spec.code} · ${spec.asset} · ${esc(spec.name)}</option>`).join('')}
          </select>
        </label>
        <small>${requested.strategy
          ? `${t(lang, 'Показаны только сигналы, Shadow и Real-сделки', 'Showing only signals, Shadow, and Real trades')} · STRAT-${requested.strategy.code} · ${requested.strategy.asset}`
          : t(lang, 'Показаны все стратегии портфеля', 'Showing all portfolio strategies')}</small>
        <button type="submit">${t(lang, 'Показать', 'Apply')}</button>
      </form>

      <div class="ll-panel"><h2>${t(lang, 'Индивидуальная статистика стратегий', 'Individual strategy statistics')}</h2><div class="ll-table"><table class="ll-strategy-table">
        <thead><tr><th>Strategy</th><th>L2</th><th>Backtest · N / WR / PF</th><th>Forward · closed / open</th><th>Net</th><th>DD / halves</th><th>Gate</th></tr></thead>
        <tbody>${strategyRows(lang)}</tbody>
      </table></div>
      <p class="ll-note">${t(lang, 'Индивидуальный гейт: ≥20 закрытых Lighter-forward сделок, net > 0%, PF ≥1.20, обе половины >0%. Общий результат — сумма PnL при $1000 на каждую одновременно открытую позицию.', 'Individual gate: ≥20 closed Lighter-forward trades, net > 0%, PF ≥1.20, and both halves >0%. Aggregate PnL sums results assuming $1,000 for every concurrently open position.')}</p></div>

      <div class="ll-panel" id="signal-history"><h2>${t(lang, 'История сигналов', 'Signal history')}</h2>
        <div class="ll-table"><table class="ll-signal-table">
          <thead><tr><th>Strategy</th><th>${t(lang, 'Сигнал №', 'Signal #')}</th><th>${t(lang, 'Время UTC', 'Time UTC')}</th><th>Event</th><th>Shadow-${t(lang, 'сделка', 'trade')}</th><th>Real-${t(lang, 'сделка', 'trade')}</th><th>${t(lang, 'Статус сигнала', 'Signal status')}</th></tr></thead>
          <tbody>${signalRows(signals, lang)}</tbody>
        </table></div>
        ${pager({ lang, page: signalsPage, total: signalsTotal, pageSize: SIGNAL_PAGE_SIZE, signalsPage, tradesPage, target: 'signals', strategyId, dataset: requested.dataset, chartUnit: requested.chartUnit })}
      </div>

      <div class="ll-panel" id="shadow-trades"><h2>${t(lang, 'Сделки', 'Trades')}</h2><div class="ll-table"><table class="ll-trades ll-shadow-trades">
        <thead><tr><th>Strategy</th><th>${t(lang, 'Открыта → закрыта UTC', 'Opened → closed UTC')}</th><th>Side / size</th><th>${t(lang, 'Цена входа', 'Entry price')}</th><th>${t(lang, 'Стоп-лосс', 'Stop-loss')}</th><th>${t(lang, 'Цена выхода', 'Exit price')}</th><th>${t(lang, 'Статус', 'Status')}</th><th>Net after costs</th></tr></thead>
        <tbody>${tradeRows(trades, lang)}</tbody>
      </table></div>
      ${pager({ lang, page: tradesPage, total: tradesTotal, pageSize: TRADE_PAGE_SIZE, signalsPage, tradesPage, target: 'trades', strategyId, dataset: requested.dataset, chartUnit: requested.chartUnit })}</div>

      <div class="ll-panel"><div class="ll-chart-head"><div><h2>${t(lang, 'Реальная торговля · canary', 'Live trading · canary')}</h2>
        <p class="ll-note"><b class="${livePortfolioPaused || !liveMonitor || !liveEntryEnabled ? 'fail' : 'pass'}">${liveRunnerLabel} · $100 · 10x · ${t(lang, 'ПО ОДНОЙ НА МОНЕТУ', 'ONE PER MARKET')}.</b> ${t(lang, 'Разные стратегии могут торговаться одновременно. Биржевой reduce-only stop ставится сразу на каждую позицию. При ручной паузе новые входы запрещены, но существующие позиции продолжают контролироваться и закрываться. Новые входы также блокируются при дневном убытке −$10, совокупной просадке −$15 или индивидуальной паузе стратегии.', 'Different strategies may trade concurrently. An exchange-native reduce-only stop is placed immediately on every position. During a manual pause, new entries are blocked while existing positions remain monitored and can close. New entries are also blocked at a −$10 daily loss, −$15 cumulative drawdown, or an individual strategy pause.')}${liveState?.last_error ? ` <span class="neg">${esc(liveState.last_error)}</span>` : ''}${liveState?.portfolio_pause_reason ? ` <span class="neg">${esc(liveState.portfolio_pause_reason)}</span>` : ''}</p>
        </div><span class="ll-badge ${liveGatePassed ? 'pass' : 'collect'}">${liveGatePassed ? t(lang, 'LIVE ГЕЙТ ПРОЙДЕН', 'LIVE GATE PASSED') : `${t(lang, 'LIVE ВАЛИДАЦИЯ', 'LIVE VALIDATION')} ${liveSummary.closed}/30`}</span></div>
        <div class="ll-live-grid">
          <div class="ll-live-metric"><small>${t(lang, 'Закрыто', 'Closed')}</small><b>${liveSummary.closed}/30</b></div>
          <div class="ll-live-metric"><small>Real net PnL</small><b class="${pnlClass(liveSummary.netUsd)}">${signedUsd(liveSummary.netUsd)}</b><em>${signedPct(liveNetPct)}</em></div>
          <div class="ll-live-metric"><small>WR / PF</small><b>${liveWr == null ? '—' : `${liveWr.toFixed(0)}%`} / ${pfLabel(liveSummary.profitFactor)}</b></div>
          <div class="ll-live-metric"><small>${t(lang, 'Половины', 'Halves')}</small><b>${signedUsd(liveSummary.firstHalfUsd)} / ${signedUsd(liveSummary.secondHalfUsd)}</b></div>
          <div class="ll-live-metric"><small>Max drawdown</small><b class="${liveSummary.maxDrawdownUsd > 0 ? 'neg' : ''}">−$${liveSummary.maxDrawdownUsd.toFixed(2)} / $15</b></div>
          <div class="ll-live-metric"><small>${t(lang, 'Текущая просадка', 'Current drawdown')}</small><b class="${(liveState?.current_drawdown_usd ?? 0) > 0 ? 'neg' : ''}">−$${(liveState?.current_drawdown_usd ?? 0).toFixed(2)}</b></div>
          <div class="ll-live-metric"><small>${t(lang, 'Real − shadow', 'Real − shadow')}</small><b class="${execution.avgGapPct == null ? '' : pnlClass(execution.avgGapPct)}">${execution.avgGapPct == null ? '—' : `${execution.avgGapPct > 0 ? '+' : execution.avgGapPct < 0 ? '−' : ''}${Math.abs(execution.avgGapPct).toFixed(4)} ${t(lang, 'п.п.', 'pp')}`}</b><em>${execution.matched ? `${signedPct(execution.realPct)} vs ${signedPct(execution.shadowPct)} · N ${execution.matched}` : t(lang, 'ждём закрытую пару', 'waiting for a closed pair')}</em></div>
          <div class="ll-live-metric"><small>Latency P50</small><b>${latency(latencyMetrics.signalToProtectedMs)}</b><em>S→O ${latency(latencyMetrics.signalToOrderMs)} · O→POS ${latency(latencyMetrics.orderToPositionMs)} · N ${latencyMetrics.measured}</em></div>
        </div>
        <details class="ll-details"><summary>${t(lang, 'Live-статистика по каждой стратегии', 'Per-strategy live statistics')}</summary><div class="ll-table"><table class="ll-live-strategy">
          <thead><tr><th>Strategy</th><th>Gate</th><th>N</th><th>Net</th><th>PF</th><th>½ / ½</th><th>DD $</th></tr></thead>
          <tbody>${liveStrategyRows(liveStrategies, lang)}</tbody>
        </table></div></details>
        <div class="ll-table"><table class="ll-trades ll-live-trades">
          <thead><tr><th>Strategy</th><th>${t(lang, 'Открыта → закрыта UTC', 'Opened → closed UTC')}</th><th>Side / size</th><th>${t(lang, 'Цена входа', 'Entry price')}</th><th>${t(lang, 'Стоп-лосс', 'Stop-loss')}</th><th>${t(lang, 'Цена выхода', 'Exit price')}</th><th>${t(lang, 'Статус', 'Status')}</th><th>Net after costs</th></tr></thead>
          <tbody>${liveTradeRows(liveTrades, lang)}</tbody>
        </table></div>
      </div>

      <p class="ll-note">${t(lang, 'Комиссия Lighter Standard — 0%. Spread и slippage уже включены в entry/exit VWAP; funding учитывается отдельно. Расхождение Lux→VWAP измеряется, но не блокирует shadow-вход; значения выше 0.2% подсвечиваются.', 'Lighter Standard trading fee is 0%. Spread and slippage are embedded in entry/exit VWAP; funding is accounted separately. Lux→VWAP deviation is measured but does not block shadow entry; values above 0.2% are highlighted.')}</p>
    </div>`,
    { autoRefreshSec: 5, lang },
  );
}

export async function lighterLuxalgoLabRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      signalsPage?: string;
      tradesPage?: string;
      strategy?: string;
      dataset?: string;
      chart?: string;
    };
  }>('/lab/lighter-luxalgo', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=2');
    return render(getLang(req), {
      signalsPage: positivePage(req.query.signalsPage),
      tradesPage: positivePage(req.query.tradesPage),
      strategy: selectedStrategy(req.query.strategy),
      dataset: selectedDataset(req.query.dataset),
      chartUnit: selectedChartUnit(req.query.chart),
    });
  });
}

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
import { applyGrvtDepthUpdate, createGrvtDepthBook } from '../lib/grvt-depth-book.js';
import {
  executableVwap,
  netConvergenceEdgeBps,
  normalizeExchangeTimestampMs,
  rawCrossEdgeBps,
  roundTripCostBps,
  type PriceLevel,
} from '../lib/venue-arb.js';
import {
  conservativeLatencyMs,
  independentSignalRows,
  shadowNetAfterCosts,
  shadowReadiness,
} from '../lib/venue-arb-shadow.js';
import {
  consumeMakerPrint,
  makerAbortAfterCosts,
  makerEntryEdgeBps,
  makerRoundTripAfterCosts,
  snapMakerPrice,
  type MakerQueueState,
  type MakerSide,
  type TakerSide,
} from '../lib/venue-arb-maker.js';
import {
  GenericMakerShadow,
  type GenericMakerCheckpoint,
  type GenericMakerResult,
  type MakerShadowTrade,
} from '../lib/venue-arb-maker-shadow.js';

type Venue =
  | 'lighter'
  | 'hyperliquid'
  | 'paradex'
  | 'polymarket'
  | 'extended'
  | 'aster'
  | 'pacifica'
  | 'grvt'
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
  stalls: number;
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
  buyBookSourceAgeMs: number;
  sellBookSourceAgeMs: number;
};

type ExecutableBook = {
  exchangeAt: number;
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
  currentBuyBookSourceAgeMs: number;
  currentSellBookSourceAgeMs: number;
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
  buyOpenVwap: number;
  sellOpenVwap: number;
  buyCloseVwap: number;
  sellCloseVwap: number;
  openingNetBps: number;
};

type ShadowRouteConfig = {
  id: string;
  buyVenue: Venue;
  sellVenue: Venue;
  primary: boolean;
};

type ShadowRejectReason =
  | 'missing_book'
  | 'stale_book'
  | 'stale_source'
  | 'insufficient_depth'
  | 'below_gate'
  | 'latched'
  | 'cooldown';

type ShadowRouteTelemetry = {
  freshQuotes: number;
  staleQuotes: number;
  eligibleWindows: number;
  lastSignalAt: number | null;
  lastEvaluatedAt: number | null;
  currentBestNetBps: number | null;
  currentBestCoin: string | null;
  peakOpeningNetBps: number | null;
  peakCoin: string | null;
  rejections: Record<ShadowRejectReason, number>;
  currentRejections: Record<ShadowRejectReason, number>;
};

type ShadowProbe = {
  id: string;
  opportunityId: string;
  coin: string;
  routeId: string;
  buyVenue: Venue;
  sellVenue: Venue;
  state: 'awaiting_entry' | 'open' | 'awaiting_exit';
  signalAt: number;
  signalNetBps: number;
  entryLatencyMs: number;
  exitLatencyMs: number;
  entryDueAt: number;
  entryConfirmations: number;
  lastEntryQuoteVersion: string | null;
  entryEdgeConfirmedAt: number | null;
  openedAt: number | null;
  entryBuy: number | null;
  entrySell: number | null;
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
  routeId: string;
  buyVenue: Venue;
  sellVenue: Venue;
  signalAt: number;
  signalNetBps: number;
  entryAt: number | null;
  exitAt: number;
  entryLatencyMs: number;
  exitLatencyMs: number;
  holdingMs: number | null;
  entryNetBps: number | null;
  entryConfirmations: number;
  entryEdgeConfirmed: boolean;
  guardNetBps: number | null;
  peakProjectedNetBps: number | null;
  realizedNetBps: number | null;
  realizedNetUsd: number | null;
  reachedExitGuard: boolean;
  passed: boolean;
  reason: string;
  fundingBps: number;
};

type MakerQuote = {
  id: string;
  coin: string;
  stage: 'entry' | 'exit';
  side: MakerSide;
  price: number;
  createdAt: number;
  activeAt: number;
  activatedAt: number | null;
  expiresAt: number;
  projectedNetBps: number;
  distanceBps: number;
  initialQuantity: number;
  firstFillAt: number | null;
  queue: MakerQueueState;
};

type MakerPair = {
  id: string;
  coin: string;
  extendedSide: 'long' | 'short';
  openedAt: number;
  quantity: number;
  entryExtended: number;
  entryLighter: number;
  entryEdgeBps: number;
};

type MakerPendingHedge = {
  stage: 'entry' | 'exit';
  coin: string;
  side: MakerSide;
  extendedFill: number;
  filledAt: number;
  dueAt: number;
  deadlineAt: number;
  extendedMaker: boolean;
};

type MakerResult = {
  id: string;
  coin: string;
  extendedSide: 'long' | 'short' | null;
  openedAt: number | null;
  closedAt: number;
  holdingMs: number | null;
  entryExtended: number | null;
  entryLighter: number | null;
  exitExtended: number | null;
  exitLighter: number | null;
  entryEdgeBps: number | null;
  realizedNetBps: number | null;
  realizedNetUsd: number | null;
  exitExtendedMaker: boolean | null;
  passed: boolean;
  reason: string;
  fundingBps: number;
};

type MakerTelemetry = {
  tradeStreamConnected: boolean;
  tradeReconnects: number;
  trades: number;
  staleTrades: number;
  quotes: number;
  placementRejects: number;
  placementStaleRejects: number;
  placementCrossRejects: number;
  placementQueueRejects: number;
  placementEdgeRejects: number;
  edgeCancellations: number;
  quoteExpirations: number;
  queueFills: number;
  hedgeTimeouts: number;
  lastTradeAt: number | null;
  lastQuoteAt: number | null;
};

const DATA_DIR = resolve(process.env.VENUE_ARB_DATA_DIR ?? 'data/venue-arb');
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const EXECUTION_STATUS_PATH = resolve(DATA_DIR, 'execution-status.json');
const OPPORTUNITIES_PATH = resolve(DATA_DIR, 'opportunities.ndjson');
const LIVE_TRADES_PATH = resolve(DATA_DIR, 'live-trades.json');
const SHADOW_RESULTS_PATH = resolve(DATA_DIR, 'shadow-execution-v4.ndjson');
const SHADOW_ACTIVE_PATH = resolve(DATA_DIR, 'shadow-active-v4.json');
const MAKER_RESULTS_PATH = resolve(DATA_DIR, 'maker-shadow-v1.ndjson');
const MAKER_ACTIVE_PATH = resolve(DATA_DIR, 'maker-active-v1.json');
const GRVT_MAKER_RESULTS_PATH = resolve(
  DATA_DIR,
  'grvt-maker-shadow-v1.ndjson',
);
const GRVT_MAKER_ACTIVE_PATH = resolve(
  DATA_DIR,
  'grvt-maker-active-v1.json',
);
const GRVT_EXTENDED_MAKER_RESULTS_PATH = resolve(
  DATA_DIR,
  'grvt-extended-maker-shadow-v1.ndjson',
);
const GRVT_EXTENDED_MAKER_ACTIVE_PATH = resolve(
  DATA_DIR,
  'grvt-extended-maker-active-v1.json',
);
const EXTENDED_ASTER_MAKER_RESULTS_PATH = resolve(
  DATA_DIR,
  'extended-aster-maker-shadow-v1.ndjson',
);
const EXTENDED_ASTER_MAKER_ACTIVE_PATH = resolve(
  DATA_DIR,
  'extended-aster-maker-active-v1.json',
);
const SAMPLE_MS = finiteEnv('VENUE_ARB_SAMPLE_MS', 100);
const STALE_MS = finiteEnv('VENUE_ARB_STALE_MS', 250);
const NET_TRIGGER_BPS = finiteEnv('VENUE_ARB_NET_TRIGGER_BPS', 3);
const EXECUTION_BUFFER_BPS = finiteEnv('VENUE_ARB_EXECUTION_BUFFER_BPS', 2);
const MAX_LIFETIME_MS = finiteEnv('VENUE_ARB_MAX_LIFETIME_MS', 15 * 60_000);
const SHADOW_NOTIONAL_USD = finiteEnv('VENUE_ARB_SHADOW_NOTIONAL_USD', 500);
const SHADOW_ENTRY_NET_BPS = finiteEnv('VENUE_ARB_SHADOW_ENTRY_NET_BPS', 10);
const SHADOW_ENTRY_CONFIRMATIONS = finiteEnv(
  'VENUE_ARB_SHADOW_ENTRY_CONFIRMATIONS',
  3,
);
const SHADOW_EXIT_NET_BPS = finiteEnv('VENUE_ARB_SHADOW_EXIT_NET_BPS', 10);
const SHADOW_EXIT_CONFIRMATIONS = finiteEnv(
  'VENUE_ARB_SHADOW_EXIT_CONFIRMATIONS',
  3,
);
const SHADOW_FRESH_MS = finiteEnv('VENUE_ARB_SHADOW_FRESH_MS', 150);
const SHADOW_SOURCE_FRESH_MS = finiteEnv(
  'VENUE_ARB_SHADOW_SOURCE_FRESH_MS',
  750,
);
const MAKER_BOOK_FRESH_MS = finiteEnv(
  'VENUE_ARB_MAKER_BOOK_FRESH_MS',
  SHADOW_SOURCE_FRESH_MS,
);
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
  20,
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
const SHADOW_INDEPENDENCE_MS = finiteEnv(
  'VENUE_ARB_SHADOW_INDEPENDENCE_MS',
  5 * 60_000,
);
const MAKER_NOTIONAL_USD = finiteEnv('VENUE_ARB_MAKER_NOTIONAL_USD', 500);
const MAKER_ENTRY_EDGE_BPS = finiteEnv('VENUE_ARB_MAKER_ENTRY_EDGE_BPS', 3);
const MAKER_CANCEL_EDGE_BPS = finiteEnv(
  'VENUE_ARB_MAKER_CANCEL_EDGE_BPS',
  MAKER_ENTRY_EDGE_BPS,
);
const MAKER_POST_FILL_NET_BPS = finiteEnv(
  'VENUE_ARB_MAKER_POST_FILL_NET_BPS',
  MAKER_ENTRY_EDGE_BPS,
);
const MAKER_EXIT_NET_BPS = finiteEnv('VENUE_ARB_MAKER_EXIT_NET_BPS', 10);
const MAKER_QUOTE_LATENCY_MS = finiteEnv(
  'VENUE_ARB_MAKER_QUOTE_LATENCY_MS',
  500,
);
const MAKER_HEDGE_LATENCY_MS = finiteEnv(
  'VENUE_ARB_MAKER_HEDGE_LATENCY_MS',
  500,
);
const MAKER_QUOTE_TTL_MS = finiteEnv('VENUE_ARB_MAKER_QUOTE_TTL_MS', 15_000);
const MAKER_MAX_QUEUE_USD = finiteEnv('VENUE_ARB_MAKER_MAX_QUEUE_USD', 25_000);
const MAKER_HEDGE_GRACE_MS = finiteEnv('VENUE_ARB_MAKER_HEDGE_GRACE_MS', 2_000);
const MAKER_MAX_HOLD_MS = finiteEnv(
  'VENUE_ARB_MAKER_MAX_HOLD_MS',
  15 * 60_000,
);
const MAKER_INDEPENDENCE_MS = finiteEnv(
  'VENUE_ARB_MAKER_INDEPENDENCE_MS',
  5 * 60_000,
);
const GRVT_MAKER_NOTIONAL_USD = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_NOTIONAL_USD',
  100,
);
const GRVT_MAKER_ENTRY_EDGE_BPS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_ENTRY_EDGE_BPS',
  5,
);
const GRVT_MAKER_CANCEL_EDGE_BPS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_CANCEL_EDGE_BPS',
  3,
);
const GRVT_MAKER_POST_FILL_NET_BPS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_POST_FILL_NET_BPS',
  2,
);
const GRVT_MAKER_EXIT_NET_BPS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_EXIT_NET_BPS',
  5,
);
const GRVT_MAKER_QUOTE_LATENCY_MS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_QUOTE_LATENCY_MS',
  1_000,
);
const GRVT_MAKER_HEDGE_LATENCY_MS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_HEDGE_LATENCY_MS',
  1_000,
);
const GRVT_MAKER_QUOTE_TTL_MS = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_QUOTE_TTL_MS',
  60_000,
);
const GRVT_MAKER_MAX_QUEUE_USD = finiteEnv(
  'VENUE_ARB_GRVT_MAKER_MAX_QUEUE_USD',
  5_000,
);
const GRVT_MAKER_FEE_BPS = Number.isFinite(
  Number(process.env.VENUE_ARB_GRVT_MAKER_FEE_BPS),
)
  ? Number(process.env.VENUE_ARB_GRVT_MAKER_FEE_BPS)
  : -0.01;
const GRVT_EXTENDED_MAKER_ENTRY_EDGE_BPS = finiteEnv(
  'VENUE_ARB_GRVT_EXTENDED_MAKER_ENTRY_EDGE_BPS',
  12,
);
const GRVT_EXTENDED_MAKER_CANCEL_EDGE_BPS = finiteEnv(
  'VENUE_ARB_GRVT_EXTENDED_MAKER_CANCEL_EDGE_BPS',
  8,
);
const GRVT_EXTENDED_MAKER_POST_FILL_NET_BPS = finiteEnv(
  'VENUE_ARB_GRVT_EXTENDED_MAKER_POST_FILL_NET_BPS',
  8,
);
const GRVT_EXTENDED_MAKER_EXIT_NET_BPS = finiteEnv(
  'VENUE_ARB_GRVT_EXTENDED_MAKER_EXIT_NET_BPS',
  8,
);
const EXTENDED_ASTER_MAKER_ENTRY_EDGE_BPS = finiteEnv(
  'VENUE_ARB_EXTENDED_ASTER_MAKER_ENTRY_EDGE_BPS',
  12,
);
const EXTENDED_ASTER_MAKER_CANCEL_EDGE_BPS = finiteEnv(
  'VENUE_ARB_EXTENDED_ASTER_MAKER_CANCEL_EDGE_BPS',
  8,
);
const EXTENDED_ASTER_MAKER_POST_FILL_NET_BPS = finiteEnv(
  'VENUE_ARB_EXTENDED_ASTER_MAKER_POST_FILL_NET_BPS',
  8,
);
const EXTENDED_ASTER_MAKER_EXIT_NET_BPS = finiteEnv(
  'VENUE_ARB_EXTENDED_ASTER_MAKER_EXIT_NET_BPS',
  8,
);
const FEED_STALL_MS = finiteEnv('VENUE_ARB_FEED_STALL_MS', 15_000);
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
  'pacifica',
  'grvt',
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
  pacifica: 'DEX',
  grvt: 'DEX',
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
  // Pacifica fee level 0 taker rate is 0.040%.
  pacifica: finiteEnv('VENUE_ARB_FEE_BPS_PACIFICA', 4),
  // GRVT base-tier perps taker fee is 0.045%; maker paths are researched separately.
  grvt: finiteEnv('VENUE_ARB_FEE_BPS_GRVT', 4.5),
  binance: finiteEnv('VENUE_ARB_FEE_BPS_BINANCE', 5),
  bybit: finiteEnv('VENUE_ARB_FEE_BPS_BYBIT', 5.5),
};
const SHADOW_ROUTES: readonly ShadowRouteConfig[] = [
  {
    id: 'extended-lighter',
    buyVenue: 'extended',
    sellVenue: 'lighter',
    primary: false,
  },
  {
    id: 'lighter-extended',
    buyVenue: 'lighter',
    sellVenue: 'extended',
    primary: true,
  },
  {
    id: 'bybit-paradex',
    buyVenue: 'bybit',
    sellVenue: 'paradex',
    primary: false,
  },
  {
    id: 'bybit-binance',
    buyVenue: 'bybit',
    sellVenue: 'binance',
    primary: false,
  },
  {
    id: 'binance-bybit',
    buyVenue: 'binance',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'lighter-binance',
    buyVenue: 'lighter',
    sellVenue: 'binance',
    primary: false,
  },
  {
    id: 'binance-lighter',
    buyVenue: 'binance',
    sellVenue: 'lighter',
    primary: false,
  },
  {
    id: 'paradex-bybit',
    buyVenue: 'paradex',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'paradex-lighter',
    buyVenue: 'paradex',
    sellVenue: 'lighter',
    primary: false,
  },
  {
    id: 'lighter-pacifica',
    buyVenue: 'lighter',
    sellVenue: 'pacifica',
    primary: false,
  },
  {
    id: 'pacifica-lighter',
    buyVenue: 'pacifica',
    sellVenue: 'lighter',
    primary: false,
  },
  {
    id: 'extended-pacifica',
    buyVenue: 'extended',
    sellVenue: 'pacifica',
    primary: false,
  },
  {
    id: 'pacifica-extended',
    buyVenue: 'pacifica',
    sellVenue: 'extended',
    primary: false,
  },
  {
    id: 'bybit-lighter',
    buyVenue: 'bybit',
    sellVenue: 'lighter',
    primary: false,
  },
  {
    id: 'lighter-bybit',
    buyVenue: 'lighter',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'bybit-aster',
    buyVenue: 'bybit',
    sellVenue: 'aster',
    primary: false,
  },
  {
    id: 'aster-bybit',
    buyVenue: 'aster',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'extended-aster',
    buyVenue: 'extended',
    sellVenue: 'aster',
    primary: false,
  },
  {
    id: 'aster-extended',
    buyVenue: 'aster',
    sellVenue: 'extended',
    primary: false,
  },
  {
    id: 'extended-binance',
    buyVenue: 'extended',
    sellVenue: 'binance',
    primary: false,
  },
  {
    id: 'binance-extended',
    buyVenue: 'binance',
    sellVenue: 'extended',
    primary: false,
  },
  {
    id: 'extended-bybit',
    buyVenue: 'extended',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'bybit-extended',
    buyVenue: 'bybit',
    sellVenue: 'extended',
    primary: false,
  },
  {
    id: 'bybit-hyperliquid',
    buyVenue: 'bybit',
    sellVenue: 'hyperliquid',
    primary: false,
  },
  {
    id: 'hyperliquid-bybit',
    buyVenue: 'hyperliquid',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'bybit-polymarket',
    buyVenue: 'bybit',
    sellVenue: 'polymarket',
    primary: false,
  },
  {
    id: 'polymarket-bybit',
    buyVenue: 'polymarket',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'aster-paradex',
    buyVenue: 'aster',
    sellVenue: 'paradex',
    primary: false,
  },
  {
    id: 'paradex-aster',
    buyVenue: 'paradex',
    sellVenue: 'aster',
    primary: false,
  },
  {
    id: 'grvt-lighter',
    buyVenue: 'grvt',
    sellVenue: 'lighter',
    primary: false,
  },
  {
    id: 'lighter-grvt',
    buyVenue: 'lighter',
    sellVenue: 'grvt',
    primary: false,
  },
  {
    id: 'grvt-extended',
    buyVenue: 'grvt',
    sellVenue: 'extended',
    primary: false,
  },
  {
    id: 'extended-grvt',
    buyVenue: 'extended',
    sellVenue: 'grvt',
    primary: false,
  },
  {
    id: 'grvt-binance',
    buyVenue: 'grvt',
    sellVenue: 'binance',
    primary: false,
  },
  {
    id: 'binance-grvt',
    buyVenue: 'binance',
    sellVenue: 'grvt',
    primary: false,
  },
  {
    id: 'grvt-bybit',
    buyVenue: 'grvt',
    sellVenue: 'bybit',
    primary: false,
  },
  {
    id: 'bybit-grvt',
    buyVenue: 'bybit',
    sellVenue: 'grvt',
    primary: false,
  },
];
const shadowRouteById = new Map(SHADOW_ROUTES.map((route) => [route.id, route]));
function emptyShadowRejections(): Record<ShadowRejectReason, number> {
  return {
    missing_book: 0,
    stale_book: 0,
    stale_source: 0,
    insufficient_depth: 0,
    below_gate: 0,
    latched: 0,
    cooldown: 0,
  };
}

function emptyShadowRouteTelemetry(): ShadowRouteTelemetry {
  return {
    freshQuotes: 0,
    staleQuotes: 0,
    eligibleWindows: 0,
    lastSignalAt: null,
    lastEvaluatedAt: null,
    currentBestNetBps: null,
    currentBestCoin: null,
    peakOpeningNetBps: null,
    peakCoin: null,
    rejections: emptyShadowRejections(),
    currentRejections: emptyShadowRejections(),
  };
}

const shadowRouteTelemetry = new Map<string, ShadowRouteTelemetry>(
  SHADOW_ROUTES.map((route) => [route.id, emptyShadowRouteTelemetry()]),
);

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
const grvtDepth = new Map(MARKETS.map((market) => [market.coin, createGrvtDepthBook()]));
const connections = Object.fromEntries(VENUES.map((venue) => [
  venue,
  {
    connected: false,
    messages: 0,
    reconnects: 0,
    stalls: 0,
    lastMessageAt: 0,
  },
])) as Record<Venue, ConnectionState>;
const sockets = new Set<WebSocket>();
const venueSockets = new Map<Venue, WebSocket>();
const active = new Map<string, Opportunity>();
const latchedUntilBelowTrigger = new Set<string>();
const shadowProbes = new Map<string, ShadowProbe>();
const shadowLatched = new Set<string>();
const shadowLastSignalAt = new Map<string, number>();
let recentClosed: Opportunity[] = [];
let shadowResults: ShadowResult[] = [];
let makerResults: MakerResult[] = [];
let makerQuote: MakerQuote | null = null;
let makerPair: MakerPair | null = null;
let makerPendingHedge: MakerPendingHedge | null = null;
let makerCooldownUntil = 0;
const makerTradeIds = new Set<string>();
const makerTelemetry: MakerTelemetry = {
  tradeStreamConnected: false,
  tradeReconnects: 0,
  trades: 0,
  staleTrades: 0,
  quotes: 0,
  placementRejects: 0,
  placementStaleRejects: 0,
  placementCrossRejects: 0,
  placementQueueRejects: 0,
  placementEdgeRejects: 0,
  edgeCancellations: 0,
  quoteExpirations: 0,
  queueFills: 0,
  hedgeTimeouts: 0,
  lastTradeAt: null,
  lastQuoteAt: null,
};
const grvtMakerShadow = new GenericMakerShadow({
  routeId: 'grvt-maker-lighter',
  makerVenue: 'grvt',
  hedgeVenue: 'lighter',
  notionalUsd: GRVT_MAKER_NOTIONAL_USD,
  entryEdgeBps: GRVT_MAKER_ENTRY_EDGE_BPS,
  cancelEdgeBps: GRVT_MAKER_CANCEL_EDGE_BPS,
  postFillNetBps: GRVT_MAKER_POST_FILL_NET_BPS,
  exitNetBps: GRVT_MAKER_EXIT_NET_BPS,
  quoteLatencyMs: GRVT_MAKER_QUOTE_LATENCY_MS,
  hedgeLatencyMs: GRVT_MAKER_HEDGE_LATENCY_MS,
  quoteTtlMs: GRVT_MAKER_QUOTE_TTL_MS,
  maxQueueUsd: GRVT_MAKER_MAX_QUEUE_USD,
  hedgeGraceMs: MAKER_HEDGE_GRACE_MS,
  maxHoldMs: MAKER_MAX_HOLD_MS,
  independenceMs: MAKER_INDEPENDENCE_MS,
  bookFreshMs: MAKER_BOOK_FRESH_MS,
  sourceFreshMs: SHADOW_SOURCE_FRESH_MS,
  executionBufferBps: EXECUTION_BUFFER_BPS,
  makerFeeBps: GRVT_MAKER_FEE_BPS,
  hedgeTakerFeeBps: FEE_BPS.lighter,
  makerFallbackTakerFeeBps: FEE_BPS.grvt,
  fundingBpsPerHour: SHADOW_FUNDING_BPS_PER_HOUR,
  requiredSamples: SHADOW_REQUIRED_SAMPLES,
  requiredPassPct: SHADOW_REQUIRED_PASS_PCT,
}, {
  onResult: (result) => {
    appendFileSync(GRVT_MAKER_RESULTS_PATH, `${JSON.stringify(result)}\n`);
  },
  onCheckpoint: (checkpoint) => {
    atomicJson(GRVT_MAKER_ACTIVE_PATH, {
      ...checkpoint,
      updatedAt: Date.now(),
    });
  },
});
const grvtExtendedMakerShadow = new GenericMakerShadow({
  routeId: 'grvt-maker-extended',
  makerVenue: 'grvt',
  hedgeVenue: 'extended',
  notionalUsd: GRVT_MAKER_NOTIONAL_USD,
  entryEdgeBps: GRVT_EXTENDED_MAKER_ENTRY_EDGE_BPS,
  cancelEdgeBps: GRVT_EXTENDED_MAKER_CANCEL_EDGE_BPS,
  postFillNetBps: GRVT_EXTENDED_MAKER_POST_FILL_NET_BPS,
  exitNetBps: GRVT_EXTENDED_MAKER_EXIT_NET_BPS,
  quoteLatencyMs: GRVT_MAKER_QUOTE_LATENCY_MS,
  hedgeLatencyMs: GRVT_MAKER_HEDGE_LATENCY_MS,
  quoteTtlMs: GRVT_MAKER_QUOTE_TTL_MS,
  maxQueueUsd: GRVT_MAKER_MAX_QUEUE_USD,
  hedgeGraceMs: MAKER_HEDGE_GRACE_MS,
  maxHoldMs: MAKER_MAX_HOLD_MS,
  independenceMs: MAKER_INDEPENDENCE_MS,
  bookFreshMs: MAKER_BOOK_FRESH_MS,
  sourceFreshMs: SHADOW_SOURCE_FRESH_MS,
  executionBufferBps: EXECUTION_BUFFER_BPS,
  makerFeeBps: GRVT_MAKER_FEE_BPS,
  hedgeTakerFeeBps: FEE_BPS.extended,
  makerFallbackTakerFeeBps: FEE_BPS.grvt,
  fundingBpsPerHour: SHADOW_FUNDING_BPS_PER_HOUR,
  requiredSamples: SHADOW_REQUIRED_SAMPLES,
  requiredPassPct: SHADOW_REQUIRED_PASS_PCT,
}, {
  onResult: (result) => {
    appendFileSync(
      GRVT_EXTENDED_MAKER_RESULTS_PATH,
      `${JSON.stringify(result)}\n`,
    );
  },
  onCheckpoint: (checkpoint) => {
    atomicJson(GRVT_EXTENDED_MAKER_ACTIVE_PATH, {
      ...checkpoint,
      updatedAt: Date.now(),
    });
  },
});
const extendedAsterMakerShadow = new GenericMakerShadow({
  routeId: 'extended-maker-aster',
  makerVenue: 'extended',
  hedgeVenue: 'aster',
  notionalUsd: GRVT_MAKER_NOTIONAL_USD,
  entryEdgeBps: EXTENDED_ASTER_MAKER_ENTRY_EDGE_BPS,
  cancelEdgeBps: EXTENDED_ASTER_MAKER_CANCEL_EDGE_BPS,
  postFillNetBps: EXTENDED_ASTER_MAKER_POST_FILL_NET_BPS,
  exitNetBps: EXTENDED_ASTER_MAKER_EXIT_NET_BPS,
  quoteLatencyMs: GRVT_MAKER_QUOTE_LATENCY_MS,
  hedgeLatencyMs: GRVT_MAKER_HEDGE_LATENCY_MS,
  quoteTtlMs: GRVT_MAKER_QUOTE_TTL_MS,
  maxQueueUsd: GRVT_MAKER_MAX_QUEUE_USD,
  hedgeGraceMs: MAKER_HEDGE_GRACE_MS,
  maxHoldMs: MAKER_MAX_HOLD_MS,
  independenceMs: MAKER_INDEPENDENCE_MS,
  bookFreshMs: MAKER_BOOK_FRESH_MS,
  sourceFreshMs: SHADOW_SOURCE_FRESH_MS,
  executionBufferBps: EXECUTION_BUFFER_BPS,
  makerFeeBps: 0,
  hedgeTakerFeeBps: FEE_BPS.aster,
  makerFallbackTakerFeeBps: FEE_BPS.extended,
  fundingBpsPerHour: SHADOW_FUNDING_BPS_PER_HOUR,
  requiredSamples: SHADOW_REQUIRED_SAMPLES,
  requiredPassPct: SHADOW_REQUIRED_PASS_PCT,
}, {
  onResult: (result) => {
    appendFileSync(
      EXTENDED_ASTER_MAKER_RESULTS_PATH,
      `${JSON.stringify(result)}\n`,
    );
  },
  onCheckpoint: (checkpoint) => {
    atomicJson(EXTENDED_ASTER_MAKER_ACTIVE_PATH, {
      ...checkpoint,
      updatedAt: Date.now(),
    });
  },
});
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
    exchangeAt: book.exchangeAt,
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

function shadowLatencyProfile(route: ShadowRouteConfig): {
  entryMs: number;
  exitMs: number;
  measuredTrades: number;
} {
  if (!route.primary) {
    return {
      entryMs: SHADOW_ENTRY_LATENCY_FLOOR_MS,
      exitMs: SHADOW_EXIT_LATENCY_FLOOR_MS,
      measuredTrades: 0,
    };
  }
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

function shadowQuote(
  now: number,
  coin: string,
  route: ShadowRouteConfig,
): { quote: ShadowQuote | null; rejection: ShadowRejectReason | null } {
  const buy = executableBook(route.buyVenue, coin);
  const sell = executableBook(route.sellVenue, coin);
  if (!buy || !sell) return { quote: null, rejection: 'missing_book' };
  if (
    now - buy.receivedAt > SHADOW_FRESH_MS
    || now - sell.receivedAt > SHADOW_FRESH_MS
  ) return { quote: null, rejection: 'stale_book' };
  if (
    now - buy.exchangeAt > SHADOW_SOURCE_FRESH_MS
    || now - sell.exchangeAt > SHADOW_SOURCE_FRESH_MS
  ) return { quote: null, rejection: 'stale_source' };
  if (
    buy.buyVwap500 == null
    || sell.sellVwap500 == null
    || buy.sellVwap500 == null
    || sell.buyVwap500 == null
  ) return { quote: null, rejection: 'insufficient_depth' };
  return {
    quote: {
      at: now,
      version: `${buy.receivedAt}:${sell.receivedAt}`,
      buyOpenVwap: buy.buyVwap500,
      sellOpenVwap: sell.sellVwap500,
      buyCloseVwap: buy.sellVwap500,
      sellCloseVwap: sell.buyVwap500,
      openingNetBps: netConvergenceEdgeBps(
        rawCrossEdgeBps(buy.buyVwap500, sell.sellVwap500),
        FEE_BPS[route.buyVenue],
        FEE_BPS[route.sellVenue],
        EXECUTION_BUFFER_BPS,
      ),
    },
    rejection: null,
  };
}

function modeledShadowExit(
  probe: ShadowProbe,
  quote: ShadowQuote,
): ReturnType<typeof shadowNetAfterCosts> & { fundingBps: number } | null {
  if (
    probe.openedAt == null
    || probe.entryBuy == null
    || probe.entrySell == null
    || probe.quantity == null
  ) return null;
  const fundingBps = Math.max(0, quote.at - probe.openedAt)
    / 3_600_000 * SHADOW_FUNDING_BPS_PER_HOUR;
  return {
    ...shadowNetAfterCosts({
      notionalUsd: SHADOW_NOTIONAL_USD,
      quantity: probe.quantity,
      entryExtended: probe.entryBuy,
      entryLighter: probe.entrySell,
      exitExtended: quote.buyCloseVwap,
      exitLighter: quote.sellCloseVwap,
      extendedTakerBps: FEE_BPS[probe.buyVenue],
      lighterTakerBps: FEE_BPS[probe.sellVenue],
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
    routeId: probe.routeId,
    buyVenue: probe.buyVenue,
    sellVenue: probe.sellVenue,
    signalAt: probe.signalAt,
    signalNetBps: probe.signalNetBps,
    entryAt: probe.openedAt,
    exitAt: now,
    entryLatencyMs: probe.entryLatencyMs,
    exitLatencyMs: probe.exitLatencyMs,
    holdingMs: probe.openedAt == null ? null : Math.max(0, now - probe.openedAt),
    entryNetBps: probe.entryBuy == null || probe.entrySell == null
      ? null
      : netConvergenceEdgeBps(
        rawCrossEdgeBps(probe.entryBuy, probe.entrySell),
        FEE_BPS[probe.buyVenue],
        FEE_BPS[probe.sellVenue],
        EXECUTION_BUFFER_BPS,
      ),
    entryConfirmations: probe.entryConfirmations,
    entryEdgeConfirmed: probe.entryEdgeConfirmedAt != null,
    guardNetBps: probe.guardNetBps,
    peakProjectedNetBps: probe.peakProjectedNetBps,
    realizedNetBps,
    realizedNetUsd: modeled?.netUsd ?? null,
    reachedExitGuard,
    passed: probe.entryEdgeConfirmedAt != null
      && reachedExitGuard
      && Number(realizedNetBps) > 0,
    reason,
    fundingBps: modeled?.fundingBps ?? 0,
  };
  appendFileSync(SHADOW_RESULTS_PATH, `${JSON.stringify(result)}\n`);
  shadowResults.push(result);
  if (shadowResults.length > 5_000) shadowResults = shadowResults.slice(-5_000);
  shadowProbes.delete(probe.id);
}

function evaluateShadow(now: number): void {
  for (const route of SHADOW_ROUTES) {
    const telemetry = shadowRouteTelemetry.get(route.id)!;
    const currentRejections = emptyShadowRejections();
    let currentBestNetBps: number | null = null;
    let currentBestCoin: string | null = null;
    for (const market of MARKETS) {
      const evaluation = shadowQuote(now, market.coin, route);
      const quote = evaluation.quote;
      const latchKey = `${route.id}:${market.coin}`;
      if (!quote) {
        telemetry.staleQuotes++;
        if (evaluation.rejection) {
          telemetry.rejections[evaluation.rejection]++;
          currentRejections[evaluation.rejection]++;
        }
        continue;
      }
      telemetry.freshQuotes++;
      if (
        currentBestNetBps == null
        || quote.openingNetBps > currentBestNetBps
      ) {
        currentBestNetBps = quote.openingNetBps;
        currentBestCoin = market.coin;
      }
      if (
        telemetry.peakOpeningNetBps == null
        || quote.openingNetBps > telemetry.peakOpeningNetBps
      ) {
        telemetry.peakOpeningNetBps = quote.openingNetBps;
        telemetry.peakCoin = market.coin;
      }
      if (quote.openingNetBps < SHADOW_ENTRY_NET_BPS) {
        telemetry.rejections.below_gate++;
        currentRejections.below_gate++;
        shadowLatched.delete(latchKey);
        continue;
      }
      if (shadowLatched.has(latchKey)) {
        telemetry.rejections.latched++;
        currentRejections.latched++;
        continue;
      }
      const lastSignalAt = shadowLastSignalAt.get(latchKey) ?? 0;
      if (now - lastSignalAt < SHADOW_INDEPENDENCE_MS) {
        telemetry.rejections.cooldown++;
        currentRejections.cooldown++;
        continue;
      }
      const latency = shadowLatencyProfile(route);
      const id = `S${now}-${route.id}-${market.coin}-${sequence}`;
      shadowProbes.set(id, {
        id,
        opportunityId: `shadow-${now}-${route.id}-${market.coin}`,
        coin: market.coin,
        routeId: route.id,
        buyVenue: route.buyVenue,
        sellVenue: route.sellVenue,
        state: 'awaiting_entry',
        signalAt: now,
        signalNetBps: quote.openingNetBps,
        entryLatencyMs: latency.entryMs,
        exitLatencyMs: latency.exitMs,
        entryDueAt: now + latency.entryMs,
        entryConfirmations: 0,
        lastEntryQuoteVersion: null,
        entryEdgeConfirmedAt: null,
        openedAt: null,
        entryBuy: null,
        entrySell: null,
        quantity: null,
        guardConfirmations: 0,
        lastGuardQuoteVersion: null,
        guardReachedAt: null,
        guardNetBps: null,
        exitDueAt: null,
        exitQuoteDeadlineAt: null,
        peakProjectedNetBps: null,
      });
      shadowLatched.add(latchKey);
      shadowLastSignalAt.set(latchKey, now);
      telemetry.eligibleWindows++;
      telemetry.lastSignalAt = now;
    }
    telemetry.lastEvaluatedAt = now;
    telemetry.currentBestNetBps = currentBestNetBps;
    telemetry.currentBestCoin = currentBestCoin;
    telemetry.currentRejections = currentRejections;
  }

  for (const probe of [...shadowProbes.values()]) {
    const route = shadowRouteById.get(probe.routeId);
    if (!route) {
      completeShadow(probe, now, 'unknown_shadow_route', null);
      continue;
    }
    const quote = shadowQuote(now, probe.coin, route).quote;
    if (probe.state === 'awaiting_entry') {
      if (
        quote
        && quote.openingNetBps >= SHADOW_ENTRY_NET_BPS
        && quote.version !== probe.lastEntryQuoteVersion
      ) {
        probe.entryConfirmations++;
        probe.lastEntryQuoteVersion = quote.version;
      } else if (quote && quote.openingNetBps < SHADOW_ENTRY_NET_BPS) {
        probe.entryConfirmations = 0;
        probe.lastEntryQuoteVersion = null;
      }
      if (now < probe.entryDueAt) continue;
      if (!quote) {
        completeShadow(probe, now, 'stale_at_delayed_entry', null);
        continue;
      }
      if (quote.openingNetBps < SHADOW_ENTRY_NET_BPS) {
        completeShadow(probe, now, 'edge_lost_before_entry', quote);
        continue;
      }
      if (probe.entryConfirmations < SHADOW_ENTRY_CONFIRMATIONS) {
        completeShadow(probe, now, 'unstable_edge_before_entry', quote);
        continue;
      }
      probe.entryEdgeConfirmedAt = now;
      probe.state = 'open';
      probe.openedAt = now;
      probe.entryBuy = quote.buyOpenVwap;
      probe.entrySell = quote.sellOpenVwap;
      probe.quantity = SHADOW_NOTIONAL_USD / quote.buyOpenVwap;
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

function makerBooksFresh(now: number, ...prepared: ExecutableBook[]): boolean {
  return prepared.every((book) => (
    now - book.receivedAt <= MAKER_BOOK_FRESH_MS
    && now - book.exchangeAt <= SHADOW_SOURCE_FRESH_MS
  ));
}

function appendMakerResult(result: MakerResult): void {
  appendFileSync(MAKER_RESULTS_PATH, `${JSON.stringify(result)}\n`);
  makerResults.push(result);
  if (makerResults.length > 5_000) makerResults = makerResults.slice(-5_000);
}

function writeMakerActive(): void {
  atomicJson(MAKER_ACTIVE_PATH, {
    pair: makerPair,
    pendingHedge: makerPendingHedge,
    cooldownUntil: makerCooldownUntil,
    updatedAt: Date.now(),
  });
}

function completeMakerFailure(
  pending: MakerPendingHedge,
  now: number,
  reason: string,
): void {
  appendMakerResult({
    id: makerPair?.id ?? `M${pending.filledAt}-${pending.coin}`,
    coin: pending.coin,
    extendedSide: makerPair?.extendedSide
      ?? (pending.side === 'buy' ? 'long' : 'short'),
    openedAt: makerPair?.openedAt
      ?? (pending.stage === 'entry' ? pending.filledAt : null),
    closedAt: now,
    holdingMs: makerPair
      ? Math.max(0, now - makerPair.openedAt)
      : pending.stage === 'entry'
        ? Math.max(0, now - pending.filledAt)
        : null,
    entryExtended: makerPair?.entryExtended
      ?? (pending.stage === 'entry' ? pending.extendedFill : null),
    entryLighter: makerPair?.entryLighter ?? null,
    exitExtended: pending.stage === 'exit' ? pending.extendedFill : null,
    exitLighter: null,
    entryEdgeBps: makerPair?.entryEdgeBps ?? null,
    realizedNetBps: null,
    realizedNetUsd: null,
    exitExtendedMaker: pending.stage === 'exit'
      ? pending.extendedMaker
      : null,
    passed: false,
    reason,
    fundingBps: 0,
  });
  makerTelemetry.hedgeTimeouts++;
  makerPendingHedge = null;
  makerPair = null;
  makerQuote = null;
  makerCooldownUntil = now + MAKER_INDEPENDENCE_MS;
  writeMakerActive();
}

function makerHedgePrice(
  side: MakerSide,
  lighter: ExecutableBook,
): number | null {
  return side === 'buy' ? lighter.sellVwap500 : lighter.buyVwap500;
}

function evaluateMakerPending(now: number): void {
  const pending = makerPendingHedge;
  if (!pending || now < pending.dueAt) return;
  if (now > pending.deadlineAt) {
    completeMakerFailure(pending, now, `${pending.stage}_hedge_timeout`);
    return;
  }
  const lighter = executableBook('lighter', pending.coin);
  if (!lighter || !makerBooksFresh(now, lighter)) {
    if (now >= pending.deadlineAt) {
      completeMakerFailure(pending, now, `${pending.stage}_hedge_stale`);
    }
    return;
  }
  const lighterFill = makerHedgePrice(pending.side, lighter);
  if (lighterFill == null) {
    if (now >= pending.deadlineAt) {
      completeMakerFailure(pending, now, `${pending.stage}_hedge_depth`);
    }
    return;
  }
  if (pending.stage === 'entry') {
    const extendedSide = pending.side === 'buy' ? 'long' : 'short';
    const quantity = MAKER_NOTIONAL_USD / pending.extendedFill;
    const entryEdgeBps = makerEntryEdgeBps(
      pending.side,
      pending.extendedFill,
      lighterFill,
    );
    const entryNetBps = entryEdgeBps - EXECUTION_BUFFER_BPS;
    if (entryNetBps < MAKER_POST_FILL_NET_BPS) {
      const extended = executableBook('extended', pending.coin);
      if (!extended || !makerBooksFresh(now, extended, lighter)) return;
      const exitExtended = pending.side === 'buy'
        ? extended.sellVwap500
        : extended.buyVwap500;
      if (exitExtended == null) return;
      const modeled = makerAbortAfterCosts({
        extendedSide,
        notionalUsd: MAKER_NOTIONAL_USD,
        quantity,
        entryExtended: pending.extendedFill,
        exitExtended,
        extendedExitFeeBps: FEE_BPS.extended,
        executionBufferBps: EXECUTION_BUFFER_BPS,
      });
      appendMakerResult({
        id: `M${pending.filledAt}-${pending.coin}-${extendedSide}`,
        coin: pending.coin,
        extendedSide,
        openedAt: pending.filledAt,
        closedAt: now,
        holdingMs: Math.max(0, now - pending.filledAt),
        entryExtended: pending.extendedFill,
        entryLighter: null,
        exitExtended,
        exitLighter: null,
        entryEdgeBps,
        realizedNetBps: modeled.netBps,
        realizedNetUsd: modeled.netUsd,
        exitExtendedMaker: false,
        passed: modeled.netBps > 0,
        reason: 'post_fill_edge_lost',
        fundingBps: 0,
      });
      makerPendingHedge = null;
      makerPair = null;
      makerQuote = null;
      makerCooldownUntil = now + MAKER_INDEPENDENCE_MS;
      writeMakerActive();
      return;
    }
    makerPair = {
      id: `M${pending.filledAt}-${pending.coin}-${extendedSide}`,
      coin: pending.coin,
      extendedSide,
      openedAt: now,
      quantity,
      entryExtended: pending.extendedFill,
      entryLighter: lighterFill,
      entryEdgeBps,
    };
    makerPendingHedge = null;
    writeMakerActive();
    return;
  }
  const pair = makerPair;
  if (!pair) {
    completeMakerFailure(pending, now, 'exit_without_pair');
    return;
  }
  const fundingBps = Math.max(0, now - pair.openedAt)
    / 3_600_000 * SHADOW_FUNDING_BPS_PER_HOUR;
  const modeled = makerRoundTripAfterCosts({
    extendedSide: pair.extendedSide,
    notionalUsd: MAKER_NOTIONAL_USD,
    quantity: pair.quantity,
    entryExtended: pair.entryExtended,
    entryLighter: pair.entryLighter,
    exitExtended: pending.extendedFill,
    exitLighter: lighterFill,
    extendedEntryFeeBps: 0,
    extendedExitFeeBps: pending.extendedMaker ? 0 : FEE_BPS.extended,
    lighterEntryFeeBps: FEE_BPS.lighter,
    lighterExitFeeBps: FEE_BPS.lighter,
    executionBufferBps: EXECUTION_BUFFER_BPS,
    fundingBps,
  });
  appendMakerResult({
    id: pair.id,
    coin: pair.coin,
    extendedSide: pair.extendedSide,
    openedAt: pair.openedAt,
    closedAt: now,
    holdingMs: Math.max(0, now - pair.openedAt),
    entryExtended: pair.entryExtended,
    entryLighter: pair.entryLighter,
    exitExtended: pending.extendedFill,
    exitLighter: lighterFill,
    entryEdgeBps: pair.entryEdgeBps,
    realizedNetBps: modeled.netBps,
    realizedNetUsd: modeled.netUsd,
    exitExtendedMaker: pending.extendedMaker,
    passed: modeled.netBps > 0,
    reason: pending.extendedMaker ? 'maker_round_trip' : 'max_hold_taker_exit',
    fundingBps,
  });
  makerPendingHedge = null;
  makerPair = null;
  makerQuote = null;
  makerCooldownUntil = now + MAKER_INDEPENDENCE_MS;
  writeMakerActive();
}

function makerCloseProjection(
  now: number,
  pair: MakerPair,
  extendedFill: number,
  lighterFill: number,
): number {
  const fundingBps = Math.max(0, now - pair.openedAt)
    / 3_600_000 * SHADOW_FUNDING_BPS_PER_HOUR;
  return makerRoundTripAfterCosts({
    extendedSide: pair.extendedSide,
    notionalUsd: MAKER_NOTIONAL_USD,
    quantity: pair.quantity,
    entryExtended: pair.entryExtended,
    entryLighter: pair.entryLighter,
    exitExtended: extendedFill,
    exitLighter: lighterFill,
    extendedEntryFeeBps: 0,
    extendedExitFeeBps: 0,
    lighterEntryFeeBps: FEE_BPS.lighter,
    lighterExitFeeBps: FEE_BPS.lighter,
    executionBufferBps: EXECUTION_BUFFER_BPS,
    fundingBps,
  }).netBps;
}

function makerPriceTick(book: BookState): number | null {
  const prices = [
    ...sortedLevels(book, 'bids', 20).map(([price]) => price),
    ...sortedLevels(book, 'asks', 20).map(([price]) => price),
  ].sort((a, b) => a - b);
  let tick = Infinity;
  for (let index = 1; index < prices.length; index++) {
    const difference = prices[index]! - prices[index - 1]!;
    if (difference > 1e-10) tick = Math.min(tick, difference);
  }
  return Number.isFinite(tick) && tick > 0
    ? Number(tick.toPrecision(10))
    : null;
}

function makerEntryQuoteLevels(
  rawExtended: BookState,
  side: MakerSide,
  lighterFill: number,
): Array<{
  price: number;
  queueAhead: number;
  distanceBps: number;
}> {
  const bestBid = sortedLevels(rawExtended, 'bids', 1)[0]?.[0];
  const bestAsk = sortedLevels(rawExtended, 'asks', 1)[0]?.[0];
  const tick = makerPriceTick(rawExtended);
  if (bestBid == null || bestAsk == null || tick == null) return [];
  const requiredRawBps = MAKER_ENTRY_EDGE_BPS + EXECUTION_BUFFER_BPS;
  let syntheticPrice: number;
  if (side === 'buy') {
    const maximumEdgePrice = lighterFill / (1 + requiredRawBps / 10_000);
    syntheticPrice = Math.max(
      bestBid,
      snapMakerPrice(
        Math.min(bestAsk - tick, maximumEdgePrice),
        tick,
        'floor',
      ),
    );
  } else {
    const minimumEdgePrice = lighterFill * (1 + requiredRawBps / 10_000);
    syntheticPrice = Math.min(
      bestAsk,
      snapMakerPrice(
        Math.max(bestBid + tick, minimumEdgePrice),
        tick,
        'ceil',
      ),
    );
  }
  const sameSide = side === 'buy'
    ? rawExtended.bids
    : rawExtended.asks;
  const displayed = sortedLevels(
    rawExtended,
    side === 'buy' ? 'bids' : 'asks',
    20,
  ).map(([price]) => price);
  return [...new Set([syntheticPrice, ...displayed])]
    .filter((price) => (
      price > 0
      && (side === 'buy' ? price < bestAsk : price > bestBid)
      && makerEntryEdgeBps(side, price, lighterFill)
        - EXECUTION_BUFFER_BPS >= MAKER_ENTRY_EDGE_BPS - 1e-8
    ))
    .flatMap((price) => {
      const queueAhead = sameSide.get(price) ?? 0;
      if (queueAhead * price > MAKER_MAX_QUEUE_USD) return [];
      const distanceBps = side === 'buy'
        ? Math.max(0, (bestBid / price - 1) * 10_000)
        : Math.max(0, (price / bestAsk - 1) * 10_000);
      return [{ price, queueAhead, distanceBps }];
    });
}

function makerExitQuoteLevel(
  now: number,
  pair: MakerPair,
  rawExtended: BookState,
  lighterFill: number,
): PriceLevel | null {
  const bestBid = sortedLevels(rawExtended, 'bids', 1)[0]?.[0];
  const bestAsk = sortedLevels(rawExtended, 'asks', 1)[0]?.[0];
  const tick = makerPriceTick(rawExtended);
  if (bestBid == null || bestAsk == null || tick == null) return null;
  const side: MakerSide = pair.extendedSide === 'long' ? 'sell' : 'buy';
  let quotePrice: number;
  if (side === 'sell') {
    let low = Math.min(bestAsk, bestBid + tick);
    let high = bestAsk;
    if (makerCloseProjection(now, pair, high, lighterFill) < MAKER_EXIT_NET_BPS) {
      return null;
    }
    if (makerCloseProjection(now, pair, low, lighterFill) < MAKER_EXIT_NET_BPS) {
      for (let iteration = 0; iteration < 24; iteration++) {
        const middle = (low + high) / 2;
        if (
          makerCloseProjection(now, pair, middle, lighterFill)
          >= MAKER_EXIT_NET_BPS
        ) high = middle;
        else low = middle;
      }
      quotePrice = snapMakerPrice(high, tick, 'ceil');
    } else {
      quotePrice = snapMakerPrice(low, tick, 'ceil');
    }
    quotePrice = Math.min(bestAsk, Math.max(bestBid + tick, quotePrice));
  } else {
    let low = bestBid;
    let high = Math.max(bestBid, bestAsk - tick);
    if (makerCloseProjection(now, pair, low, lighterFill) < MAKER_EXIT_NET_BPS) {
      return null;
    }
    if (makerCloseProjection(now, pair, high, lighterFill) < MAKER_EXIT_NET_BPS) {
      for (let iteration = 0; iteration < 24; iteration++) {
        const middle = (low + high) / 2;
        if (
          makerCloseProjection(now, pair, middle, lighterFill)
          >= MAKER_EXIT_NET_BPS
        ) low = middle;
        else high = middle;
      }
      quotePrice = snapMakerPrice(low, tick, 'floor');
    } else {
      quotePrice = snapMakerPrice(high, tick, 'floor');
    }
    quotePrice = Math.max(bestBid, Math.min(bestAsk - tick, quotePrice));
  }
  if (
    quotePrice <= 0
    || quotePrice >= bestAsk && side === 'buy'
    || quotePrice <= bestBid && side === 'sell'
  ) return null;
  const sameSide = side === 'buy'
    ? rawExtended.bids
    : rawExtended.asks;
  return [quotePrice, sameSide.get(quotePrice) ?? 0];
}

function makerEntryQuoteCandidate(now: number): MakerQuote | null {
  const candidates: MakerQuote[] = [];
  for (const market of MARKETS) {
    const rawExtended = books.get(bookKey('extended', market.coin));
    const extended = executableBook('extended', market.coin);
    const lighter = executableBook('lighter', market.coin);
    if (!rawExtended || !extended || !lighter) continue;
    if (!makerBooksFresh(now, extended, lighter)) continue;
    for (const side of ['buy', 'sell'] as const) {
      const lighterFill = makerHedgePrice(side, lighter);
      if (lighterFill == null) continue;
      for (const level of makerEntryQuoteLevels(
        rawExtended,
        side,
        lighterFill,
      )) {
        if (!(level.price > 0) || level.queueAhead < 0) continue;
        const projectedNetBps = makerEntryEdgeBps(
          side,
          level.price,
          lighterFill,
        ) - EXECUTION_BUFFER_BPS;
        if (projectedNetBps < MAKER_ENTRY_EDGE_BPS) continue;
        const quantity = MAKER_NOTIONAL_USD / level.price;
        candidates.push({
          id: `MQ${now}-${market.coin}-entry-${side}-${level.price}`,
          coin: market.coin,
          stage: 'entry',
          side,
          price: level.price,
          createdAt: now,
          activeAt: now + MAKER_QUOTE_LATENCY_MS,
          activatedAt: null,
          expiresAt: now + MAKER_QUOTE_LATENCY_MS + MAKER_QUOTE_TTL_MS,
          projectedNetBps,
          distanceBps: level.distanceBps,
          initialQuantity: quantity,
          firstFillAt: null,
          queue: {
            queueAhead: level.queueAhead,
            remaining: quantity,
            filled: false,
          },
        });
      }
    }
  }
  const fillScore = (quote: MakerQuote): number => (
    quote.projectedNetBps / (
      1
      + quote.queue.queueAhead * quote.price / MAKER_NOTIONAL_USD
      + quote.distanceBps * 2
    )
  );
  return candidates.sort((a, b) => fillScore(b) - fillScore(a))[0] ?? null;
}

function makerQuoteCandidate(now: number): MakerQuote | null {
  if (makerPendingHedge) return null;
  if (makerPair) {
    const rawExtended = books.get(bookKey('extended', makerPair.coin));
    const extended = executableBook('extended', makerPair.coin);
    const lighter = executableBook('lighter', makerPair.coin);
    if (!rawExtended || !extended || !lighter) return null;
    if (!makerBooksFresh(now, extended, lighter)) return null;
    const side: MakerSide = makerPair.extendedSide === 'long' ? 'sell' : 'buy';
    const lighterFill = makerHedgePrice(side, lighter);
    if (lighterFill == null) return null;
    const level = makerExitQuoteLevel(
      now,
      makerPair,
      rawExtended,
      lighterFill,
    );
    if (!level) return null;
    const [price, queueAhead] = level;
    const projectedNetBps = makerCloseProjection(
      now,
      makerPair,
      price,
      lighterFill,
    );
    if (projectedNetBps < MAKER_EXIT_NET_BPS) return null;
    return {
      id: `MQ${now}-${makerPair.coin}-exit-${side}`,
      coin: makerPair.coin,
      stage: 'exit',
      side,
      price,
      createdAt: now,
      activeAt: now + MAKER_QUOTE_LATENCY_MS,
      activatedAt: null,
      expiresAt: now + MAKER_QUOTE_LATENCY_MS + MAKER_QUOTE_TTL_MS,
      projectedNetBps,
      distanceBps: 0,
      initialQuantity: makerPair.quantity,
      firstFillAt: null,
      queue: {
        queueAhead,
        remaining: makerPair.quantity,
        filled: false,
      },
    };
  }
  if (now < makerCooldownUntil) return null;
  return makerEntryQuoteCandidate(now);
}

function completeMakerPartialFailure(quote: MakerQuote, now: number): void {
  appendMakerResult({
    id: makerPair?.id ?? `M${quote.firstFillAt ?? now}-${quote.coin}`,
    coin: quote.coin,
    extendedSide: makerPair?.extendedSide
      ?? (quote.side === 'buy' ? 'long' : 'short'),
    openedAt: makerPair?.openedAt ?? null,
    closedAt: now,
    holdingMs: makerPair ? Math.max(0, now - makerPair.openedAt) : null,
    entryExtended: makerPair?.entryExtended
      ?? (quote.stage === 'entry' ? quote.price : null),
    entryLighter: makerPair?.entryLighter ?? null,
    exitExtended: quote.stage === 'exit' ? quote.price : null,
    exitLighter: null,
    entryEdgeBps: makerPair?.entryEdgeBps ?? null,
    realizedNetBps: null,
    realizedNetUsd: null,
    exitExtendedMaker: quote.stage === 'exit' ? true : null,
    passed: false,
    reason: `${quote.stage}_partial_fill_unhedged`,
    fundingBps: 0,
  });
  makerPair = null;
  makerQuote = null;
  makerCooldownUntil = now + MAKER_INDEPENDENCE_MS;
  writeMakerActive();
}

function activateMakerQuote(now: number): void {
  const quote = makerQuote;
  if (!quote || quote.activatedAt != null || now < quote.activeAt) return;
  const rawExtended = books.get(bookKey('extended', quote.coin));
  const extended = executableBook('extended', quote.coin);
  if (!rawExtended || !extended || !makerBooksFresh(now, extended)) {
    makerTelemetry.placementRejects++;
    makerTelemetry.placementStaleRejects++;
    makerQuote = null;
    return;
  }
  const bestOpposite = sortedLevels(
    rawExtended,
    quote.side === 'buy' ? 'asks' : 'bids',
    1,
  )[0]?.[0];
  const wouldCross = bestOpposite != null && (
    quote.side === 'buy'
      ? quote.price >= bestOpposite
      : quote.price <= bestOpposite
  );
  if (wouldCross) {
    makerTelemetry.placementRejects++;
    makerTelemetry.placementCrossRejects++;
    makerQuote = null;
    return;
  }
  const sameSide = quote.side === 'buy'
    ? rawExtended.bids
    : rawExtended.asks;
  quote.queue = {
    queueAhead: sameSide.get(quote.price) ?? 0,
    remaining: quote.queue.remaining,
    filled: false,
  };
  if (
    quote.stage === 'entry'
    && quote.queue.queueAhead * quote.price > MAKER_MAX_QUEUE_USD
  ) {
    makerTelemetry.placementRejects++;
    makerTelemetry.placementQueueRejects++;
    makerQuote = null;
    return;
  }
  const projectedNetBps = makerQuoteCurrentProjection(now, quote);
  const minimumNetBps = quote.stage === 'entry'
    ? MAKER_CANCEL_EDGE_BPS
    : MAKER_EXIT_NET_BPS;
  if (projectedNetBps == null || projectedNetBps < minimumNetBps) {
    makerTelemetry.placementRejects++;
    makerTelemetry.placementEdgeRejects++;
    makerQuote = null;
    return;
  }
  quote.activatedAt = now;
}

function makerQuoteCurrentProjection(
  now: number,
  quote: MakerQuote,
): number | null {
  const lighter = executableBook('lighter', quote.coin);
  if (!lighter || !makerBooksFresh(now, lighter)) return null;
  const lighterFill = makerHedgePrice(quote.side, lighter);
  if (lighterFill == null) return null;
  if (quote.stage === 'entry') {
    return makerEntryEdgeBps(quote.side, quote.price, lighterFill)
      - EXECUTION_BUFFER_BPS;
  }
  if (!makerPair || makerPair.coin !== quote.coin) return null;
  return makerCloseProjection(now, makerPair, quote.price, lighterFill);
}

function evaluateMakerShadow(now: number): void {
  evaluateMakerPending(now);
  if (makerPendingHedge) return;
  if (
    makerPair
    && now - makerPair.openedAt >= MAKER_MAX_HOLD_MS
    && !makerQuote
  ) {
    const extended = executableBook('extended', makerPair.coin);
    if (extended && makerBooksFresh(now, extended)) {
      const side: MakerSide = makerPair.extendedSide === 'long' ? 'sell' : 'buy';
      const extendedFill = side === 'sell'
        ? extended.sellVwap500
        : extended.buyVwap500;
      if (extendedFill != null) {
        makerPendingHedge = {
          stage: 'exit',
          coin: makerPair.coin,
          side,
          extendedFill,
          filledAt: now,
          dueAt: now + MAKER_HEDGE_LATENCY_MS,
          deadlineAt: now + MAKER_HEDGE_LATENCY_MS + MAKER_HEDGE_GRACE_MS,
          extendedMaker: false,
        };
        writeMakerActive();
      }
    }
    return;
  }
  activateMakerQuote(now);
  if (
    makerQuote?.activatedAt != null
    && makerQuote.firstFillAt == null
  ) {
    const projectedNetBps = makerQuoteCurrentProjection(now, makerQuote);
    const minimumNetBps = makerQuote.stage === 'entry'
      ? MAKER_CANCEL_EDGE_BPS
      : MAKER_EXIT_NET_BPS;
    if (projectedNetBps == null || projectedNetBps < minimumNetBps) {
      makerTelemetry.edgeCancellations++;
      makerQuote = null;
    }
  }
  if (makerQuote && now >= makerQuote.expiresAt) {
    if (
      makerQuote.firstFillAt != null
      && makerQuote.queue.remaining < makerQuote.initialQuantity
    ) {
      completeMakerPartialFailure(makerQuote, now);
      return;
    }
    makerTelemetry.quoteExpirations++;
    makerQuote = null;
  }
  if (!makerQuote) {
    makerQuote = makerQuoteCandidate(now);
    if (makerQuote) {
      makerTelemetry.quotes++;
      makerTelemetry.lastQuoteAt = now;
    }
  }
}

function processMakerTrade(
  trade: {
    id: string;
    coin: string;
    side: TakerSide;
    price: number;
    size: number;
    tradeAt: number;
  },
  receivedAt: number,
): void {
  if (makerTradeIds.has(trade.id)) return;
  makerTradeIds.add(trade.id);
  if (makerTradeIds.size > 50_000) makerTradeIds.clear();
  makerTelemetry.trades++;
  makerTelemetry.lastTradeAt = receivedAt;
  if (
    receivedAt - trade.tradeAt > SHADOW_SOURCE_FRESH_MS
    || trade.tradeAt - receivedAt > 1_000
  ) {
    makerTelemetry.staleTrades++;
    return;
  }
  const quote = makerQuote;
  if (
    !quote
    || quote.coin !== trade.coin
    || quote.activatedAt == null
    || receivedAt < quote.activatedAt
    || receivedAt >= quote.expiresAt
  ) return;
  const previousRemaining = quote.queue.remaining;
  quote.queue = consumeMakerPrint(
    quote.queue,
    quote.side,
    quote.price,
    trade.side,
    trade.price,
    trade.size,
  );
  if (
    quote.firstFillAt == null
    && quote.queue.remaining < previousRemaining
  ) quote.firstFillAt = receivedAt;
  if (!quote.queue.filled) return;
  makerTelemetry.queueFills++;
  makerPendingHedge = {
    stage: quote.stage,
    coin: quote.coin,
    side: quote.side,
    extendedFill: quote.price,
    filledAt: quote.firstFillAt ?? receivedAt,
    dueAt: (quote.firstFillAt ?? receivedAt) + MAKER_HEDGE_LATENCY_MS,
    deadlineAt: (quote.firstFillAt ?? receivedAt)
      + MAKER_HEDGE_LATENCY_MS + MAKER_HEDGE_GRACE_MS,
    extendedMaker: true,
  };
  makerQuote = null;
  writeMakerActive();
}

function makerShadowStatus(): Record<string, unknown> {
  const completed = makerResults.filter((row) => row.realizedNetBps != null);
  const passed = makerResults.filter((row) => row.passed).length;
  const passedPct = makerResults.length
    ? passed / makerResults.length * 100
    : null;
  const netBps = completed.map((row) => Number(row.realizedNetBps));
  const sumNetBps = netBps.reduce((sum, value) => sum + value, 0);
  return {
    version: 'maker-shadow-v1',
    config: {
      notionalUsd: MAKER_NOTIONAL_USD,
      entryEdgeBps: MAKER_ENTRY_EDGE_BPS,
      cancelEdgeBps: MAKER_CANCEL_EDGE_BPS,
      postFillNetBps: MAKER_POST_FILL_NET_BPS,
      exitNetBps: MAKER_EXIT_NET_BPS,
      quoteLatencyMs: MAKER_QUOTE_LATENCY_MS,
      hedgeLatencyMs: MAKER_HEDGE_LATENCY_MS,
      quoteTtlMs: MAKER_QUOTE_TTL_MS,
      maxQueueUsd: MAKER_MAX_QUEUE_USD,
      maxHoldMs: MAKER_MAX_HOLD_MS,
      independenceMs: MAKER_INDEPENDENCE_MS,
      bookFreshMs: MAKER_BOOK_FRESH_MS,
      sourceFreshMs: SHADOW_SOURCE_FRESH_MS,
      executionBufferBps: EXECUTION_BUFFER_BPS,
      extendedMakerFeeBps: 0,
      lighterTakerFeeBps: FEE_BPS.lighter,
    },
    readiness: {
      attempts: makerResults.length,
      samples: completed.length,
      passed,
      passedPct,
      requiredSamples: SHADOW_REQUIRED_SAMPLES,
      requiredPassPct: SHADOW_REQUIRED_PASS_PCT,
      ready: completed.length >= SHADOW_REQUIRED_SAMPLES
        && passedPct != null
        && passedPct >= SHADOW_REQUIRED_PASS_PCT
        && sumNetBps > 0,
      sumNetBps,
      sumNetUsd: completed.reduce(
        (sum, row) => sum + Number(row.realizedNetUsd ?? 0),
        0,
      ),
      minNetBps: netBps.length ? Math.min(...netBps) : null,
      meanNetBps: netBps.length
        ? netBps.reduce((sum, value) => sum + value, 0) / netBps.length
        : null,
    },
    telemetry: makerTelemetry,
    quote: makerQuote,
    pair: makerPair,
    pendingHedge: makerPendingHedge,
    cooldownUntil: makerCooldownUntil,
    recent: makerResults.slice(-20).reverse(),
  };
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
    const row = raw as {
      px?: unknown;
      sz?: unknown;
      price?: unknown;
      size?: unknown;
      p?: unknown;
      a?: unknown;
    };
    const price = finite(row.px ?? row.price ?? row.p);
    const size = finite(row.sz ?? row.size ?? row.a);
    if (!(price > 0) || size < 0) continue;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

function markBook(book: BookState, exchangeAt: number, receivedAt: number): void {
  if (!book.bids.size || !book.asks.size) return;
  book.exchangeAt = normalizeExchangeTimestampMs(exchangeAt, receivedAt);
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
  venueSockets.set(venue, ws);
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
  ws.on('error', (error) => {
    connections[venue].connected = false;
    if (venue === 'grvt') {
      grvtMakerShadow.setTradeStreamConnected(false);
      grvtExtendedMakerShadow.setTradeStreamConnected(false);
    }
    console.warn(`venue-arb ${venue} websocket error`, error.message);
  });
  ws.on('close', (code, reason) => {
    sockets.delete(ws);
    if (venueSockets.get(venue) === ws) venueSockets.delete(venue);
    connections[venue].connected = false;
    connections[venue].reconnects++;
    if (venue === 'grvt') {
      grvtMakerShadow.setTradeStreamConnected(false);
      grvtMakerShadow.recordTradeReconnect();
      grvtExtendedMakerShadow.setTradeStreamConnected(false);
      grvtExtendedMakerShadow.recordTradeReconnect();
    }
    console.warn(
      `venue-arb ${venue} closed code=${code} reason=${reason.toString().slice(0, 160) || 'none'}`,
    );
    if (!shuttingDown) {
      const reconnectDelayMs = code === 1_000 ? 250 : RECONNECT_MS;
      setTimeout(
        () => connect(venue, url, onOpen, onMessage, options),
        reconnectDelayMs,
      ).unref();
    }
  });
}

function reconnectStalledFeeds(): void {
  const now = Date.now();
  for (const venue of VENUES) {
    const state = connections[venue];
    if (
      !state.connected
      || !state.lastMessageAt
      || now - state.lastMessageAt <= FEED_STALL_MS
    ) continue;
    const ws = venueSockets.get(venue);
    if (!ws) continue;
    state.stalls++;
    console.warn(
      `venue-arb ${venue} stalled ${now - state.lastMessageAt}ms; reconnecting`,
    );
    ws.terminate();
  }
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

function startPacifica(): void {
  connect(
    'pacifica',
    'wss://ws.pacifica.fi/ws',
    (ws) => {
      for (const market of MARKETS) {
        ws.send(JSON.stringify({
          method: 'subscribe',
          params: {
            source: 'book',
            symbol: market.coin,
            agg_level: 1,
          },
        }));
      }
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        } else {
          clearInterval(timer);
        }
      }, 30_000);
      timer.unref();
    },
    (payload, receivedAt) => {
      const message = payload as {
        channel?: unknown;
        data?: {
          s?: unknown;
          l?: unknown[];
          t?: unknown;
        };
      };
      if (
        message.channel !== 'book'
        || typeof message.data?.s !== 'string'
        || !Array.isArray(message.data.l)
      ) return;
      const market = byCoin.get(message.data.s);
      const book = market ? books.get(bookKey('pacifica', market.coin)) : null;
      if (!book) return;
      replaceObjectLevels(book.bids, message.data.l[0]);
      replaceObjectLevels(book.asks, message.data.l[1]);
      markBook(book, finite(message.data.t), receivedAt);
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
    (ws) => {
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
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

function startExtendedTrades(): void {
  if (shuttingDown) return;
  const url = 'wss://api.starknet.extended.exchange/stream.extended.exchange/v1/publicTrades';
  const ws = new WebSocket(url, {
    headers: { 'User-Agent': 'RobotClaude-Arb-Monitor/1.0' },
  });
  sockets.add(ws);
  ws.on('open', () => {
    makerTelemetry.tradeStreamConnected = true;
    extendedAsterMakerShadow.setTradeStreamConnected(true);
    console.warn('venue-arb extended public trades connected');
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(timer);
    }, 10_000);
    timer.unref();
  });
  ws.on('message', (data) => {
    const receivedAt = Date.now();
    try {
      const message = JSON.parse(rawText(data)) as {
        data?: Array<{
          m?: unknown;
          S?: unknown;
          T?: unknown;
          p?: unknown;
          q?: unknown;
          i?: unknown;
        }>;
      };
      for (const row of message.data ?? []) {
        if (typeof row.m !== 'string') continue;
        const coin = row.m.endsWith('-USD')
          ? row.m.slice(0, -'-USD'.length)
          : '';
        if (!byCoin.has(coin)) continue;
        const side = row.S === 'BUY' || row.S === 'SELL'
          ? row.S
          : null;
        const price = finite(row.p);
        const size = finite(row.q);
        if (!side || !(price > 0) || !(size > 0)) continue;
        const trade: MakerShadowTrade = {
          id: `${coin}:${String(row.i ?? `${row.T}:${row.p}:${row.q}:${row.S}`)}`,
          coin,
          side,
          price,
          size,
          tradeAt: normalizeExchangeTimestampMs(finite(row.T), receivedAt),
        };
        processMakerTrade(trade, receivedAt);
        extendedAsterMakerShadow.processTrade(trade, receivedAt);
      }
    } catch (error) {
      console.warn(
        'venue-arb extended public trades parse',
        (error as Error).message,
      );
    }
  });
  ws.on('error', (error) => {
    makerTelemetry.tradeStreamConnected = false;
    extendedAsterMakerShadow.setTradeStreamConnected(false);
    console.warn('venue-arb extended public trades websocket error', error.message);
  });
  ws.on('close', (code, reason) => {
    sockets.delete(ws);
    makerTelemetry.tradeStreamConnected = false;
    makerTelemetry.tradeReconnects++;
    extendedAsterMakerShadow.setTradeStreamConnected(false);
    extendedAsterMakerShadow.recordTradeReconnect();
    console.warn(
      `venue-arb extended public trades closed code=${code} reason=${reason.toString().slice(0, 160) || 'none'}`,
    );
    if (!shuttingDown) {
      setTimeout(
        startExtendedTrades,
        code === 1_000 ? 250 : RECONNECT_MS,
      ).unref();
    }
  });
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

function startGrvt(): void {
  connect(
    'grvt',
    'wss://market-data.grvt.io/ws/full',
    (ws) => {
      grvtMakerShadow.setTradeStreamConnected(true);
      grvtExtendedMakerShadow.setTradeStreamConnected(true);
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          stream: 'v1.book.d',
          selectors: MARKETS.map(({ coin }) => `${coin}_USDT_Perp@100`),
        },
        id: 1,
      }));
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          stream: 'v1.trade',
          selectors: MARKETS.map(({ coin }) => `${coin}_USDT_Perp@50`),
        },
        id: 2,
      }));
    },
    (payload, receivedAt, ws) => {
      const message = payload as {
        stream?: unknown;
        sequence_number?: unknown;
        prev_sequence_number?: unknown;
        feed?: {
          event_time?: unknown;
          instrument?: unknown;
          bids?: unknown;
          asks?: unknown;
          is_taker_buyer?: unknown;
          size?: unknown;
          price?: unknown;
          trade_id?: unknown;
          venue?: unknown;
          is_rpi?: unknown;
        };
      };
      if (
        message.stream === 'v1.trade'
        && typeof message.feed?.instrument === 'string'
      ) {
        const suffix = '_USDT_Perp';
        const coin = message.feed.instrument.endsWith(suffix)
          ? message.feed.instrument.slice(0, -suffix.length)
          : '';
        const market = byCoin.get(coin);
        const price = finite(message.feed.price);
        const size = finite(message.feed.size);
        const side = message.feed.is_taker_buyer === true
          ? 'BUY'
          : message.feed.is_taker_buyer === false
            ? 'SELL'
            : null;
        if (
          market
          && side
          && price > 0
          && size > 0
          && message.feed.venue === 'ORDERBOOK'
          && message.feed.is_rpi !== true
        ) {
          const trade: MakerShadowTrade = {
            id: `${market.coin}:${String(
              message.feed.trade_id
                ?? `${message.feed.event_time}:${price}:${size}:${side}`,
            )}`,
            coin: market.coin,
            side,
            price,
            size,
            tradeAt: normalizeExchangeTimestampMs(
              finite(message.feed.event_time),
              receivedAt,
            ),
          };
          grvtMakerShadow.processTrade(trade, receivedAt);
          grvtExtendedMakerShadow.processTrade(trade, receivedAt);
        }
        return;
      }
      if (
        message.stream !== 'v1.book.d'
        || typeof message.feed?.instrument !== 'string'
      ) return;
      const suffix = '_USDT_Perp';
      const coin = message.feed.instrument.endsWith(suffix)
        ? message.feed.instrument.slice(0, -suffix.length)
        : '';
      const market = byCoin.get(coin);
      const depth = market ? grvtDepth.get(market.coin) : null;
      const book = market ? books.get(bookKey('grvt', market.coin)) : null;
      if (!market || !depth || !book) return;
      const result = applyGrvtDepthUpdate(
        depth,
        message.sequence_number,
        message.prev_sequence_number,
        message.feed.bids,
        message.feed.asks,
      );
      if (result === 'gap' || result === 'invalid') {
        console.warn(`venue-arb grvt ${market.coin} depth ${result}; reconnecting`);
        ws.terminate();
        return;
      }
      if (result === 'duplicate') return;
      book.bids = new Map(depth.bids);
      book.asks = new Map(depth.asks);
      markBook(book, finite(message.feed.event_time), receivedAt);
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
    || now - buyBook.exchangeAt > SHADOW_SOURCE_FRESH_MS
    || now - sellBook.exchangeAt > SHADOW_SOURCE_FRESH_MS
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
    buyBookSourceAgeMs: Math.max(0, now - buyBook.exchangeAt),
    sellBookSourceAgeMs: Math.max(0, now - sellBook.exchangeAt),
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
    currentBuyBookSourceAgeMs: snapshot.buyBookSourceAgeMs,
    currentSellBookSourceAgeMs: snapshot.sellBookSourceAgeMs,
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
  opportunity.currentBuyBookSourceAgeMs = snapshot.buyBookSourceAgeMs;
  opportunity.currentSellBookSourceAgeMs = snapshot.sellBookSourceAgeMs;
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

function independentRows(rows: Opportunity[]): Opportunity[] {
  return independentSignalRows(
    rows,
    SHADOW_INDEPENDENCE_MS,
    (row) => `${row.buyVenue}→${row.sellVenue}:${row.coin}`,
    (row) => row.startedAt,
  );
}

function summary(rows: Opportunity[]): Record<string, unknown> {
  const closed = rows.filter((row) => (
    row.durationMs != null
    && Number.isFinite(row.startNetBps1000)
    && Number.isFinite(row.peakNetBps1000)
  ));
  const viable = closed.filter((row) => row.startNetBps1000 > NET_TRIGGER_BPS);
  const strictRawStarts = closed.filter(
    (row) => row.startNetBps1000 >= SHADOW_ENTRY_NET_BPS,
  );
  const strictStarts = independentRows(strictRawStarts);
  const strictObserved1000 = strictStarts.flatMap((row) => {
    const observed = row.horizons['1000']?.netBps1000;
    const netBps1000 = observed == null ? Number.NaN : Number(observed);
    return Number.isFinite(netBps1000) ? [netBps1000] : [];
  });
  const strictRetained1000 = strictStarts.filter(
    (row) => Number(row.horizons['1000']?.netBps1000) >= SHADOW_ENTRY_NET_BPS,
  );
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
    strictRawStarts: strictRawStarts.length,
    strictStarts: strictStarts.length,
    strictObserved1000: strictObserved1000.length,
    strictPositive1000: strictObserved1000.filter((value) => value > 0).length,
    strictRetained1000: strictRetained1000.length,
    strictRetained1000Pct: strictStarts.length
      ? strictRetained1000.length / strictStarts.length * 100
      : null,
    strictMean1000NetBps: strictObserved1000.length
      ? strictObserved1000.reduce((sum, value) => sum + value, 0) / strictObserved1000.length
      : null,
    strictMedian1000NetBps: percentile(strictObserved1000, 0.5),
    strictMin1000NetBps: percentile(strictObserved1000, 0),
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
  const routeStatuses = Object.fromEntries(SHADOW_ROUTES.map((route) => {
    const rows = shadowResults.filter((row) => row.routeId === route.id);
    return [route.id, {
      id: route.id,
      buyVenue: route.buyVenue,
      sellVenue: route.sellVenue,
      primary: route.primary,
      telemetry: shadowRouteTelemetry.get(route.id),
      measuredLatency: shadowLatencyProfile(route),
      readiness: shadowReadiness(
        rows,
        SHADOW_REQUIRED_SAMPLES,
        SHADOW_REQUIRED_PASS_PCT,
      ),
      active: [...shadowProbes.values()]
        .filter((probe) => probe.routeId === route.id)
        .sort((a, b) => a.signalAt - b.signalAt),
      recent: rows.slice(-20).reverse(),
    }];
  }));
  const primaryRoute = SHADOW_ROUTES.find((route) => route.primary);
  const primary = primaryRoute ? routeStatuses[primaryRoute.id] : undefined;
  return {
    version: 'multi-route-shadow-v4',
    config: {
      notionalUsd: SHADOW_NOTIONAL_USD,
      entryNetBps: SHADOW_ENTRY_NET_BPS,
      entryConfirmations: SHADOW_ENTRY_CONFIRMATIONS,
      exitNetBps: SHADOW_EXIT_NET_BPS,
      exitConfirmations: SHADOW_EXIT_CONFIRMATIONS,
      freshMs: SHADOW_FRESH_MS,
      sourceFreshMs: SHADOW_SOURCE_FRESH_MS,
      independenceMs: SHADOW_INDEPENDENCE_MS,
      maxHoldMs: SHADOW_MAX_HOLD_MS,
      fundingBpsPerHour: SHADOW_FUNDING_BPS_PER_HOUR,
      executionBufferBps: EXECUTION_BUFFER_BPS,
    },
    measuredLatency: primary?.measuredLatency,
    readiness: primary?.readiness,
    active: primary?.active,
    recent: primary?.recent,
    routes: routeStatuses,
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
    makerShadow: makerShadowStatus(),
    grvtMakerShadow: grvtMakerShadow.status(),
    grvtExtendedMakerShadow: grvtExtendedMakerShadow.status(),
    extendedAsterMakerShadow: extendedAsterMakerShadow.status(),
    freshnessMs: Object.fromEntries(MARKETS.map((market) => [
      market.coin,
      Object.fromEntries(VENUES.map((venue) => [
        venue,
        books.get(bookKey(venue, market.coin))?.receivedAt
          ? Math.max(
            0,
            now - (books.get(bookKey(venue, market.coin))?.receivedAt ?? 0),
            now - (books.get(bookKey(venue, market.coin))?.exchangeAt ?? 0),
          )
          : null,
      ])),
    ])),
  };
  const tmp = `${STATUS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, STATUS_PATH);
  atomicJson(SHADOW_ACTIVE_PATH, {
    probes: [...shadowProbes.values()],
    latched: [...shadowLatched],
    telemetry: Object.fromEntries(shadowRouteTelemetry),
  });
  writeMakerActive();
}

function writeExecutionStatus(): void {
  const now = Date.now();
  const liveMakerQuote = makerEntryQuoteCandidate(now);
  if (liveMakerQuote) {
    liveMakerQuote.activeAt = now;
    liveMakerQuote.activatedAt = now;
    liveMakerQuote.expiresAt = now + MAKER_QUOTE_TTL_MS;
  }
  const closingQuotes = Object.fromEntries(MARKETS.map((market) => {
    const extended = executableBook('extended', market.coin);
    const lighter = executableBook('lighter', market.coin);
    return [market.coin, {
      // Conservative for the $300 canary: use $500 executable VWAP rather
      // than top-of-book when estimating whether both closing legs are net+.
      notionalUsd: 500,
      extendedBuyVwap: extended?.buyVwap500 ?? null,
      extendedSellVwap: extended?.sellVwap500 ?? null,
      lighterBuyVwap: lighter?.buyVwap500 ?? null,
      lighterSellVwap: lighter?.sellVwap500 ?? null,
      extendedBookAgeMs: extended?.receivedAt ? now - extended.receivedAt : null,
      lighterBookAgeMs: lighter?.receivedAt ? now - lighter.receivedAt : null,
      extendedSourceAgeMs: extended?.exchangeAt
        ? Math.max(0, now - extended.exchangeAt)
        : null,
      lighterSourceAgeMs: lighter?.exchangeAt
        ? Math.max(0, now - lighter.exchangeAt)
        : null,
    }];
  }));
  const status = {
    version: 'venue-arb-execution-v2',
    updatedAt: now,
    sampleMs: SAMPLE_MS,
    closingQuotes,
    maker: {
      quote: liveMakerQuote,
    },
    active: [...active.values()]
      .filter((row) => (
        row.buyVenue === 'extended' && row.sellVenue === 'lighter'
      ) || (
        row.buyVenue === 'lighter' && row.sellVenue === 'extended'
      ))
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
        currentBuyBookSourceAgeMs: row.currentBuyBookSourceAgeMs,
        currentSellBookSourceAgeMs: row.currentSellBookSourceAgeMs,
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
    for (const row of shadowResults) {
      const key = `${row.routeId}:${row.coin}`;
      shadowLastSignalAt.set(
        key,
        Math.max(shadowLastSignalAt.get(key) ?? 0, Number(row.signalAt ?? 0)),
      );
    }
  } catch (error) {
    console.warn('venue-arb shadow history load', (error as Error).message);
    shadowResults = [];
  }
  try {
    if (!existsSync(SHADOW_ACTIVE_PATH)) return;
    const checkpoint = JSON.parse(readFileSync(SHADOW_ACTIVE_PATH, 'utf8')) as {
      probes?: ShadowProbe[];
      latched?: string[];
      telemetry?: Record<string, ShadowRouteTelemetry>;
    } | ShadowProbe[];
    const rows = Array.isArray(checkpoint) ? checkpoint : checkpoint.probes ?? [];
    for (const row of rows) {
      if (!row?.id || !row.opportunityId || !row.coin || !row.routeId) continue;
      shadowProbes.set(row.id, row);
      const key = `${row.routeId}:${row.coin}`;
      shadowLastSignalAt.set(
        key,
        Math.max(shadowLastSignalAt.get(key) ?? 0, Number(row.signalAt ?? 0)),
      );
    }
    const latched = Array.isArray(checkpoint) ? [] : checkpoint.latched ?? [];
    for (const key of latched) shadowLatched.add(key);
    const telemetry = Array.isArray(checkpoint) ? {} : checkpoint.telemetry ?? {};
    for (const [routeId, row] of Object.entries(telemetry)) {
      if (!shadowRouteTelemetry.has(routeId) || !row) continue;
      const defaults = emptyShadowRouteTelemetry();
      shadowRouteTelemetry.set(routeId, {
        ...defaults,
        ...row,
        rejections: {
          ...defaults.rejections,
          ...(row.rejections ?? {}),
        },
        currentRejections: {
          ...defaults.currentRejections,
          ...(row.currentRejections ?? {}),
        },
      });
    }
  } catch (error) {
    console.warn('venue-arb shadow active load', (error as Error).message);
    shadowProbes.clear();
    shadowLatched.clear();
  }
}

function loadMakerState(): void {
  try {
    makerResults = tailLines(MAKER_RESULTS_PATH)
      .slice(-5_000)
      .map((line) => JSON.parse(line) as MakerResult);
    const latestClosedAt = makerResults.reduce(
      (latest, row) => Math.max(latest, Number(row.closedAt ?? 0)),
      0,
    );
    makerCooldownUntil = latestClosedAt + MAKER_INDEPENDENCE_MS;
  } catch (error) {
    console.warn('venue-arb maker history load', (error as Error).message);
    makerResults = [];
  }
  try {
    if (!existsSync(MAKER_ACTIVE_PATH)) return;
    const checkpoint = JSON.parse(readFileSync(MAKER_ACTIVE_PATH, 'utf8')) as {
      pair?: MakerPair | null;
      pendingHedge?: MakerPendingHedge | null;
      cooldownUntil?: number;
    };
    if (
      checkpoint.pair?.id
      && checkpoint.pair.coin
      && checkpoint.pair.quantity > 0
    ) makerPair = checkpoint.pair;
    if (
      checkpoint.pendingHedge?.coin
      && checkpoint.pendingHedge.extendedFill > 0
    ) makerPendingHedge = checkpoint.pendingHedge;
    makerCooldownUntil = Math.max(
      makerCooldownUntil,
      Number(checkpoint.cooldownUntil ?? 0),
    );
  } catch (error) {
    console.warn('venue-arb maker active load', (error as Error).message);
    makerPair = null;
    makerPendingHedge = null;
  }
}

function loadGenericMakerState(
  shadow: GenericMakerShadow,
  resultsPath: string,
  activePath: string,
  label: string,
): void {
  let results: GenericMakerResult[] = [];
  let checkpoint: GenericMakerCheckpoint | null = null;
  try {
    results = tailLines(resultsPath)
      .slice(-5_000)
      .map((line) => JSON.parse(line) as GenericMakerResult);
  } catch (error) {
    console.warn(
      `venue-arb ${label} history load`,
      (error as Error).message,
    );
  }
  try {
    if (existsSync(activePath)) {
      checkpoint = JSON.parse(
        readFileSync(activePath, 'utf8'),
      ) as GenericMakerCheckpoint;
    }
  } catch (error) {
    console.warn(
      `venue-arb ${label} active load`,
      (error as Error).message,
    );
  }
  shadow.restore(results, checkpoint);
}

function genericMakerMarkets(
  makerVenue: 'grvt' | 'extended',
  hedgeVenue: 'lighter' | 'extended' | 'aster',
) {
  return MARKETS.map((market) => {
    const maker = books.get(bookKey(makerVenue, market.coin)) ?? null;
    const hedge = executableBook(hedgeVenue, market.coin);
    return {
      coin: market.coin,
      maker,
      hedge: hedge
        ? {
          buyVwap: hedge.buyVwap500,
          sellVwap: hedge.sellVwap500,
          exchangeAt: hedge.exchangeAt,
          receivedAt: hedge.receivedAt,
        }
        : null,
    };
  });
}

function prepareMakerShutdown(now: number): void {
  if (
    makerQuote?.firstFillAt != null
    && makerQuote.queue.remaining < makerQuote.initialQuantity
  ) {
    completeMakerPartialFailure(makerQuote, now);
  }
  makerQuote = null;
  writeMakerActive();
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(evaluationTimer);
  clearInterval(statusTimer);
  clearInterval(feedWatchdogTimer);
  // A service restart is not market convergence and must not contaminate the
  // decay distribution with artificial "closed" opportunities.
  active.clear();
  prepareMakerShutdown(Date.now());
  grvtMakerShadow.shutdown(Date.now());
  grvtExtendedMakerShadow.shutdown(Date.now());
  extendedAsterMakerShadow.shutdown(Date.now());
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
if (!existsSync(MAKER_RESULTS_PATH)) writeFileSync(MAKER_RESULTS_PATH, '');
if (!existsSync(GRVT_MAKER_RESULTS_PATH)) {
  writeFileSync(GRVT_MAKER_RESULTS_PATH, '');
}
if (!existsSync(GRVT_EXTENDED_MAKER_RESULTS_PATH)) {
  writeFileSync(GRVT_EXTENDED_MAKER_RESULTS_PATH, '');
}
if (!existsSync(EXTENDED_ASTER_MAKER_RESULTS_PATH)) {
  writeFileSync(EXTENDED_ASTER_MAKER_RESULTS_PATH, '');
}
loadHistory();
loadShadowState();
loadMakerState();
loadGenericMakerState(
  grvtMakerShadow,
  GRVT_MAKER_RESULTS_PATH,
  GRVT_MAKER_ACTIVE_PATH,
  'GRVT maker → Lighter',
);
loadGenericMakerState(
  grvtExtendedMakerShadow,
  GRVT_EXTENDED_MAKER_RESULTS_PATH,
  GRVT_EXTENDED_MAKER_ACTIVE_PATH,
  'GRVT maker → Extended',
);
loadGenericMakerState(
  extendedAsterMakerShadow,
  EXTENDED_ASTER_MAKER_RESULTS_PATH,
  EXTENDED_ASTER_MAKER_ACTIVE_PATH,
  'Extended maker → Aster',
);
startedAt = Date.now();
startLighter();
startHyperliquid();
startParadex();
startPolymarket();
startExtended();
startExtendedTrades();
startAster();
startPacifica();
startGrvt();
startBinance();
startBybit();
const evaluationTimer = setInterval(() => {
  evaluate();
  evaluateMakerShadow(Date.now());
  grvtMakerShadow.evaluate(
    Date.now(),
    genericMakerMarkets('grvt', 'lighter'),
  );
  grvtExtendedMakerShadow.evaluate(
    Date.now(),
    genericMakerMarkets('grvt', 'extended'),
  );
  extendedAsterMakerShadow.evaluate(
    Date.now(),
    genericMakerMarkets('extended', 'aster'),
  );
  writeExecutionStatus();
}, SAMPLE_MS);
const statusTimer = setInterval(writeStatus, 1_000);
const feedWatchdogTimer = setInterval(reconnectStalledFeeds, 5_000);
writeStatus();
writeExecutionStatus();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.warn(
  `venue-arb read-only started: ${VENUES.join(',')} · ${MARKETS.map((m) => m.coin).join(',')} @ ${SAMPLE_MS}ms`,
);

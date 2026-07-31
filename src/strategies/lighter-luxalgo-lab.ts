import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  evaluateNativeForwardRows,
  estimatedFundingPnlPct,
  LUXALGO_SHADOW_NOTIONAL_USD,
  NATIVE_SHADOW_NOTIONAL_USD,
  pricePnlPct,
  quoteNotionalVwap,
  shadowExecutionNotionalUsd,
  type NativeForwardGateEvaluation,
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
  portfolioId?: string;
  backtest: {
    period: string;
    trades: number;
    winRatePct: number;
    profitFactor: number;
    netPct: number;
    maxDrawdownPct: number;
  };
};

const NATIVE_TREND_PORTFOLIO_ID = 'z60stack25-portfolio';
const NATIVE_TREND_PORTFOLIO_MAX_OPEN = 10;
const NATIVE_TREND_PORTFOLIO_MARKETS = [
  { id: 'z60stack25-btc', code: '036', symbol: 'BTCUSDT', asset: 'BTC', marketId: 1 },
  { id: 'z60stack25-eth', code: '037', symbol: 'ETHUSDT', asset: 'ETH', marketId: 0 },
  { id: 'z60stack25-sol', code: '038', symbol: 'SOLUSDT', asset: 'SOL', marketId: 2 },
  { id: 'z60stack25-bnb', code: '039', symbol: 'BNBUSDT', asset: 'BNB', marketId: 25 },
  { id: 'z60stack25-ltc', code: '040', symbol: 'LTCUSDT', asset: 'LTC', marketId: 35 },
  { id: 'z60stack25-hype', code: '041', symbol: 'HYPEUSDT', asset: 'HYPE', marketId: 24 },
  { id: 'z60stack25-zec', code: '042', symbol: 'ZECUSDT', asset: 'ZEC', marketId: 90 },
  { id: 'z60stack25-doge', code: '043', symbol: 'DOGEUSDT', asset: 'DOGE', marketId: 3 },
  { id: 'z60stack25-near', code: '044', symbol: 'NEARUSDT', asset: 'NEAR', marketId: 10 },
  { id: 'z60stack25-jup', code: '045', symbol: 'JUPUSDT', asset: 'JUP', marketId: 26 },
  { id: 'z60stack25-lit', code: '046', symbol: 'LITUSDT', asset: 'LIT', marketId: 120 },
  { id: 'z60stack25-gram', code: '047', symbol: 'GRAMUSDT', asset: 'GRAM', marketId: 12 },
  { id: 'z60stack25-xmr', code: '048', symbol: 'XMRUSDT', asset: 'XMR', marketId: 77 },
  { id: 'z60stack25-ena', code: '049', symbol: 'ENAUSDT', asset: 'ENA', marketId: 29 },
  { id: 'z60stack25-tao', code: '050', symbol: 'TAOUSDT', asset: 'TAO', marketId: 13 },
] as const;

const t = (lang: Lang, ru: string, en: string): string => lang === 'en' ? en : ru;
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
// STRAT-030 is an independently reproduced SOL 5m Z-score reclaim model using
// native Lighter candles, next-bar execution, zero commission, 5 bps
// round-trip execution/funding stress. It stayed positive over
// every 30/60/90/120/180-day window and in both directions. It entered an
// isolated $100-notional / 10x real canary on 2026-07-30. New Real entries
// were paused again on 2026-07-31 until the frozen 20-close prospective gate
// passes; existing positions keep their exchange stop and exit handling.
// STRAT-031 is the adjacent, earlier
// three-sigma touch entry. It is the highest-frequency member of the stable
// Z60 neighborhood that still clears the base execution-stress gate. It stayed
// positive over 30/60/90/120/180-day windows and in both directions, but is
// highly correlated with STRAT-030 and has a larger historical drawdown, so it
// is prospective Shadow only and is deliberately absent from the real runner.
// STRAT-032 and STRAT-033 apply the same completed-bar touch family to BNB and
// LTC, using thresholds selected from broad profitable neighborhoods rather
// than a single peak. Both stayed positive on 30/60/90/120/180-day windows,
// in both directions and after 0.05% round-trip execution/funding stress. On
// the user's earlier instruction, STRAT-032/033 were admitted as separately
// risk-capped $100/10x Real canaries before their normal forward gate. That
// exception is now removed: they remain registered in the executor, but new
// Real entries are disabled until their frozen prospective gate passes.
// STRAT-034 is a BTC volume-weighted Z60 touch model. It passed 180d,
// chronological folds, IS/OOS, both directions and 30/60/90d windows after a
// conservative 0.065% round-trip execution/funding stress. Its one-sided 95%
// lower confidence bound is only marginally positive, so it starts in
// prospective Shadow and is deliberately excluded from the Real allowlist.
// STRAT-035 applies the same completed-bar volume-weighted family to HYPE at
// 2.5 sigma. It passed 180d, four chronological folds, both sides and every
// recent window even after 0.15% round-trip stress. It still starts in
// prospective Shadow because no historical result substitutes for forward
// execution evidence.
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
  {
    id: 'sol-z60-reclaim',
    code: '030',
    name: 'Z60 · 3σ Reclaim · Mean Exit',
    symbol: 'SOLUSDT',
    asset: 'SOL',
    marketId: 2,
    stopPct: 1.5,
    backtest: {
      // Native Lighter 1m candles aggregated into complete 5m bars. Signals
      // use completed candles and fill at the next bar open. Net includes
      // 0.05% round-trip execution/funding stress.
      period: '2026-02-01 → 2026-07-30',
      trades: 457,
      winRatePct: 63.9,
      profitFactor: 1.21,
      netPct: 37.93,
      maxDrawdownPct: 21.85,
    },
  },
  {
    id: 'sol-z60-touch',
    code: '031',
    name: 'Z60 · 3σ Touch · Mean Exit',
    symbol: 'SOLUSDT',
    asset: 'SOL',
    marketId: 2,
    stopPct: 1.5,
    backtest: {
      // Native Lighter 1m candles aggregated into complete 5m bars. Signals
      // use completed candles and fill at the next bar open. Net includes
      // 0.05% round-trip execution/funding stress.
      // No real fan-out: this correlated variant must earn its own forward
      // record before capital is considered.
      period: '2026-02-01 → 2026-07-30',
      trades: 462,
      winRatePct: 63.4,
      profitFactor: 1.19,
      netPct: 39.46,
      maxDrawdownPct: 24.22,
    },
  },
  {
    id: 'bnb-z60-touch',
    code: '032',
    name: 'Z60 · 3σ Touch · Mean Exit',
    symbol: 'BNBUSDT',
    asset: 'BNB',
    marketId: 25,
    stopPct: 1.5,
    backtest: {
      // Native Lighter completed 5m candles, next-bar execution and 0.05%
      // round-trip execution/funding stress. The full 180d sample is
      // two-sided, while the recent 30d long side is weak, so this canary must
      // not be scaled from backtest evidence alone.
      period: '2026-02-01 → 2026-07-30',
      trades: 415,
      winRatePct: 68.2,
      profitFactor: 1.37,
      netPct: 45.95,
      maxDrawdownPct: 11.87,
    },
  },
  {
    id: 'ltc-z60-touch',
    code: '033',
    name: 'Z60 · 2σ Touch · Mean Exit',
    symbol: 'LTCUSDT',
    asset: 'LTC',
    marketId: 35,
    stopPct: 1.5,
    backtest: {
      // Native Lighter completed 5m candles, next-bar execution and 0.05%
      // round-trip execution/funding stress.
      // Periods 50/60/70 and thresholds 1.75/2.0/2.25 all passed, reducing
      // single-parameter selection risk.
      period: '2026-02-01 → 2026-07-30',
      trades: 972,
      winRatePct: 68.0,
      profitFactor: 1.27,
      netPct: 80.40,
      maxDrawdownPct: 28.22,
    },
  },
  {
    id: 'btc-vwz60-touch',
    code: '034',
    name: 'Volume Z60 · 3σ Touch · VWMA Exit',
    symbol: 'BTCUSDT',
    asset: 'BTC',
    marketId: 1,
    stopPct: 1.5,
    backtest: {
      // Native Lighter completed 5m candles and next-bar execution. The
      // displayed historical row used a conservative 0.065% sensitivity
      // reserve; current qualification uses measured market-specific $100
      // L2 p95 plus funding instead of a fixed cost. Prospective Shadow only.
      period: '2026-02-01 → 2026-07-30',
      trades: 103,
      winRatePct: 68.0,
      profitFactor: 1.58,
      netPct: 12.94,
      maxDrawdownPct: 5.90,
    },
  },
  {
    id: 'hype-vwz60-touch',
    code: '035',
    name: 'Volume Z60 · 2.5σ Touch · VWMA Exit',
    symbol: 'HYPEUSDT',
    asset: 'HYPE',
    marketId: 24,
    stopPct: 1.5,
    backtest: {
      // Native Lighter completed 5m candles and next-bar execution. The
      // displayed historical row used a conservative 0.065% sensitivity
      // reserve. Current qualification uses measured market-specific $100
      // L2 p95 plus funding; 0.10/0.15% were non-blocking robustness rows.
      period: '2026-02-01 → 2026-07-31',
      trades: 356,
      winRatePct: 64.3,
      profitFactor: 1.47,
      netPct: 74.52,
      maxDrawdownPct: 13.62,
    },
  },
  ...NATIVE_TREND_PORTFOLIO_MARKETS.map((market): StrategySpec => ({
    ...market,
    portfolioId: NATIVE_TREND_PORTFOLIO_ID,
    name: 'Portfolio Z60 · 2.5σ Touch · EMA200/400 Stack · Mean Exit',
    stopPct: 1.5,
    backtest: {
      // One fixed rule across all 15 markets. These are portfolio-level
      // metrics after each market's measured p95 execution cost, adverse
      // funding and a maximum of ten naturally concurrent $100 positions.
      period: '2026-02-01 → 2026-07-31',
      trades: 758,
      winRatePct: 70.1,
      profitFactor: 1.45,
      netPct: 122.80,
      maxDrawdownPct: 2.45,
    },
  })),
] as const;

const STRATEGY_BY_ID = new Map(STRATEGIES.map((spec) => [spec.id, spec]));
const STRATEGY_IDS = STRATEGIES.map((spec) => spec.id);
const NATIVE_STRATEGY_IDS = [
  'sol-z60-reclaim',
  'sol-z60-touch',
  'bnb-z60-touch',
  'ltc-z60-touch',
  'btc-vwz60-touch',
  'hype-vwz60-touch',
  ...NATIVE_TREND_PORTFOLIO_MARKETS.map((market) => market.id),
] as const;
const NATIVE_LIVE_STRATEGY_IDS = [
  'sol-z60-reclaim',
  'bnb-z60-touch',
  'ltc-z60-touch',
] as const;

type NativeStrategyInfo = {
  family: 'zscore' | 'vwz';
  mode: 'reclaim' | 'touch';
  threshold: number;
  period: number;
  timeExitBars: number;
  trendFilter?: 'ema200' | 'ema200_400';
  realEnabled: boolean;
  noteRu: string;
  noteEn: string;
};

const NATIVE_STRATEGY_INFO: Readonly<Record<string, NativeStrategyInfo>> = {
  'sol-z60-reclaim': {
    family: 'zscore',
    mode: 'reclaim',
    threshold: 3,
    period: 60,
    timeExitBars: 240,
    realEnabled: true,
    noteRu: 'Основной SOL-canary: вход позже touch-варианта, после подтверждённого возврата цены внутрь диапазона.',
    noteEn: 'Primary SOL canary: it enters later than the touch variant, after price confirms a return inside the band.',
  },
  'sol-z60-touch': {
    family: 'zscore',
    mode: 'touch',
    threshold: 3,
    period: 60,
    timeExitBars: 240,
    realEnabled: false,
    noteRu: 'Более ранний и частый SOL-вход. Только Shadow: 180-дневный PF 1.19 ниже гейта 1.20 и сделки сильно коррелируют со STRAT-030.',
    noteEn: 'Earlier and more frequent SOL entry. Shadow only: 180-day PF 1.19 is below the 1.20 gate and trades are highly correlated with STRAT-030.',
  },
  'bnb-z60-touch': {
    family: 'zscore',
    mode: 'touch',
    threshold: 3,
    period: 60,
    timeExitBars: 240,
    realEnabled: true,
    noteRu: 'BNB-canary. Полный 180-дневный тест двухсторонний, но свежая 30-дневная long-часть слабая — масштабирование запрещено до подтверждения forward.',
    noteEn: 'BNB canary. The full 180-day test is two-sided, but the recent 30-day long book is weak, so scaling is blocked pending forward evidence.',
  },
  'ltc-z60-touch': {
    family: 'zscore',
    mode: 'touch',
    threshold: 2,
    period: 60,
    timeExitBars: 240,
    realEnabled: true,
    noteRu: 'Самый частый вариант: более близкий порог ±2σ даёт больше входов. Из-за исторической просадки 28.22% остаётся малым canary.',
    noteEn: 'Highest-frequency variant: the closer ±2σ threshold creates more entries. Its 28.22% historical drawdown keeps it at small-canary size.',
  },
  'btc-vwz60-touch': {
    family: 'vwz',
    mode: 'touch',
    threshold: 3,
    period: 60,
    timeExitBars: 240,
    realEnabled: false,
    noteRu: 'Новый BTC-кандидат. Прошёл 180d, 4/4 периода, IS/OOS, Long/Short и окна 30/60/90d. Для отбора используется измеренный p95 стака, а не фиксированный «стресс». L95 лишь немного выше нуля — только prospective Shadow.',
    noteEn: 'New BTC candidate. It passed 180d, 4/4 folds, IS/OOS, Long/Short and 30/60/90d windows. Selection uses measured book p95 rather than a fixed stress assumption. L95 is only marginally above zero, so it is prospective Shadow only.',
  },
  'hype-vwz60-touch': {
    family: 'vwz',
    mode: 'touch',
    threshold: 2.5,
    period: 60,
    timeExitBars: 240,
    realEnabled: false,
    noteRu: 'Новый HYPE-кандидат. Прошёл 180d, 4/4 периода, IS/OOS, Long/Short и окна 30/60/90d. Сценарий 0.15% был только неблокирующей проверкой, а не оценкой издержек. Отбор и Shadow используют измеренный p95 стака.',
    noteEn: 'New HYPE candidate. It passed 180d, 4/4 folds, IS/OOS, Long/Short and 30/60/90d windows. The 0.15% row was a non-blocking adverse scenario, not an execution-cost estimate. Selection and Shadow use measured book p95.',
  },
  ...Object.fromEntries(NATIVE_TREND_PORTFOLIO_MARKETS.map((market) => [
    market.id,
    {
      family: 'zscore' as const,
      mode: 'touch' as const,
      threshold: 2.5,
      period: 60,
      timeExitBars: 240,
      trendFilter: 'ema200_400' as const,
      realEnabled: false,
      noteRu: `Нога единого ${market.asset}-портфеля P2. Одно правило без подбора по монете; вход только при согласованных EMA200/EMA400. Real отключён до общего prospective forward-гейта.`,
      noteEn: `${market.asset} leg of the unified P2 portfolio. One rule with no per-market tuning; entry requires aligned EMA200/EMA400. Real is disabled until the combined prospective forward gate passes.`,
    },
  ])),
};

const NATIVE_STRATEGIES = NATIVE_STRATEGY_IDS.map((id) => STRATEGY_BY_ID.get(id)!);
const NATIVE_STRATEGY_ID_SET = new Set<string>(NATIVE_STRATEGY_IDS);
const NATIVE_TREND_PORTFOLIO_STRATEGIES = NATIVE_TREND_PORTFOLIO_MARKETS
  .map((market) => STRATEGY_BY_ID.get(market.id)!);
const NATIVE_TREND_PORTFOLIO_IDS = NATIVE_TREND_PORTFOLIO_STRATEGIES
  .map((spec) => spec.id);
const NATIVE_TREND_PORTFOLIO_ID_SET = new Set(NATIVE_TREND_PORTFOLIO_IDS);
const NATIVE_STANDALONE_STRATEGIES = NATIVE_STRATEGIES.filter(
  (spec) => !spec.portfolioId,
);
const LUXALGO_STRATEGIES = STRATEGIES.filter(
  (spec) => !NATIVE_STRATEGY_ID_SET.has(spec.id),
);

function shadowNotionalUsd(spec: StrategySpec): number {
  return shadowExecutionNotionalUsd(NATIVE_STRATEGY_ID_SET.has(spec.id));
}

function isNativeIdScope(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => NATIVE_STRATEGY_ID_SET.has(id));
}

function signalCohortClause(ids: readonly string[], alias = ''): string {
  return isNativeIdScope(ids)
    ? ` AND ${alias}execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}`
    : '';
}

function tradeCohortClause(ids: readonly string[], alias = ''): string {
  return isNativeIdScope(ids)
    ? ` AND ${alias}notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}`
    : '';
}

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
  notionalUsd: number;
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
  shadow_decision_reason: string | null;
  execution_notional_usd: number;
};

type OpenTradeRow = {
  id: number;
  side: Side;
  opened_at: number;
  entry_price: number;
  notional_usd: number;
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
  currentDrawdownUsd: number;
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
  legacyOpen: number;
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
  forwardGate: NativeForwardGateEvaluation | null;
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
     received_at, capture_due_at, source_price, execution_notional_usd,
     native_er60)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const markCaptureError = db.prepare(`
  UPDATE lighter_lux_signals
  SET captured_at = ?, capture_status = 'error', capture_error = ?
  WHERE id = ?`);
const markCaptured = db.prepare(`
  UPDATE lighter_lux_signals
  SET captured_at = ?, capture_status = 'captured', capture_error = NULL,
      shadow_decision_reason = NULL,
      book_exchange_at = ?, book_age_ms = ?, bid = ?, ask = ?,
      buy_vwap_1000 = ?, sell_vwap_1000 = ?, spread_pct = ?,
      buy_slippage_pct = ?, sell_slippage_pct = ?, funding_rate_pct_h = ?,
      index_price = ?, mark_price = ?
  WHERE id = ?`);
const findOpenTrade = db.prepare<[string], OpenTradeRow>(`
  SELECT id, side, opened_at, entry_price, notional_usd
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
const markShadowDecision = db.prepare(`
  UPDATE lighter_lux_signals SET shadow_decision_reason = ? WHERE id = ?`);
const nativeForwardPnls = db.prepare<[string], {
  net_pnl_pct: number;
  side: Side;
  symbol: string;
  opened_at: number;
  closed_at: number;
}>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id = ? AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
  ORDER BY closed_at, id`);
const nativeForwardSignals = db.prepare<[string], {
  capture_status: string;
  book_age_ms: number | null;
  bid: number | null;
  ask: number | null;
  buy_slippage_pct: number | null;
  sell_slippage_pct: number | null;
}>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals
  WHERE strategy_id = ?
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);

const nativePortfolioForwardPnls = db.prepare<string[], {
  net_pnl_pct: number;
  side: Side;
  symbol: string;
  opened_at: number;
  closed_at: number;
}>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id IN (${sqlMarks(NATIVE_TREND_PORTFOLIO_IDS)})
    AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
  ORDER BY closed_at, id`);
const nativePortfolioForwardSignals = db.prepare<string[], {
  capture_status: string;
  book_age_ms: number | null;
  bid: number | null;
  ask: number | null;
  buy_slippage_pct: number | null;
  sell_slippage_pct: number | null;
}>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals
  WHERE strategy_id IN (${sqlMarks(NATIVE_TREND_PORTFOLIO_IDS)})
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);
const nativePortfolioOpenCount = db.prepare<string[], { count: number }>(`
  SELECT COUNT(*) count FROM lighter_lux_trades
  WHERE strategy_id IN (${sqlMarks(NATIVE_TREND_PORTFOLIO_IDS)})
    AND closed_at IS NULL`);

function evaluateForwardRows(
  pnlRows: readonly {
    net_pnl_pct: number;
    side: Side;
    symbol: string;
    opened_at: number;
    closed_at: number;
  }[],
  signalRows: readonly {
    capture_status: string;
    book_age_ms: number | null;
    bid: number | null;
    ask: number | null;
    buy_slippage_pct: number | null;
    sell_slippage_pct: number | null;
  }[],
  drawdownCapacityUnits = 1,
  minUniqueSymbols = 1,
): NativeForwardGateEvaluation {
  return evaluateNativeForwardRows(
    pnlRows,
    signalRows,
    drawdownCapacityUnits,
    minUniqueSymbols,
  );
}

function nativeForwardGate(strategyId: string): NativeForwardGateEvaluation {
  const signalRows = nativeForwardSignals.all(strategyId);
  return evaluateForwardRows(nativeForwardPnls.all(strategyId), signalRows);
}

function nativeTrendPortfolioForwardGate(): NativeForwardGateEvaluation {
  return evaluateForwardRows(
    nativePortfolioForwardPnls.all(...NATIVE_TREND_PORTFOLIO_IDS),
    nativePortfolioForwardSignals.all(...NATIVE_TREND_PORTFOLIO_IDS),
    NATIVE_TREND_PORTFOLIO_MAX_OPEN,
    4,
  );
}

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

function executionSnapshot(
  spec: StrategySpec,
  notionalUsd = shadowNotionalUsd(spec),
): ExecutionSnapshot | { error: string } {
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

  const buyVwap = quoteNotionalVwap(asks, notionalUsd);
  const sellVwap = quoteNotionalVwap(bids, notionalUsd);
  if (buyVwap == null || sellVwap == null)
    return { error: `${spec.asset.toLowerCase()}_depth_below_${notionalUsd}` };

  const mid = (bid + ask) / 2;
  return {
    notionalUsd,
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
    // A signal belongs to the new target cohort, but an already-open legacy
    // trade must be exited at its own executable notional. This lets the old
    // $1,000 cohort drain honestly while a reverse signal opens a fresh $100
    // Native position from the same in-memory book.
    const closeSnap = Math.abs(open.notional_usd - snap.notionalUsd) < 0.01
      ? snap
      : executionSnapshot(spec, open.notional_usd);
    if ('error' in closeSnap) throw new Error(`legacy_close:${closeSnap.error}`);
    const exitPrice = open.side === 'long' ? closeSnap.sellVwap : closeSnap.buyVwap;
    const gross = pricePnlPct(open.side, open.entry_price, exitPrice);
    const entryRate = entryFunding.get(open.id)?.entry_funding_pct_h ?? 0;
    const funding = estimatedFundingPnlPct(
      open.side,
      entryRate,
      closeSnap.fundingRatePctH,
      closeSnap.capturedAt - open.opened_at,
    );
    closeTrade.run(
      signalId, closeSnap.capturedAt, exitPrice, closeSnap.fundingRatePctH,
      gross, funding, gross + funding,
      action === 'exit' ? 'strategy_exit' : 'reverse_signal',
      open.id,
    );
  }

  if (action === 'exit' || open?.side === side) return;
  if (NATIVE_STRATEGY_ID_SET.has(spec.id)) {
    const forward = nativeForwardGate(spec.id);
    if (!forward.entryAllowed) {
      const reason = `native forward gate failed after ${forward.closed}: ${forward.reasons.join('; ')}`;
      markShadowDecision.run(reason, signalId);
      return { gateBlocked: true, reason, forward };
    }
    if (NATIVE_TREND_PORTFOLIO_ID_SET.has(spec.id)) {
      const portfolioForward = nativeTrendPortfolioForwardGate();
      if (!portfolioForward.entryAllowed) {
        const reason = `native portfolio forward gate failed after ${portfolioForward.closed}: ${portfolioForward.reasons.join('; ')}`;
        markShadowDecision.run(reason, signalId);
        return { gateBlocked: true, reason, forward: portfolioForward };
      }
      const openCount = nativePortfolioOpenCount.get(
        ...NATIVE_TREND_PORTFOLIO_IDS,
      )?.count ?? 0;
      if (openCount >= NATIVE_TREND_PORTFOLIO_MAX_OPEN) {
        const reason = `native portfolio capacity ${openCount}/${NATIVE_TREND_PORTFOLIO_MAX_OPEN}`;
        markShadowDecision.run(reason, signalId);
        return { gateBlocked: true, reason, forward: portfolioForward };
      }
    }
  }
  const entryPrice = side === 'long' ? snap.buyVwap : snap.sellVwap;
  insertTrade.run(
    spec.id, spec.asset, side, signalId, snap.capturedAt, entryPrice,
    snap.fundingRatePctH, snap.notionalUsd,
  );
  return { gateBlocked: false };
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
    const result = applyCapturedSignal(spec, signalId, action, side, snap);
    if (result?.gateBlocked) {
      logger.warn({
        signalId,
        strategyId: spec.id,
        reason: result.reason,
      }, 'lighter-lux: native Shadow entry blocked by forward gate');
    }
  } catch (error) {
    markCaptureError.run(Date.now(), `capture_exception:${(error as Error).message}`, signalId);
    logger.error({ error, signalId, strategyId: spec.id }, 'lighter-lux: capture failed');
  }
}

/** Independent portfolio shadow; it never delays or changes Track C. */
export type NativeSignalDiagnostics = {
  efficiencyRatio60?: number | null;
};

export function queueLighterLuxalgoSignal(
  payload: LuxAlgoStrategyPayload,
  diagnostics?: NativeSignalDiagnostics,
): void {
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
    receivedAt, receivedAt, finite(payload.price), shadowNotionalUsd(spec),
    NATIVE_STRATEGY_ID_SET.has(spec.id)
      ? finite(diagnostics?.efficiencyRatio60)
      : null,
  );
  if (result.changes !== 1) return;
  capture(spec, Number(result.lastInsertRowid), action, side);
}

function checkSafetyStops(): void {
  for (const spec of STRATEGIES) {
    try {
      const open = findOpenTrade.get(spec.id);
      if (!open) continue;
      const snap = executionSnapshot(spec, open.notional_usd);
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

type StrategySpecScope = StrategySpec | readonly StrategySpec[] | undefined;
type StrategyIdScope = string | readonly string[] | null;

function specsForScope(scope: StrategySpecScope): readonly StrategySpec[] {
  if (!scope) return STRATEGIES;
  return Array.isArray(scope) ? scope : [scope as StrategySpec];
}

function idsForScope(scope: StrategyIdScope): readonly string[] {
  if (!scope) return STRATEGY_IDS;
  return typeof scope === 'string' ? [scope] : scope;
}

function sqlMarks(ids: readonly string[]): string {
  return ids.map(() => '?').join(', ');
}

function rowsForSummary(scope?: StrategySpecScope): Array<{
  net_pnl_pct: number;
  closed_at: number;
  notional_usd: number;
}> {
  const ids = specsForScope(scope).map((spec) => spec.id);
  return db.prepare<string[], {
    net_pnl_pct: number;
    closed_at: number;
    notional_usd: number;
  }>(`
    SELECT net_pnl_pct, closed_at, notional_usd FROM lighter_lux_trades
    WHERE strategy_id IN (${sqlMarks(ids)})
      ${tradeCohortClause(ids)}
      AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at, id`).all(...ids);
}

function summary(scope?: StrategySpecScope): Summary {
  const specs = specsForScope(scope);
  const params = specs.map((spec) => spec.id);
  const where = `strategy_id IN (${sqlMarks(params)})`;
  const signalCounts = db.prepare<string[], { total: number; errors: number }>(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN capture_status = 'error' THEN 1 ELSE 0 END), 0) errors
    FROM lighter_lux_signals WHERE ${where}
      ${signalCohortClause(params)}`).get(...params);
  const trades = rowsForSummary(specs);
  const open = db.prepare<string[], { count: number }>(`
    SELECT COUNT(*) count FROM lighter_lux_trades
    WHERE ${where} ${tradeCohortClause(params)}
      AND closed_at IS NULL`).get(...params)?.count ?? 0;
  const legacyOpen = isNativeIdScope(params)
    ? db.prepare<string[], { count: number }>(`
      SELECT COUNT(*) count FROM lighter_lux_trades
      WHERE ${where} AND closed_at IS NULL
        AND notional_usd != ${NATIVE_SHADOW_NOTIONAL_USD}`).get(...params)?.count ?? 0
    : 0;

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

  const snapshots = specs
    .map((item) => executionSnapshot(item))
    .filter((snap): snap is ExecutionSnapshot => !('error' in snap));
  const feedLive = snapshots.length === specs.length;
  const avg = (values: number[]): number | null =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const isTrendPortfolioScope = specs.length === NATIVE_TREND_PORTFOLIO_IDS.length
    && specs.every((spec) => NATIVE_TREND_PORTFOLIO_ID_SET.has(spec.id));
  const forwardGate = isTrendPortfolioScope
    ? nativeTrendPortfolioForwardGate()
    : specs.length === 1 && NATIVE_STRATEGY_ID_SET.has(specs[0]!.id)
      ? nativeForwardGate(specs[0]!.id)
      : null;

  return {
    feedLive,
    signals: signalCounts?.total ?? 0,
    captureErrors: signalCounts?.errors ?? 0,
    closed: trades.length,
    open,
    legacyOpen,
    netPct,
    netUsd: trades.reduce(
      (sum, row) => sum + row.net_pnl_pct / 100 * row.notional_usd,
      0,
    ),
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
    forwardGate,
  };
}

function recentSignals(
  limit: number,
  offset: number,
  strategyScope: StrategyIdScope = null,
): SignalRow[] {
  const strategyParams = idsForScope(strategyScope);
  const where = `signal.strategy_id IN (${sqlMarks(strategyParams)})`;
  return db.prepare<Array<string | number>, SignalRow>(`
    SELECT signal.id,signal.strategy_id,signal.symbol,signal.received_at,
           signal.captured_at,signal.action,signal.side,signal.source_price,
           signal.capture_status,signal.capture_error,signal.book_age_ms,
           signal.bid,signal.ask,signal.buy_vwap_1000,signal.sell_vwap_1000,
           signal.spread_pct,signal.buy_slippage_pct,signal.sell_slippage_pct,
           signal.funding_rate_pct_h,signal.shadow_decision_reason,
           signal.execution_notional_usd,
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
    WHERE ${where} ${signalCohortClause(strategyParams, 'signal.')}
    ORDER BY signal.received_at DESC
    LIMIT ? OFFSET ?`).all(...strategyParams, limit, offset);
}

function signalTotal(strategyScope: StrategyIdScope = null): number {
  const strategyParams = idsForScope(strategyScope);
  const where = `strategy_id IN (${sqlMarks(strategyParams)})`;
  return db.prepare<string[], { total: number }>(`
    SELECT COUNT(*) total FROM lighter_lux_signals
    WHERE ${where} ${signalCohortClause(strategyParams)}`).get(...strategyParams)?.total ?? 0;
}

function recentTrades(
  limit: number,
  offset: number,
  strategyScope: StrategyIdScope = null,
): TradeRow[] {
  const strategyParams = idsForScope(strategyScope);
  const where = `strategy_id IN (${sqlMarks(strategyParams)})`;
  const rows = db.prepare<string[], TradeRow>(`
    SELECT id, strategy_id, symbol, side, entry_signal_id, exit_signal_id,
           opened_at, closed_at, entry_price, entry_funding_pct_h,
           exit_price, gross_pnl_pct,
           funding_pnl_pct, net_pnl_pct, notional_usd, close_reason,
           NULL cumulative_net_pct, NULL strategy_cumulative_net_pct
    FROM lighter_lux_trades
    WHERE ${where} ${tradeCohortClause(strategyParams)}
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

function tradeTotal(strategyScope: StrategyIdScope = null): number {
  const strategyParams = idsForScope(strategyScope);
  const where = `strategy_id IN (${sqlMarks(strategyParams)})`;
  return db.prepare<string[], { total: number }>(`
    SELECT COUNT(*) total FROM lighter_lux_trades
    WHERE ${where} ${tradeCohortClause(strategyParams)}`).get(...strategyParams)?.total ?? 0;
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
  strategyScope: StrategyIdScope = null,
): LiveTradeRow[] {
  const strategyParams = idsForScope(strategyScope);
  const filter = `WHERE real.strategy_id IN (${sqlMarks(strategyParams)})`;
  const params: Array<string | number> = [...strategyParams, limit];
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

function liveTradeCounts(strategyScope: StrategyIdScope = null): LiveTradeCounts {
  const strategyParams = idsForScope(strategyScope);
  return db.prepare<string[], LiveTradeCounts>(`
    SELECT
      COALESCE(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END),0) closed,
      COALESCE(SUM(CASE WHEN status IN ('opening','open','closing') THEN 1 ELSE 0 END),0) open,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) errors
    FROM lighter_lux_live_trades
    WHERE strategy_id IN (${sqlMarks(strategyParams)})`).get(...strategyParams)
    ?? { closed: 0, open: 0, errors: 0 };
}

function liveDecisionCounts(strategyScope: StrategyIdScope = null): LiveDecisionCounts {
  const strategyParams = idsForScope(strategyScope);
  return db.prepare<string[], LiveDecisionCounts>(`
    SELECT
      COUNT(*) total,
      COALESCE(SUM(CASE WHEN decision.decision='error' THEN 1 ELSE 0 END),0) errors,
      COALESCE(SUM(CASE WHEN decision.decision='skip' THEN 1 ELSE 0 END),0) skipped
    FROM lighter_lux_live_decisions decision
    JOIN lighter_lux_signals signal ON signal.id=decision.signal_id
    WHERE signal.strategy_id IN (${sqlMarks(strategyParams)})`).get(...strategyParams)
    ?? { total: 0, errors: 0, skipped: 0 };
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
    currentDrawdownUsd: peak - equity,
  };
}

function liveExecutionComparison(
  strategyScope: StrategyIdScope = null,
): ExecutionComparison {
  const strategyParams = idsForScope(strategyScope);
  const rows = db.prepare<string[], {
    shadow_pct: number;
    real_pct: number;
  }>(`
    SELECT shadow.net_pnl_pct shadow_pct,real.net_pnl_pct real_pct
    FROM lighter_lux_live_trades real
    JOIN lighter_lux_trades shadow
      ON shadow.entry_signal_id=real.entry_signal_id
    WHERE real.status='closed' AND real.net_pnl_pct IS NOT NULL
      AND shadow.closed_at IS NOT NULL AND shadow.net_pnl_pct IS NOT NULL
      AND real.strategy_id IN (${sqlMarks(strategyParams)})
      ${tradeCohortClause(strategyParams, 'shadow.')}
    ORDER BY real.closed_at,real.id`).all(...strategyParams);
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

function cumulativePnlSeries(
  strategyScope: StrategyIdScope = null,
): { shadow: PnlPoint[]; live: PnlPoint[] } {
  const strategyParams = idsForScope(strategyScope);
  const shadowRows = db.prepare<string[], {
    closed_at: number;
    net_pnl_pct: number;
    notional_usd: number;
  }>(`
    SELECT closed_at,net_pnl_pct,notional_usd
    FROM lighter_lux_trades
    WHERE strategy_id IN (${sqlMarks(strategyParams)})
      ${tradeCohortClause(strategyParams)}
      AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at,id`).all(...strategyParams);
  const liveRows = db.prepare<string[], {
    closed_at: number;
    net_pnl_usd: number;
    net_pnl_pct: number;
  }>(`
    SELECT closed_at,net_pnl_usd,net_pnl_pct
    FROM lighter_lux_live_trades
    WHERE strategy_id IN (${sqlMarks(strategyParams)})
      AND status='closed' AND closed_at IS NOT NULL
      AND net_pnl_usd IS NOT NULL AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at,id`).all(...strategyParams);

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

function gate(
  s: Summary,
  lang: Lang,
  strictNative = false,
): { cls: string; label: string; passed: boolean } {
  if (strictNative && s.forwardGate) {
    if (s.forwardGate.status === 'collecting') return {
      cls: 'collect',
      label: t(
        lang,
        `КОПИМ ${s.forwardGate.closed}/${VALIDATION_TARGET}`,
        `COLLECTING ${s.forwardGate.closed}/${VALIDATION_TARGET}`,
      ),
      passed: false,
    };
    const passed = s.forwardGate.status === 'passed';
    return passed
      ? { cls: 'pass', label: t(lang, 'ГЕЙТ ПРОЙДЕН', 'GATE PASSED'), passed }
      : { cls: 'fail', label: t(lang, 'SHADOW ОСТАНОВЛЕН', 'SHADOW PAUSED'), passed };
  }
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

function nativeGateTitle(
  evaluation: NativeForwardGateEvaluation | null,
  lang: Lang,
): string {
  if (!evaluation) return '';
  const recentPf = evaluation.recentProfitFactor == null
    ? '—'
    : Number.isFinite(evaluation.recentProfitFactor)
      ? evaluation.recentProfitFactor.toFixed(2)
      : '∞';
  const recentBook = evaluation.recentP95BookAgeMs == null
    ? '—'
    : `${evaluation.recentP95BookAgeMs.toFixed(0)}ms`;
  return [
    ...evaluation.reasons,
    t(
      lang,
      `Последние сделки: ${evaluation.recentClosed}, net ${signedPct(evaluation.recentNetPct)}, PF ${recentPf}`,
      `Recent trades: ${evaluation.recentClosed}, net ${signedPct(evaluation.recentNetPct)}, PF ${recentPf}`,
    ),
    t(
      lang,
      `Последние сигналы: ${evaluation.recentSignalCount}, ошибки ${evaluation.recentCaptureErrorRatePct.toFixed(2)}%, L2 p95 ${recentBook}`,
      `Recent signals: ${evaluation.recentSignalCount}, errors ${evaluation.recentCaptureErrorRatePct.toFixed(2)}%, L2 p95 ${recentBook}`,
    ),
  ].join('; ');
}

function nativeDisplayStats(lang: Lang): {
  models: number;
  passed: number;
  backtestTrades: number;
} {
  const standalonePassed = NATIVE_STANDALONE_STRATEGIES.filter(
    (spec) => gate(summary(spec), lang, true).passed,
  ).length;
  const portfolioPassed = gate(
    summary(NATIVE_TREND_PORTFOLIO_STRATEGIES),
    lang,
    true,
  ).passed ? 1 : 0;
  return {
    models: NATIVE_STANDALONE_STRATEGIES.length + 1,
    passed: standalonePassed + portfolioPassed,
    backtestTrades: NATIVE_STANDALONE_STRATEGIES.reduce(
      (total, spec) => total + spec.backtest.trades,
      NATIVE_TREND_PORTFOLIO_STRATEGIES[0]!.backtest.trades,
    ),
  };
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
type PortfolioGroup = 'native' | null;

type NativeMicrostructureAudit = {
  generatedAt?: string;
  summary?: {
    markets?: number;
    minDurationDays?: number;
    minCoverageRatio?: number;
    minQualityRatio?: number;
    minExecutionCostRatio?: number;
    minFiveMinuteQualityRatio?: number;
    latestExecutionCostMarkets?: number;
    minLatestExecutionCostP95Pct?: number;
    maxLatestExecutionCostP95Pct?: number;
  };
  gates?: {
    collectionHealthy?: { passed?: boolean };
    exploratoryResearch?: { passed?: boolean };
    frozenCandidateResearch?: { passed?: boolean };
  };
  perMarket?: Array<{
    symbol?: string;
    latestExecutionCostP95Pct?: number | null;
  }>;
};

function nativeMicrostructureAudit(): NativeMicrostructureAudit | null {
  try {
    const path = resolve(
      process.env.LIGHTER_MICRO_AUDIT
        ?? 'data/lighter-native-microstructure-audit.json',
    );
    return JSON.parse(readFileSync(path, 'utf8')) as NativeMicrostructureAudit;
  } catch {
    return null;
  }
}

function nativeMicrostructureReadiness(
  lang: Lang,
  strategy: StrategySpec | null,
): string {
  const audit = nativeMicrostructureAudit();
  if (!audit?.summary) {
    return `<div class="ll-readiness"><b>Native data</b><span class="collect">${t(
      lang,
      'аудит ещё не сформирован',
      'audit not generated yet',
    )}</span></div>`;
  }

  const summary = audit.summary;
  const durationDays = summary.minDurationDays ?? 0;
  const qualityRatio = summary.minQualityRatio ?? 0;
  const executionRatio = summary.minExecutionCostRatio ?? 0;
  const fiveMinuteRatio = summary.minFiveMinuteQualityRatio ?? 0;
  const generatedAt = Date.parse(audit.generatedAt ?? '');
  const ageMinutes = Number.isFinite(generatedAt)
    ? Math.max(0, Math.round((Date.now() - generatedAt) / 60_000))
    : null;
  const specificCost = strategy
    ? audit.perMarket?.find((row) => row.symbol === strategy.asset)
      ?.latestExecutionCostP95Pct
    : null;
  const costMarkets = summary.latestExecutionCostMarkets ?? 0;
  const minCost = summary.minLatestExecutionCostP95Pct;
  const maxCost = summary.maxLatestExecutionCostP95Pct;
  const costLabel = specificCost != null && Number.isFinite(specificCost)
    ? `${strategy?.asset} ${specificCost.toFixed(4)}%`
    : minCost != null && maxCost != null && costMarkets > 0
      ? `${minCost.toFixed(4)}–${maxCost.toFixed(4)}% · ${costMarkets}/${NATIVE_TREND_PORTFOLIO_MARKETS.length}`
      : t(lang, 'накапливается', 'collecting');
  const gate = (
    label: string,
    passed: boolean | undefined,
  ): string => `<span><small>${label}</small><b class="${passed ? 'pass' : 'collect'}">${passed
    ? t(lang, 'готово', 'ready')
    : t(lang, 'сбор', 'collecting')}</b></span>`;

  return `<div class="ll-readiness" title="${t(
    lang,
    'Фактически исполнимый полный круг $100 по свежему L2; фиксированные 0,10/0,15% здесь не используются.',
    'Immediately executable $100 round trip from fresh L2; fixed 0.10/0.15% assumptions are not used here.',
  )}">
    <b>Native data v3</b>
    <span><small>${t(lang, 'история', 'history')}</small><b>${durationDays.toFixed(2)}d</b></span>
    <span><small>1m quality</small><b>${(qualityRatio * 100).toFixed(1)}%</b></span>
    <span><small>$100 cost coverage</small><b>${(executionRatio * 100).toFixed(1)}%</b></span>
    <span><small>${t(lang, 'измеренный RT p95', 'measured RT p95')}</small><b>${costLabel}</b></span>
    <span><small>5m quality</small><b>${(fiveMinuteRatio * 100).toFixed(1)}%</b></span>
    ${gate('1d', audit.gates?.collectionHealthy?.passed)}
    ${gate('7d', audit.gates?.exploratoryResearch?.passed)}
    ${gate('21d', audit.gates?.frozenCandidateResearch?.passed)}
    <em>${ageMinutes == null
    ? t(lang, 'время неизвестно', 'time unknown')
    : `${t(lang, 'обновлено', 'updated')} ${ageMinutes}m`}</em>
  </div>`;
}
function selectedGroup(value: unknown): PortfolioGroup {
  return value === 'native' ? 'native' : null;
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
  group?: PortfolioGroup;
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
  if (args.group) params.set('group', args.group);
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
  group?: PortfolioGroup;
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
      group: args.group,
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
.ll-native-hero{border-color:rgba(56,217,150,.42);background:linear-gradient(135deg,rgba(56,217,150,.13),rgba(92,163,255,.09),var(--bg-card))}
.ll-native-hero .ll-badge{background:rgba(56,217,150,.13);color:#38d996}
.ll-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(163,106,255,.15);color:#bd91ff;font-size:11px;font-weight:750;letter-spacing:.04em}
.ll-title{font-size:19px;font-weight:700;margin-top:8px}.ll-sub{font-size:13px;color:var(--text-dim);margin-top:3px}
.ll-stats{display:flex;gap:22px}.ll-stats span{display:grid;text-align:right}.ll-stats b{font-size:18px}.ll-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}
.ll-stats .pos,.ll-card .pos,.pos{color:#38d996}.ll-stats .neg,.ll-card .neg,.neg{color:#ff6577}
.ll-wrap{max-width:1440px;margin:0 auto}.ll-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}
.ll-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.ll-head h1{font-size:34px;margin:10px 0 7px}.ll-head p{max-width:860px;color:var(--text-dim)}
.ll-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.ll-engine i{width:8px;height:8px;border-radius:50%;background:#ff6577}.ll-engine.live i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}
.ll-modebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:18px 0 0;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}.ll-modebar>div{display:grid;gap:4px}.ll-modebar small{color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-tabs{display:flex;align-items:center;gap:5px}.ll-tabs a{display:grid;place-items:center;min-width:82px;height:31px;padding:0 11px;border:1px solid var(--border);border-radius:8px;color:var(--text-dim);font-size:10px;font-weight:750;text-decoration:none}.ll-tabs a:hover{border-color:#bd91ff;color:var(--text)}.ll-tabs a.active{border-color:rgba(163,106,255,.58);background:rgba(163,106,255,.16);color:#bd91ff}.ll-tabs a.real.active{border-color:rgba(56,217,150,.5);background:rgba(56,217,150,.12);color:#38d996}
.ll-readiness{display:flex;align-items:center;gap:7px 8px;min-height:34px;margin:7px 0 0;padding:6px 8px;border:1px solid rgba(56,217,150,.22);border-radius:9px;background:rgba(56,217,150,.035);font-size:9px;white-space:nowrap;overflow:hidden}.ll-readiness>span{display:flex;align-items:baseline;gap:3px}.ll-readiness small{color:var(--text-faint);font-size:8px;text-transform:uppercase;letter-spacing:.015em}.ll-readiness b{font-variant-numeric:tabular-nums}.ll-readiness>em{margin-left:auto;color:var(--text-faint);font-size:8px;font-style:normal}
.ll-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.ll-card,.ll-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.ll-card{padding:13px 14px;display:grid;gap:4px}.ll-card small,.ll-card em{color:var(--text-faint);font-size:10px;font-style:normal}.ll-card b{font-size:20px;font-variant-numeric:tabular-nums}
.ll-panel{padding:15px;margin:10px 0}.ll-panel h2{font-size:16px;margin:0 0 11px}
.ll-filter{display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:10px 0;padding:11px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}.ll-filter label{display:grid;gap:5px;color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-filter select{min-width:285px;height:34px;padding:0 32px 0 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:11px}.ll-filter button{height:34px;padding:0 13px;border:1px solid rgba(163,106,255,.5);border-radius:8px;background:rgba(163,106,255,.14);color:#bd91ff;font:inherit;font-size:10px;font-weight:700;cursor:pointer}.ll-filter small{color:var(--text-faint);font-size:10px}
.ll-signal-list{border:1px solid var(--border);border-radius:10px;overflow:hidden}.ll-signal-row{display:grid;grid-template-columns:minmax(120px,1.1fr) 92px 118px 120px 120px;align-items:center;gap:10px;min-height:38px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:11px}.ll-signal-row:last-child{border-bottom:0}.ll-signal-row:hover{background:rgba(255,255,255,.018)}.ll-signal-labels{min-height:30px;color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.ll-signal-strategy b{font-size:11px}.ll-signal-time{color:var(--text-faint);font-variant-numeric:tabular-nums}.ll-signal-event{font-weight:760}.ll-signal-value{font-variant-numeric:tabular-nums}
.ll-live{display:inline-block;margin-left:5px;padding:2px 5px;border-radius:999px;background:rgba(56,217,150,.12);color:#38d996;font-size:9px;letter-spacing:.04em}
.ll-table{width:100%;overflow:hidden}.ll-table table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}.ll-table th,.ll-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);white-space:normal;overflow-wrap:anywhere;vertical-align:middle}.ll-table th{color:var(--text-faint);font-size:9px;text-transform:uppercase;letter-spacing:.025em}.ll-table small{color:var(--text-faint);font-size:9px}.ll-table .num{font-variant-numeric:tabular-nums}
.ll-strategy-table{font-size:10px!important}.ll-strategy-table th,.ll-strategy-table td{padding:9px 6px!important;white-space:nowrap!important;overflow-wrap:normal!important;overflow:hidden;text-overflow:clip}.ll-strategy-table small{display:inline;font-size:8px}.ll-strategy-table th:nth-child(1){width:24%}.ll-strategy-table th:nth-child(2){width:7%}.ll-strategy-table th:nth-child(3){width:20%}.ll-strategy-table th:nth-child(4){width:14%}.ll-strategy-table th:nth-child(5){width:11%}.ll-strategy-table th:nth-child(6){width:12%}.ll-strategy-table th:nth-child(7){width:12%}
.ll-strategy-panel .ll-table{overflow:visible}.ll-strategy-panel .ll-strategy-table td:first-child{overflow:hidden}.ll-strategy-name{position:relative;display:inline-flex;align-items:center;max-width:100%;cursor:help}.ll-strategy-name>i{display:inline-grid;place-items:center;flex:0 0 auto;width:14px;height:14px;margin-left:5px;border:1px solid rgba(163,106,255,.48);border-radius:50%;color:#bd91ff;font-size:8px;font-style:normal}.ll-strategy-name::after{content:attr(data-tooltip);position:fixed;z-index:40;top:18%;left:50%;width:min(520px,90vw);padding:10px 11px;border:1px solid rgba(163,106,255,.45);border-radius:9px;background:#171a22;color:var(--text);font-size:10px;font-weight:500;line-height:1.5;white-space:normal;box-shadow:0 12px 32px rgba(0,0,0,.42);opacity:0;visibility:hidden;pointer-events:none;transform:translate(-50%,-3px);transition:opacity .12s ease,transform .12s ease}.ll-strategy-name:hover,.ll-strategy-name:focus{z-index:41;outline:none}.ll-strategy-name:hover::after,.ll-strategy-name:focus::after{opacity:1;visibility:visible;transform:translate(-50%,0)}
.ll-signal-table{font-size:9px!important}.ll-signal-table th,.ll-signal-table td{padding:7px 6px!important;white-space:nowrap!important;overflow-wrap:normal!important;overflow:hidden;text-overflow:clip}.ll-signal-table small{display:inline;font-size:8px}.ll-signal-table th:nth-child(1){width:14%}.ll-signal-table th:nth-child(2){width:6%}.ll-signal-table th:nth-child(3){width:15%}.ll-signal-table th:nth-child(4){width:11%}.ll-signal-table th:nth-child(5){width:20%}.ll-signal-table th:nth-child(6){width:18%}.ll-signal-table th:nth-child(7){width:16%}.ll-signal-table td:nth-child(7){white-space:normal!important;line-height:1.35}.ll-signal-table td:nth-child(2){font-weight:750;font-variant-numeric:tabular-nums}.ll-signal-table .ll-trade-ref{display:inline;white-space:nowrap;font-variant-numeric:tabular-nums}.ll-signal-status{display:inline-block;padding:2px 6px;border-radius:999px;font-size:9px;font-weight:800;letter-spacing:.025em;white-space:nowrap}.ll-signal-status.work{background:rgba(56,217,150,.12);color:#38d996}.ll-signal-status.done{background:rgba(92,163,255,.12);color:#76adff}.ll-signal-status.skip{background:rgba(255,190,92,.12);color:#ffc56e}.ll-signal-status.shadow{background:rgba(163,106,255,.13);color:#bd91ff}.ll-signal-status.error{background:rgba(255,101,119,.12);color:#ff6577}.ll-signal-status.wait{background:rgba(255,255,255,.06);color:var(--text-dim)}
.ll-trades th:nth-child(1){width:14%}.ll-trades th:nth-child(2){width:21%}.ll-trades th:nth-child(3){width:9%}.ll-trades th:nth-child(4){width:12%}.ll-trades th:nth-child(5){width:13%}.ll-trades th:nth-child(6){width:11%}.ll-trades th:nth-child(7){width:8%}.ll-trades th:nth-child(8){width:12%}
.ll-shadow-trades,.ll-live-trades{font-size:10px!important}.ll-shadow-trades th,.ll-shadow-trades td,.ll-live-trades th,.ll-live-trades td{padding:9px 6px!important;white-space:nowrap!important;overflow-wrap:normal!important;overflow:hidden;text-overflow:clip}.ll-shadow-trades small,.ll-live-trades small{display:inline;font-size:8px}.ll-shadow-trades th:nth-child(1),.ll-live-trades th:nth-child(1){width:16%}.ll-shadow-trades th:nth-child(2),.ll-live-trades th:nth-child(2){width:21%}.ll-shadow-trades th:nth-child(3),.ll-live-trades th:nth-child(3){width:9%}.ll-shadow-trades th:nth-child(4),.ll-live-trades th:nth-child(4){width:11%}.ll-shadow-trades th:nth-child(5),.ll-live-trades th:nth-child(5){width:12%}.ll-shadow-trades th:nth-child(6),.ll-live-trades th:nth-child(6){width:10%}.ll-shadow-trades th:nth-child(7),.ll-live-trades th:nth-child(7){width:7%}.ll-shadow-trades th:nth-child(8),.ll-live-trades th:nth-child(8){width:14%}
.ll-tech th:nth-child(1){width:20%}.ll-tech th:nth-child(2){width:18%}.ll-tech th:nth-child(3){width:15%}.ll-tech th:nth-child(4){width:18%}.ll-tech th:nth-child(5){width:29%}
.ll-note{font-size:11px;color:var(--text-faint);line-height:1.45}.ll-empty{padding:18px;text-align:center;color:var(--text-faint)}.collect{color:#bd91ff}.pass{color:#38d996}.fail{color:#ff6577}
.ll-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:11px}.ll-pager>small{color:var(--text-faint);font-size:10px}.ll-pager nav{display:flex;align-items:center;gap:5px}.ll-pager a,.ll-pager nav>span{display:grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border:1px solid var(--border);border-radius:7px;color:var(--text-dim);font-size:10px;text-decoration:none}.ll-pager a:hover{border-color:#bd91ff;color:var(--text)}.ll-pager .active{border-color:rgba(163,106,255,.55);background:rgba(163,106,255,.16);color:#bd91ff;font-weight:700}.ll-pager .disabled{opacity:.35}
.ll-details{padding:0}.ll-details>summary{cursor:pointer;list-style:none;padding:14px 15px;font-size:15px;font-weight:700}.ll-details>summary::-webkit-details-marker{display:none}.ll-details>summary::after{content:'＋';float:right;color:var(--text-faint)}.ll-details[open]>summary::after{content:'−'}.ll-details[open]>.ll-table{padding:0 15px 14px}
.ll-native-guide{border-color:rgba(56,217,150,.28)}.ll-guide-body{padding:0 15px 15px}.ll-guide-body>.ll-note{margin:0 0 10px}.ll-guide-flow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 20px;margin:0;padding:0;list-style:none;counter-reset:guide}.ll-guide-flow li{position:relative;min-height:45px;padding:8px 9px 8px 35px;border-top:1px solid var(--border);color:var(--text-dim);font-size:10px;line-height:1.45;counter-increment:guide}.ll-guide-flow li::before{content:counter(guide);position:absolute;top:8px;left:7px;display:grid;place-items:center;width:19px;height:19px;border-radius:50%;background:rgba(56,217,150,.12);color:#38d996;font-size:9px;font-weight:800}.ll-guide-flow b{color:var(--text)}.ll-native-specs{margin-top:11px;border:1px solid var(--border);border-radius:10px;overflow:hidden}.ll-native-spec{display:grid;grid-template-columns:120px 130px minmax(220px,1.15fr) minmax(260px,1.6fr) 145px;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:9px;line-height:1.4}.ll-native-spec:last-child{border-bottom:0}.ll-native-spec>b{font-size:10px;white-space:nowrap}.ll-native-spec>span{color:var(--text-dim)}.ll-native-spec>span:nth-child(2){color:#bd91ff;font-weight:750;white-space:nowrap}.ll-native-spec>em{font-size:8px;font-style:normal;font-weight:800;text-align:right;white-space:nowrap}
.ll-chart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.ll-chart-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px}.ll-chart-legend span{display:flex;align-items:center;gap:6px;color:var(--text-dim)}.ll-chart-legend i{width:18px;height:3px;border-radius:2px}.ll-chart-legend .shadow i{background:#a36aff}.ll-chart-legend .real i{background:#38d996}.ll-chart-legend b{font-variant-numeric:tabular-nums}.ll-chart{width:100%;margin-top:8px;overflow:hidden}.ll-chart svg{display:block;width:100%;height:auto;min-height:190px}.ll-chart-grid{stroke:rgba(255,255,255,.075);stroke-width:1}.ll-chart-zero{stroke:rgba(255,255,255,.24);stroke-width:1}.ll-chart-axis{fill:var(--text-faint);font-size:10px;font-family:inherit}.ll-chart-shadow{fill:none;stroke:#a36aff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.ll-chart-real{fill:none;stroke:#38d996;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.ll-chart-dot-shadow{fill:#a36aff}.ll-chart-dot-real{fill:#38d996}.ll-chart-empty{display:grid;place-items:center;min-height:170px;color:var(--text-faint);font-size:12px}
.ll-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin:12px 0}.ll-live-metric{padding:10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.015);display:grid;gap:3px}.ll-live-metric small{font-size:9px;color:var(--text-faint);text-transform:uppercase}.ll-live-metric b{font-size:15px;font-variant-numeric:tabular-nums}.ll-live-metric em{font-size:9px;color:var(--text-faint);font-style:normal}.ll-live-strategy th:nth-child(1){width:25%}.ll-live-strategy th:nth-child(2){width:11%}.ll-live-strategy th:nth-child(3){width:10%}.ll-live-strategy th:nth-child(4){width:12%}.ll-live-strategy th:nth-child(5){width:12%}.ll-live-strategy th:nth-child(6){width:18%}.ll-live-strategy th:nth-child(7){width:12%}
@media(max-width:760px){.ll-stats{width:100%;justify-content:space-between;gap:8px}.ll-grid{grid-template-columns:repeat(2,1fr)}.ll-live-grid{grid-template-columns:repeat(2,1fr)}.ll-head{display:block}.ll-engine{margin-top:10px;width:max-content}.ll-modebar{align-items:stretch}.ll-modebar>div{width:100%}.ll-tabs a{flex:1}.ll-readiness{overflow-x:auto}.ll-readiness>em{margin-left:0}.ll-filter{align-items:stretch}.ll-filter label,.ll-filter select{width:100%;min-width:0}.ll-signal-labels{display:none}.ll-signal-row{grid-template-columns:1fr auto;gap:3px 10px;padding:8px 10px}.ll-signal-row>span:nth-child(n+3){font-size:10px}.ll-table table{font-size:10px}.ll-table th,.ll-table td{padding:6px 4px}.ll-strategy-table th:nth-child(3),.ll-strategy-table td:nth-child(3),.ll-strategy-table th:nth-child(6),.ll-strategy-table td:nth-child(6){display:none}.ll-signal-table th:nth-child(3),.ll-signal-table td:nth-child(3){display:none}.ll-signal-table th:nth-child(1){width:17%}.ll-signal-table th:nth-child(2){width:9%}.ll-signal-table th:nth-child(4){width:17%}.ll-signal-table th:nth-child(5){width:17%}.ll-signal-table th:nth-child(6){width:16%}.ll-signal-table th:nth-child(7){width:24%}.ll-trades th:nth-child(3),.ll-trades td:nth-child(3){display:none}.ll-shadow-trades th:nth-child(1){width:16%}.ll-shadow-trades th:nth-child(2){width:19%}.ll-shadow-trades th:nth-child(4){width:12%}.ll-shadow-trades th:nth-child(5){width:14%}.ll-shadow-trades th:nth-child(6){width:11%}.ll-shadow-trades th:nth-child(7){width:8%}.ll-shadow-trades th:nth-child(8){width:20%}.ll-live-strategy th:nth-child(5),.ll-live-strategy td:nth-child(5),.ll-live-strategy th:nth-child(6),.ll-live-strategy td:nth-child(6){display:none}.ll-guide-flow{grid-template-columns:1fr}.ll-native-spec{grid-template-columns:1fr;gap:3px}.ll-native-spec>em{text-align:left}.ll-strategy-name::after{left:50%;width:90vw}}`;

export async function lighterLuxalgoHero(lang: Lang): Promise<string> {
  const s = summary(LUXALGO_STRATEGIES);
  const individual = LUXALGO_STRATEGIES.map((spec) => ({
    spec,
    gate: gate(summary(spec), lang),
  }));
  const passed = individual.filter((row) => row.gate.passed).length;
  const assets = [...new Set(LUXALGO_STRATEGIES.map((spec) => spec.asset))].join(' · ');
  return `<a class="ll-hero" href="/lab/lighter-luxalgo">
    <div><span class="ll-badge">🟣 LUXALGO → LIGHTER · ZERO FEE · SHADOW</span>
      <div class="ll-title">${assets} — единый портфель сигналов</div>
      <div class="ll-sub">${t(lang, 'Одна карточка и одна таблица · $1000 на позицию · индивидуальная и общая статистика →', 'One card and one table · $1,000 per position · individual and aggregate statistics →')}</div>
    </div>
    <div class="ll-stats">
      <span><b class="${s.feedLive ? 'pos' : 'neg'}">${s.feedLive ? `${LUXALGO_STRATEGIES.length}/${LUXALGO_STRATEGIES.length} LIVE` : 'DEGRADED'}</b><small>Lighter L2</small></span>
      <span><b>${s.signals}</b><small>${t(lang, 'сигналов', 'signals')}</small></span>
      <span><b>${passed}/${LUXALGO_STRATEGIES.length}</b><small>${t(lang, 'прошли гейт', 'gates passed')}</small></span>
      <span><b class="${pnlClass(s.netPct)}">${signedPct(s.netPct)}</b><small>net · ${signedUsd(s.netUsd)}</small></span>
    </div>
  </a>`;
}

export async function lighterNativeQuantHero(lang: Lang): Promise<string> {
  const shadow = summary(NATIVE_STRATEGIES);
  const display = nativeDisplayStats(lang);
  const realRows = recentLiveTrades(1_000, NATIVE_STRATEGY_IDS);
  const realClosed = realRows.filter(
    (row) => row.status === 'closed' && row.net_pnl_usd != null,
  );
  const realOpen = realRows.filter(
    (row) => row.status === 'opening' || row.status === 'open' || row.status === 'closing',
  ).length;
  const realNetUsd = realClosed.reduce(
    (sum, row) => sum + (row.net_pnl_usd ?? 0),
    0,
  );
  return `<a class="ll-hero ll-native-hero" href="/lab/lighter-luxalgo?group=native&dataset=shadow#portfolio-view">
    <div><span class="ll-badge">NATIVE QUANT → LIGHTER · ${display.models} MODELS</span>
      <div class="ll-title">${t(lang, 'Собственные стратегии · единый портфель', 'In-house strategies · unified portfolio')}</div>
      <div class="ll-sub">${t(
        lang,
        '6 самостоятельных моделей + P2 на 15 рынках · единая статистика Shadow/Real →',
        '6 standalone models + P2 across 15 markets · consolidated Shadow/Real statistics →',
      )}</div>
    </div>
    <div class="ll-stats">
      <span><b>${display.models}</b><small>${t(lang, 'моделей', 'models')} · ${display.backtestTrades} BT trades</small></span>
      <span><b class="${pnlClass(shadow.netPct)}">${signedPct(shadow.netPct)}</b><small>shadow · ${shadow.closed}/${shadow.open}</small></span>
      <span><b class="${pnlClass(realNetUsd)}">${signedUsd(realNetUsd)}</b><small>real · ${realClosed.length}/${realOpen}</small></span>
      <span><b class="${display.passed ? 'pos' : 'collect'}">${display.passed}/${display.models}</b><small>${t(lang, 'прошли forward-гейт', 'forward gates passed')}</small></span>
    </div>
  </a>`;
}

function nativeEntryDescription(info: NativeStrategyInfo, lang: Lang): string {
  if (info.mode === 'reclaim') {
    return t(
      lang,
      `Long: предыдущий Z < −${info.threshold}, текущий Z ≥ −${info.threshold}. Short: предыдущий Z > +${info.threshold}, текущий Z ≤ +${info.threshold}.`,
      `Long: previous Z < −${info.threshold}, current Z ≥ −${info.threshold}. Short: previous Z > +${info.threshold}, current Z ≤ +${info.threshold}.`,
    );
  }
  const touch = t(
    lang,
    `Long: текущий Z < −${info.threshold}. Short: текущий Z > +${info.threshold}.`,
    `Long: current Z < −${info.threshold}. Short: current Z > +${info.threshold}.`,
  );
  if (!info.trendFilter) return touch;
  return `${touch} ${t(
    lang,
    'P2: Long только при close > EMA200 > EMA400; Short — зеркально ниже обеих EMA.',
    'P2: Long only when close > EMA200 > EMA400; Short is the mirrored condition below both EMAs.',
  )}`;
}

function nativeStrategyTooltip(spec: StrategySpec, lang: Lang): string | null {
  const info = NATIVE_STRATEGY_INFO[spec.id];
  if (!info) return null;
  const distribution = info.family === 'vwz'
    ? t(
      lang,
      `Volume Z-score считается по ${info.period} завершённым 5m свечам Lighter с весом их торгового объёма.`,
      `Volume Z-score is calculated from ${info.period} completed Lighter 5m candles weighted by their traded volume.`,
    )
    : t(
      lang,
      `Z-score считается по ${info.period} завершённым 5m закрытиям Lighter.`,
      `Z-score is calculated from ${info.period} completed Lighter 5m closes.`,
    );
  const exitMean = info.family === 'vwz' ? `VWMA${info.period}` : `SMA${info.period}`;
  return [
    `${spec.name}.`,
    distribution,
    nativeEntryDescription(info, lang),
    t(
      lang,
      `Выход у ${exitMean} или через ${info.timeExitBars} баров (20 ч); stop ${spec.stopPct.toFixed(1)}%.`,
      `Exit at ${exitMean} or after ${info.timeExitBars} bars (20h); ${spec.stopPct.toFixed(1)}% stop.`,
    ),
    t(lang, info.noteRu, info.noteEn),
  ].join(' ');
}

function nativeStrategyGuide(
  lang: Lang,
  specs: readonly StrategySpec[],
): string {
  const nativeSpecs = specs.filter((spec) => NATIVE_STRATEGY_INFO[spec.id]);
  if (!nativeSpecs.length) return '';

  const strategyLines = nativeSpecs.filter((spec) => !spec.portfolioId).map((spec) => {
    const info = NATIVE_STRATEGY_INFO[spec.id]!;
    const family = info.family === 'vwz' ? 'VOLUME Z' : 'Z';
    return `<div class="ll-native-spec">
      <b>STRAT-${spec.code} · ${spec.asset}</b>
      <span>${info.mode === 'reclaim' ? 'RECLAIM' : 'TOUCH'} · ${family}${info.period} · ±${info.threshold}σ</span>
      <span>${esc(nativeEntryDescription(info, lang))}</span>
      <span>${t(lang, info.noteRu, info.noteEn)}</span>
      <em class="${info.realEnabled ? 'pass' : 'collect'}">${info.realEnabled ? 'SHADOW + REAL $100 / 10×' : 'SHADOW ONLY'}</em>
    </div>`;
  }).join('') + (nativeSpecs.some((spec) => spec.portfolioId === NATIVE_TREND_PORTFOLIO_ID)
    ? `<div class="ll-native-spec">
      <b>PORTFOLIO P2 · 15 markets</b>
      <span>TOUCH · Z60 · ±2.5σ · EMA200/400</span>
      <span>${t(lang, 'Long: close > EMA200 > EMA400; Short: close < EMA200 < EMA400. Одно правило на всех рынках.', 'Long: close > EMA200 > EMA400; Short: close < EMA200 < EMA400. One rule across every market.')}</span>
      <span>${t(lang, 'Выход у SMA60, stop 1.5% или через 20 часов; максимум 10 одновременных Shadow-позиций. Общий forward-гейт; Real отключён.', 'Exit at SMA60, 1.5% stop, or after 20 hours; at most 10 concurrent Shadow positions. Combined forward gate; Real disabled.')}</span>
      <em class="collect">SHADOW ONLY</em>
    </div>`
    : '');

  return `<details class="ll-panel ll-details ll-native-guide" open>
    <summary>${t(lang, 'Как работают и отправляются сигналы Native Quant', 'How Native Quant signals are formed and delivered')}</summary>
    <div class="ll-guide-body">
      <p class="ll-note"><b>${t(lang, 'Важно:', 'Important:')}</b> ${t(
        lang,
        'это собственный движок. Он не зависит от LuxAlgo alerts, внешнего webhook и галочки Webhooks.',
        'this is an in-house engine. It does not depend on LuxAlgo alerts, an external webhook, or the Webhooks checkbox.',
      )}</p>
      <ol class="ll-guide-flow">
        <li><b>${t(lang, 'Завершённая свеча.', 'Completed candle.')}</b> ${t(
          lang,
          'Каждые 15 секунд runner проверяет новую закрытую 5m свечу с 25-секундным запасом на публикацию. Базовые модели собирают 5m только из всех пяти 1m свечей; P2 постранично получает 1500 нативных 5m свечей и отклоняет историю с любым разрывом.',
          'Every 15 seconds the runner checks for a newly completed 5m candle with a 25-second publication grace. Base models build 5m only from all five 1m candles; P2 paginates 1,500 native 5m candles and rejects any history containing a gap.',
        )}</li>
        <li><b>${t(lang, 'Расчёт.', 'Calculation.')}</b> ${t(
          lang,
          'Для STRAT-030–033 по последним 60 закрытиям считаются SMA60 и Z. STRAT-034–035 взвешивают их объёмом. Portfolio P2 дополнительно считает EMA200 и EMA400 по завершённым 5m свечам. Незавершённая свеча в расчёт не попадает.',
          'STRAT-030–033 calculate SMA60 and Z from the latest 60 closes. STRAT-034–035 volume-weight them. Portfolio P2 also calculates EMA200 and EMA400 from completed 5m candles. The unfinished candle is never included.',
        )}</li>
        <li><b>${t(lang, 'Решение.', 'Decision.')}</b> ${t(
          lang,
          'Touch входит сразу за порогом ±σ; Reclaim ждёт возврата Z обратно внутрь порога. Позиция закрывается у своей средней: SMA60 для STRAT-030–033 или VWMA60 для STRAT-034–035; резервный выход — 240 баров, то есть 20 часов.',
          'Touch enters immediately beyond its ±σ threshold; Reclaim waits for Z to return inside the threshold. A position exits at its own mean: SMA60 for STRAT-030–033 or VWMA60 for STRAT-034–035; the fallback exit is 240 bars, or 20 hours.',
        )}</li>
        <li><b>${t(lang, 'Внутренний сигнал.', 'Internal signal.')}</b> ${t(
          lang,
          'Runner передаёт в общую очередь strategy_id, entry/exit, side, symbol, timeframe=5, цену закрытия и bar_time. SHA-256 ключ из стратегии, события и времени бара не позволяет обработать дубль повторно.',
          'The runner sends strategy_id, entry/exit, side, symbol, timeframe=5, close price, and bar_time to the shared queue. A SHA-256 key built from strategy, event, and bar time prevents duplicate processing.',
        )}</li>
        <li><b>${t(lang, 'Shadow-исполнение.', 'Shadow execution.')}</b> ${t(
          lang,
          'Сразу снимается свежий WebSocket L2 Lighter. Допускается до 5 секунд коротких повторов по 100 мс, но фиксированной задержки нет. Стакан должен исполнить $1000; вход и выход записываются по реальному VWAP нужной стороны, поэтому spread и slippage уже внутри PnL, funding добавляется отдельно.',
          'A fresh Lighter WebSocket L2 snapshot is taken immediately. Up to five seconds of 100ms retries are allowed, with no fixed delay. The book must fill $1,000; entry and exit use executable side-specific VWAP, so spread and slippage are already embedded in PnL, while funding is added separately.',
        )}</li>
        <li><b>${t(lang, 'Real-canary и защита.', 'Real canary and protection.')}</b> ${t(
          lang,
          'Тот же сигнал видит отдельный Real-исполнитель. STRAT-030/032/033 технически поддерживаются, но каждая новая стратегия по умолчанию выключена и может открыть $100 с плечом 10× только после ручного допуска по frozen prospective-гейту. После подтверждения позиции сразу ставится биржевой reduce-only stop 1.5%; пауза не мешает сопровождению и выходу уже открытой позиции. STRAT-031/034/035 и портфель P2 остаются только в Shadow.',
          'A separate Real executor observes the same signal. STRAT-030/032/033 are technically supported, but every new strategy defaults to disabled and may open $100 at 10× only after manual promotion through the frozen prospective gate. Once a position is confirmed, an exchange-native 1.5% reduce-only stop is placed immediately; pausing entries does not disable monitoring or exits for an existing position. STRAT-031/034/035 and portfolio P2 remain Shadow-only.',
        )}</li>
      </ol>
      <div class="ll-native-specs">${strategyLines}</div>
    </div>
  </details>`;
}

function strategyRows(
  lang: Lang,
  specs: readonly StrategySpec[] = STRATEGIES,
): string {
  const regularRows = specs.filter((spec) => !spec.portfolioId).map((spec) => {
    const s = summary(spec);
    const g = gate(s, lang, NATIVE_STRATEGY_ID_SET.has(spec.id));
    const wr = s.closed ? s.wins / s.closed * 100 : null;
    const feed = executionSnapshot(spec);
    const tooltip = nativeStrategyTooltip(spec, lang);
    const gateTitle = nativeGateTitle(s.forwardGate, lang);
    const strategyLabel = tooltip
      ? `<span class="ll-strategy-name" tabindex="0" title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}"><b>STRAT-${spec.code} · ${spec.asset}</b><small> · ${esc(spec.name)}</small><i>?</i></span>`
      : `<b>STRAT-${spec.code} · ${spec.asset}</b><small> · ${esc(spec.name)}</small>`;
    return `<tr>
      <td>${strategyLabel}</td>
      <td class="${'error' in feed ? 'neg' : 'pos'}">${'error' in feed ? 'OFF' : 'LIVE'}</td>
      <td class="num"><b>${spec.backtest.trades} · ${spec.backtest.winRatePct.toFixed(1)}% · ${spec.backtest.profitFactor.toFixed(2)}</b><small> · ${signedPct(spec.backtest.netPct)} · SL ${spec.stopPct.toFixed(1)}%</small></td>
      <td class="num"><b>${s.closed} / ${s.open}</b><small> · WR ${wr == null ? '—' : `${wr.toFixed(0)}%`} · PF ${pfLabel(s.profitFactor)}</small></td>
      <td class="${pnlClass(s.netPct)}"><b>${signedPct(s.netPct)} · ${signedUsd(s.netUsd)}</b></td>
      <td class="num">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}<small> · ½ ${signedPct(s.firstHalfPct)} · ½ ${signedPct(s.secondHalfPct)}</small></td>
      <td class="${g.cls}"${gateTitle ? ` title="${esc(gateTitle)}"` : ''}><b>${esc(g.label)}</b></td>
    </tr>`;
  }).join('');
  const portfolioSpecs = specs.filter(
    (spec) => spec.portfolioId === NATIVE_TREND_PORTFOLIO_ID,
  );
  if (!portfolioSpecs.length) return regularRows;
  const s = summary(portfolioSpecs);
  const g = gate(s, lang, true);
  const wr = s.closed ? s.wins / s.closed * 100 : null;
  const gateTitle = nativeGateTitle(s.forwardGate, lang);
  const backtest = portfolioSpecs[0]!.backtest;
  const assets = portfolioSpecs.map((spec) => spec.asset).join(' · ');
  const tooltip = t(
    lang,
    `Одно фиксированное двухстороннее правило на 15 рынках без настройки по монете. Long: Z60 < −2.5 и close > EMA200 > EMA400; Short — зеркально. Выход у SMA60, stop 1.5% или через 20 часов. Издержки отбора и prospective Shadow используют один целевой размер $100: измеренный p95 полного круга; неблокирующий adverse-сценарий использует худший фактически наблюдавшийся полный круг. Повторяемый 180d-прогон: 758 сделок, PF 1.45, net +122.80%, observed-max +115.86% / PF 1.42, DD 2.45%, 4/4 периода, обе стороны и оба режима волатильности положительны. Отдельный перенос того же правила на шесть внешних рынков провалился: 5m net −16.25%, PF 0.89, OOS −4.24%. Новые рынки не добавлены; исходный P2 остаётся только prospective Shadow и не может получить Real по историческому бэктесту. 1m отвергнут.`,
    `One fixed two-sided rule across 15 markets with no per-market tuning. Long: Z60 < −2.5 and close > EMA200 > EMA400; Short is the mirrored condition. Exit at SMA60, 1.5% stop, or after 20 hours. Selection costs and prospective Shadow use the same $100 target size: measured full-round-trip p95; the non-blocking adverse scenario uses the worst actually observed round trip. Reproducible 180d run: 758 trades, PF 1.45, net +122.80%, observed-max +115.86% / PF 1.42, 2.45% DD, 4/4 folds, both sides and both volatility regimes positive. A separate unchanged transfer to six external markets failed: 5m net −16.25%, PF 0.89, OOS −4.24%. No new market was added; the original P2 remains prospective Shadow-only and cannot reach Real from historical backtest evidence. The 1m transfer was rejected.`,
  );
  return `${regularRows}<tr>
    <td><span class="ll-strategy-name" tabindex="0" title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}"><b>PORTFOLIO P2 · 15 markets</b><small> · Z60 Stack 2.5σ Touch</small><i>?</i></span><small>${assets}</small></td>
    <td class="${s.feedLive ? 'pos' : 'neg'}">${s.feedLive ? 'LIVE' : 'OFF'}</td>
    <td class="num"><b>${backtest.trades} · ${backtest.winRatePct.toFixed(1)}% · ${backtest.profitFactor.toFixed(2)}</b><small> · ${signedPct(backtest.netPct)} · DD ${backtest.maxDrawdownPct.toFixed(2)}%</small></td>
    <td class="num"><b>${s.closed} / ${s.open}</b><small> · WR ${wr == null ? '—' : `${wr.toFixed(0)}%`} · PF ${pfLabel(s.profitFactor)}</small></td>
    <td class="${pnlClass(s.netPct)}"><b>${signedPct(s.netPct)} · ${signedUsd(s.netUsd)}</b></td>
    <td class="num">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}<small> · ½ ${signedPct(s.firstHalfPct)} · ½ ${signedPct(s.secondHalfPct)}</small></td>
    <td class="${g.cls}"${gateTitle ? ` title="${esc(gateTitle)}"` : ''}><b>${esc(g.label)}</b></td>
  </tr>`;
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
  const snap = executionSnapshot(spec, row.notional_usd);
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
      const base = row.filled_notional_usd ?? row.requested_notional_usd;
      const snap = executionSnapshot(spec, base);
      if (!('error' in snap)) {
        const mark = row.side === 'long' ? snap.sellVwap : snap.buyVwap;
        liveNetUsd = (row.side === 'long' ? 1 : -1)
          * (mark - row.entry_price) * row.quantity;
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

function liveStrategyRows(
  rows: LiveStrategyStateRow[],
  lang: Lang,
  specs: readonly StrategySpec[] = STRATEGIES,
): string {
  const byId = new Map(rows.map((row) => [row.strategy_id, row]));
  return specs.map((spec) => {
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
  if (row.shadow_decision_reason) {
    return {
      label: t(lang, 'SHADOW ОСТАНОВЛЕН', 'SHADOW PAUSED'),
      css: 'skip',
      detail: row.shadow_decision_reason,
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
  strategyScope: StrategyIdScope = null,
): string {
  const series = cumulativePnlSeries(strategyScope);
  const points = dataset === 'shadow' ? series.shadow : series.live;
  const netUsd = points.at(-1)?.pnlUsd ?? 0;
  const netPct = points.at(-1)?.pnlPct ?? 0;
  const shadowNotional = isNativeIdScope(idsForScope(strategyScope))
    ? NATIVE_SHADOW_NOTIONAL_USD
    : LUXALGO_SHADOW_NOTIONAL_USD;
  const datasetLabel = dataset === 'shadow'
    ? `Shadow · $${shadowNotional.toLocaleString('en-US')}`
    : 'Real · $100';
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
    group: PortfolioGroup;
    dataset: PortfolioDataset;
    chartUnit: ChartUnit;
  },
): Promise<string> {
  const strategyId = requested.strategy?.id ?? null;
  const scopeSpecs = requested.strategy
    ? [requested.strategy]
    : requested.group === 'native'
      ? [...NATIVE_STRATEGIES]
      : [...LUXALGO_STRATEGIES];
  const scopeIds = scopeSpecs.map((spec) => spec.id);
  const shadowNotional = isNativeIdScope(scopeIds)
    ? NATIVE_SHADOW_NOTIONAL_USD
    : LUXALGO_SHADOW_NOTIONAL_USD;
  const realSupported = scopeIds.some((id) =>
    (NATIVE_LIVE_STRATEGY_IDS as readonly string[]).includes(id));
  const dataset: PortfolioDataset = realSupported ? requested.dataset : 'shadow';
  const s = summary(scopeSpecs);
  const signalsTotal = signalTotal(scopeIds);
  const tradesTotal = tradeTotal(scopeIds);
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
    scopeIds,
  );
  const trades = recentTrades(
    TRADE_PAGE_SIZE,
    (tradesPage - 1) * TRADE_PAGE_SIZE,
    scopeIds,
  );
  const liveState = lighterLiveState();
  const liveTrades = recentLiveTrades(30, scopeIds);
  const allLiveClosed = recentLiveTrades(10_000, scopeIds)
    .filter((row) => row.status === 'closed' && row.net_pnl_usd != null)
    .reverse();
  const liveCounts = liveTradeCounts(scopeIds);
  const liveDecisions = liveDecisionCounts(scopeIds);
  const liveSummary = liveMetrics(allLiveClosed);
  const execution = liveExecutionComparison(scopeIds);
  const latencyMetrics = liveLatencyMetrics(liveTrades);
  const liveStrategies = liveStrategyStates().filter(
    (row) => scopeIds.includes(row.strategy_id),
  );
  const requestedLiveStrategyState = requested.strategy
    ? liveStrategies.find((row) => row.strategy_id === requested.strategy?.id) ?? null
    : null;
  const enabledLiveStrategies = liveStrategies.filter((row) => row.enabled === 1).length;
  const livePortfolioPaused = liveState?.portfolio_paused_at != null;
  const liveMonitor = liveState?.status === 'armed'
    && liveState.heartbeat_at != null
    && Date.now() - liveState.heartbeat_at < 15_000;
  const liveEntryEnabled = liveState?.enabled === 1 && enabledLiveStrategies > 0;
  const liveRunnerLabel = !liveMonitor
    ? 'OFFLINE'
    : !realSupported
      ? 'SHADOW ONLY'
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
  const nativeDisplay = requested.group === 'native' && !requested.strategy
    ? nativeDisplayStats(lang)
    : null;
  const displayModelCount = nativeDisplay?.models ?? scopeSpecs.length;
  const passed = nativeDisplay?.passed ?? scopeSpecs.filter(
    (spec) => gate(summary(spec), lang, NATIVE_STRATEGY_ID_SET.has(spec.id)).passed,
  ).length;
  const liveEnabledStrategies = liveStrategies.filter((row) => row.enabled === 1).length;
  const livePassedStrategies = liveStrategies.filter(
    (row) => row.gate_status === 'passed',
  ).length;
  const datasetHref = (dataset: PortfolioDataset): string => labHref({
    signalsPage,
    tradesPage,
    strategyId,
    group: requested.group,
    dataset,
    chartUnit: requested.chartUnit,
    anchor: 'portfolio-view',
  });
  const chartHref = (chartUnit: ChartUnit): string => labHref({
    signalsPage,
    tradesPage,
    strategyId,
    group: requested.group,
    dataset,
    chartUnit,
    anchor: 'pnl-chart',
  });
  const scopeLabel = requested.strategy
    ? `STRAT-${requested.strategy.code} · ${requested.strategy.asset}`
    : requested.group === 'native'
      ? t(lang, '6 самостоятельных + P2 · 15 рынков', '6 standalone + P2 · 15 markets')
      : [...new Set(scopeSpecs.map((spec) => spec.asset))].join(' · ');
  const scopeMarketCount = new Set(scopeSpecs.map((spec) => spec.marketId)).size;
  const shadowAverageUsd = s.closed ? s.netUsd / s.closed : 0;
  const legacyDrainNote = s.legacyOpen > 0
    ? t(
      lang,
      ` · legacy $1,000 закрываются: ${s.legacyOpen}`,
      ` · legacy $1,000 draining: ${s.legacyOpen}`,
    )
    : '';
  const shadowCards = `
    <div class="ll-card"><small>${t(lang, 'Модели / гейт', 'Models / gates')}</small><b>${displayModelCount} / ${passed}</b><em>${scopeLabel}</em></div>
    <div class="ll-card"><small>${t(lang, 'Сигналы / ошибки', 'Signals / errors')}</small><b>${s.signals} / ${s.captureErrors}</b><em>${t(lang, 'все выбранные alerts', 'all selected alerts')}</em></div>
    <div class="ll-card"><small>${t(lang, 'Закрыто / открыто', 'Closed / open')}</small><b>${s.closed} / ${s.open}</b><em>$${shadowNotional.toLocaleString('en-US')} ${t(lang, 'на позицию', 'per position')}${legacyDrainNote}</em></div>
    <div class="ll-card"><small>Shadow net PnL</small><b class="${pnlClass(s.netUsd)}">${signedUsd(s.netUsd)}</b><em>${signedPct(s.netPct)} · $${shadowNotional.toLocaleString('en-US')} ${t(lang, 'на сделку', 'per trade')}</em></div>
    <div class="ll-card"><small>Shadow WR / PF</small><b>${s.closed ? `${wr.toFixed(0)}% / ${pfLabel(s.profitFactor)}` : '—'}</b><em>${t(lang, 'после всех издержек', 'after all costs')}</em></div>
    <div class="ll-card"><small>${t(lang, 'Средняя сделка', 'Average trade')}</small><b class="${pnlClass(s.avgNetPct)}">${signedPct(s.avgNetPct)}</b><em>${signedUsd(shadowAverageUsd)}</em></div>
    <div class="ll-card"><small>Shadow max drawdown</small><b class="${s.maxDrawdownPct > 0 ? 'neg' : ''}">${s.closed ? `−${s.maxDrawdownPct.toFixed(3)}%` : '—'}</b><em>${s.closed ? `−$${(s.maxDrawdownPct / 100 * shadowNotional).toFixed(2)}` : '—'}</em></div>
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
  const scopeControl = requested.strategy
    ? `<div class="ll-filter">
        <a class="ll-back" style="margin:0" href="${requested.group === 'native' ? '/lab/lighter-luxalgo?group=native&dataset=shadow#portfolio-view' : '/lab/lighter-luxalgo'}">${t(lang, '← Общий портфель', '← Full portfolio')}</a>
        <b>STRAT-${requested.strategy.code} · ${requested.strategy.asset} · ${esc(requested.strategy.name)}</b>
        <small>${t(lang, 'На странице нет данных других стратегий.', 'This page contains no data from other strategies.')}</small>
      </div>`
    : `<form class="ll-filter" action="/lab/lighter-luxalgo" method="get">
        ${requested.group ? `<input type="hidden" name="group" value="${requested.group}">` : ''}
        <input type="hidden" name="dataset" value="${requested.dataset}">
        <input type="hidden" name="chart" value="${requested.chartUnit}">
        <label>${t(lang, 'Фильтр сигналов и сделок', 'Signals and trades filter')}
          <select name="strategy" onchange="this.form.submit()">
            <option value="">${t(lang, 'Все стратегии', 'All strategies')}</option>
            ${scopeSpecs.filter((spec) => !spec.portfolioId).map((spec) => `<option value="${esc(spec.id)}">STRAT-${spec.code} · ${spec.asset} · ${esc(spec.name)}</option>`).join('')}
          </select>
        </label>
        <small>${t(lang, 'Показаны все стратегии портфеля', 'Showing all portfolio strategies')}</small>
        <button type="submit">${t(lang, 'Показать', 'Apply')}</button>
      </form>`;
  const pageHeading = requested.strategy
    ? `STRAT-${requested.strategy.code} · ${requested.strategy.name}`
    : requested.group === 'native'
      ? t(lang, 'Native Quant → Lighter · единый портфель', 'Native Quant → Lighter · unified portfolio')
      : 'LuxAlgo → Lighter · единый портфель';
  const pageBadge = requested.strategy
    ? `STRAT-${requested.strategy.code} · ${requested.strategy.asset} · 5M · NATIVE LIGHTER`
    : requested.group === 'native'
      ? `NATIVE LIGHTER · ${displayModelCount} MODELS · P2 SHADOW`
      : `STRAT-${scopeSpecs.map((spec) => spec.code).join(' · ')} · PROSPECTIVE FORWARD`;
  const pageDescription = requested.strategy
    ? (NATIVE_LIVE_STRATEGY_IDS as readonly string[]).includes(requested.strategy.id)
      && requestedLiveStrategyState?.enabled === 1
      ? t(
        lang,
        'Только эта стратегия: нативные свечи Lighter, Shadow $100 и изолированный Real-canary $100 с плечом 10×. Комиссия 0%; spread, slippage и funding учитываются.',
        'This strategy only: native Lighter candles, $100 Shadow and an isolated $100 Real canary at 10× leverage. Trading fee is 0%; spread, slippage, and funding are included.',
      )
      : (NATIVE_LIVE_STRATEGY_IDS as readonly string[]).includes(requested.strategy.id)
        ? t(
          lang,
          'Только эта стратегия: нативные свечи Lighter и prospective Shadow $100. Она зарегистрирована в Real-исполнителе, но новые входы $100/10× выключены до прохождения frozen forward-гейта; старые Shadow-позиции $1000 продолжают сопровождаться до закрытия.',
          'This strategy only: native Lighter candles and prospective $100 Shadow. It is registered with the Real executor, but new $100/10× entries are disabled until the frozen forward gate passes; legacy $1,000 Shadow positions remain monitored until closed.',
        )
        : t(
        lang,
        'Только эта стратегия: нативные свечи Lighter и prospective Shadow $100. Real отключён до отдельной проверки forward-сделок. Комиссия 0%; spread, slippage и funding учитываются.',
        'This strategy only: native Lighter candles and prospective $100 Shadow. Real is disabled until its own forward trades are validated. Trading fee is 0%; spread, slippage, and funding are included.',
        )
    : requested.group === 'native'
      ? t(
        lang,
        `Собственные стратегии на завершённых свечах Lighter собраны в одном портфеле: ${scopeLabel}. Единые сигналы, сделки, накопленный PnL и индивидуальная статистика; новая prospective Shadow-когорта моделируется на $100, как отбор и будущий Real-canary. Старые сделки $1000 сохранены отдельно и не участвуют в гейте. Комиссия Standard — 0%, spread, VWAP, slippage и funding учитываются.`,
        `In-house completed-candle Lighter strategies share one portfolio: ${scopeLabel}. Signals, trades, cumulative PnL, and per-strategy statistics are consolidated; the new prospective Shadow cohort uses $100, matching selection and the future Real canary. Legacy $1,000 trades are preserved separately and excluded from the gate. Standard trading fee is 0%, while spread, VWAP, slippage, and funding are included.`,
      )
      : t(
        lang,
        `Все подходящие alerts собраны в одной системе и одной таблице. ${scopeLabel} независимо снимают живой L2 Lighter без фиксированной задержки; каждая позиция моделируется на $1000. Комиссия Standard — 0%, spread, $1000 VWAP и funding учтены.`,
        `All selected alerts share one system and one table. ${scopeLabel} independently sample live Lighter L2 with no fixed delay; every position is modeled at $1,000. Standard trading fee is 0%, while spread, $1,000 VWAP, and funding are included.`,
      );
  const currentDrawdownUsd = requested.strategy
    ? liveSummary.currentDrawdownUsd
    : liveState?.current_drawdown_usd ?? 0;
  const liveScopeText = requested.strategy
    ? (NATIVE_LIVE_STRATEGY_IDS as readonly string[]).includes(requested.strategy.id)
      && requestedLiveStrategyState?.enabled === 1
      ? t(
        lang,
        'Real разрешён только для этой стратегии. Биржевой reduce-only stop 1.5% ставится сразу после входа. Новые входы блокируются при дневном убытке −$10, общей просадке −$15 или индивидуальной паузе.',
        'Real trading is enabled only for this strategy. An exchange-native 1.5% reduce-only stop is placed immediately after entry. New entries are blocked at a −$10 daily loss, −$15 portfolio drawdown, or an individual strategy pause.',
      )
      : (NATIVE_LIVE_STRATEGY_IDS as readonly string[]).includes(requested.strategy.id)
        ? t(
          lang,
          'Новые Real-входы этой стратегии выключены до 20 закрытых prospective-сделок и прохождения frozen-гейта. Уже открытая позиция остаётся под биржевым reduce-only stop и будет закрыта штатным сигналом или стопом.',
          'New Real entries for this strategy are disabled until 20 prospective closes pass the frozen gate. Any existing position remains protected by its exchange-native reduce-only stop and will close through the normal signal or stop path.',
        )
        : t(
        lang,
        'Эта стратегия работает только в Shadow. Реальный исполнитель её не поддерживает и не может открыть по ней позицию.',
        'This strategy is Shadow-only. The real executor does not support it and cannot open a position from its signals.',
        )
    : requested.group === 'native'
      ? t(
        lang,
        enabledLiveStrategies > 0
          ? `Новые Real-входы разрешены у ${enabledLiveStrategies} стратегий, прошедших отдельный допуск. Остальные Native-модели, включая P2, копят prospective Shadow. На каждую открытую Real-позицию сразу ставится биржевой reduce-only stop.`
          : 'Все новые Real-входы Native Quant сейчас на паузе до 20 закрытых prospective-сделок и прохождения frozen-гейтов. Уже открытая позиция остаётся под биржевым reduce-only stop и штатным сопровождением; P2 и остальные модели продолжают Shadow.',
        enabledLiveStrategies > 0
          ? `New Real entries are enabled for ${enabledLiveStrategies} separately promoted strategies. All other Native models, including P2, continue collecting prospective Shadow evidence. Every open Real position receives an exchange-native reduce-only stop immediately.`
          : 'All new Native Quant Real entries are currently paused until 20 prospective closes pass the frozen gates. Any existing position remains protected by its exchange-native reduce-only stop and normal monitoring; P2 and the other models continue in Shadow.',
      )
      : t(
        lang,
        'Разные стратегии могут торговаться одновременно. Биржевой reduce-only stop ставится сразу на каждую позицию. При ручной паузе новые входы запрещены, но существующие позиции продолжают контролироваться и закрываться. Новые входы также блокируются при дневном убытке −$10, совокупной просадке −$15 или индивидуальной паузе стратегии.',
        'Different strategies may trade concurrently. An exchange-native reduce-only stop is placed immediately on every position. During a manual pause, new entries are blocked while existing positions remain monitored and can close. New entries are also blocked at a −$10 daily loss, −$15 cumulative drawdown, or an individual strategy pause.',
      );
  const liveStrategyDetails = requested.strategy
    ? ''
    : `<details class="ll-details"><summary>${t(lang, 'Live-статистика по каждой стратегии', 'Per-strategy live statistics')}</summary><div class="ll-table"><table class="ll-live-strategy">
        <thead><tr><th>Strategy</th><th>Gate</th><th>N</th><th>Net</th><th>PF</th><th>½ / ½</th><th>DD $</th></tr></thead>
        <tbody>${liveStrategyRows(liveStrategies, lang, scopeSpecs)}</tbody>
      </table></div></details>`;
  return pageShell(
    requested.strategy
      ? `STRAT-${requested.strategy.code} · ${requested.strategy.name}`
      : requested.group === 'native'
        ? t(lang, 'Native Quant → Lighter — единый портфель', 'Native Quant → Lighter — unified portfolio')
        : t(lang, 'LuxAlgo → Lighter — единый shadow-портфель', 'LuxAlgo → Lighter — unified shadow portfolio'),
    `<style>${LIGHTER_LUXALGO_CSS}</style><div class="ll-wrap">
      <a class="ll-back" href="/lab">${t(lang, '← Лаборатория', '← Lab')}</a>
      <div class="ll-head"><div><span class="ll-badge">${pageBadge}</span>
        <h1>${pageHeading}</h1>
        <p>${pageDescription}</p>
      </div><div class="ll-engine ${s.feedLive ? 'live' : ''}"><i></i>${s.feedLive ? `Lighter L2 · ${scopeMarketCount}/${scopeMarketCount} markets live` : 'Lighter L2 · degraded'}</div></div>

      <div class="ll-modebar" id="portfolio-view">
        <div><small>${t(lang, 'Показатели', 'Dataset')}</small><nav class="ll-tabs">
          <a href="${datasetHref('shadow')}" class="${dataset === 'shadow' ? 'active' : ''}">Shadow</a>
          ${realSupported ? `<a href="${datasetHref('real')}" class="real ${dataset === 'real' ? 'active' : ''}">Real</a>` : ''}
        </nav></div>
        <div><small>${t(lang, 'Шкала графика', 'Chart scale')}</small><nav class="ll-tabs">
          <a href="${chartHref('usd')}" class="${requested.chartUnit === 'usd' ? 'active' : ''}">${t(lang, 'Деньги $', 'Money $')}</a>
          <a href="${chartHref('pct')}" class="${requested.chartUnit === 'pct' ? 'active' : ''}">${t(lang, 'Проценты %', 'Percent %')}</a>
        </nav></div>
      </div>

      ${requested.group === 'native'
    ? nativeMicrostructureReadiness(lang, requested.strategy)
    : ''}

      <div class="ll-grid">
        ${dataset === 'shadow' ? shadowCards : realCards}
      </div>

      ${pnlChart(lang, dataset, requested.chartUnit, scopeIds)}

      ${scopeControl}

      ${nativeStrategyGuide(lang, scopeSpecs)}

      <div class="ll-panel ll-strategy-panel"><h2>${requested.strategy ? `${t(lang, 'Статистика стратегии', 'Strategy statistics')} · STRAT-${requested.strategy.code}` : t(lang, 'Индивидуальная статистика стратегий', 'Individual strategy statistics')}</h2><div class="ll-table"><table class="ll-strategy-table">
        <thead><tr><th>Strategy</th><th>L2</th><th>Backtest · N / WR / PF</th><th>Forward · closed / open</th><th>Net</th><th>DD / halves</th><th>Gate</th></tr></thead>
        <tbody>${strategyRows(lang, scopeSpecs)}</tbody>
      </table></div>
      <p class="ll-note">${requested.group === 'native'
        ? t(
          lang,
          'Native forward-гейт: ≥20 закрытых сделок, net после фактических spread/slippage/funding > 0%, PF ≥1.20, обе половины >0%, max DD ≤5% выделенной мощности, ошибки снимка ≤2%, полный execution-sample на каждую закрытую сделку и p95 возраста стакана ≤2с. Для P2 мощность заранее зафиксирована как 10 одновременных позиций. Универсального лимита издержек нет: их влияние уже отражено в net PnL. При провале новые Shadow-входы останавливаются автоматически; выходы остаются активны.',
          'Native forward gate: ≥20 closed trades, net after actual spread/slippage/funding > 0%, PF ≥1.20, both halves >0%, max DD ≤5% of allocated capacity, capture errors ≤2%, a complete execution sample for every closed trade, and book-age p95 ≤2s. P2 capacity is frozen at 10 concurrent positions. There is no universal cost ceiling because its impact is already embedded in net PnL. A failure automatically pauses new Shadow entries while exits remain active.',
        )
        : t(lang, 'Гейт: ≥20 закрытых Lighter-forward сделок, net > 0%, PF ≥1.20, обе половины >0%.', 'Gate: ≥20 closed Lighter-forward trades, net > 0%, PF ≥1.20, and both halves >0%.')}</p></div>

      <div class="ll-panel" id="signal-history"><h2>${t(lang, 'История сигналов', 'Signal history')}</h2>
        <div class="ll-table"><table class="ll-signal-table">
          <thead><tr><th>Strategy</th><th>${t(lang, 'Сигнал №', 'Signal #')}</th><th>${t(lang, 'Время UTC', 'Time UTC')}</th><th>Event</th><th>Shadow-${t(lang, 'сделка', 'trade')}</th><th>Real-${t(lang, 'сделка', 'trade')}</th><th>${t(lang, 'Статус сигнала', 'Signal status')}</th></tr></thead>
          <tbody>${signalRows(signals, lang)}</tbody>
        </table></div>
        ${pager({ lang, page: signalsPage, total: signalsTotal, pageSize: SIGNAL_PAGE_SIZE, signalsPage, tradesPage, target: 'signals', strategyId, group: requested.group, dataset, chartUnit: requested.chartUnit })}
      </div>

      <div class="ll-panel" id="shadow-trades"><h2>${t(lang, 'Сделки', 'Trades')}</h2><div class="ll-table"><table class="ll-trades ll-shadow-trades">
        <thead><tr><th>Strategy</th><th>${t(lang, 'Открыта → закрыта UTC', 'Opened → closed UTC')}</th><th>Side / size</th><th>${t(lang, 'Цена входа', 'Entry price')}</th><th>${t(lang, 'Стоп-лосс', 'Stop-loss')}</th><th>${t(lang, 'Цена выхода', 'Exit price')}</th><th>${t(lang, 'Статус', 'Status')}</th><th>Net after costs</th></tr></thead>
        <tbody>${tradeRows(trades, lang)}</tbody>
      </table></div>
      ${pager({ lang, page: tradesPage, total: tradesTotal, pageSize: TRADE_PAGE_SIZE, signalsPage, tradesPage, target: 'trades', strategyId, group: requested.group, dataset, chartUnit: requested.chartUnit })}</div>

      ${realSupported ? `<div class="ll-panel"><div class="ll-chart-head"><div><h2>${t(lang, 'Реальная торговля · canary', 'Live trading · canary')}</h2>
        <p class="ll-note"><b class="${livePortfolioPaused || !liveMonitor || !liveEntryEnabled ? 'fail' : 'pass'}">${liveRunnerLabel} · $100 · 10x.</b> ${liveScopeText}${liveState?.last_error ? ` <span class="neg">${esc(liveState.last_error)}</span>` : ''}${liveState?.portfolio_pause_reason ? ` <span class="neg">${esc(liveState.portfolio_pause_reason)}</span>` : ''}</p>
        </div><span class="ll-badge ${liveGatePassed ? 'pass' : 'collect'}">${liveGatePassed ? t(lang, 'LIVE ГЕЙТ ПРОЙДЕН', 'LIVE GATE PASSED') : `${t(lang, 'LIVE ВАЛИДАЦИЯ', 'LIVE VALIDATION')} ${liveSummary.closed}/30`}</span></div>
        <div class="ll-live-grid">
          <div class="ll-live-metric"><small>${t(lang, 'Закрыто', 'Closed')}</small><b>${liveSummary.closed}/30</b></div>
          <div class="ll-live-metric"><small>Real net PnL</small><b class="${pnlClass(liveSummary.netUsd)}">${signedUsd(liveSummary.netUsd)}</b><em>${signedPct(liveNetPct)}</em></div>
          <div class="ll-live-metric"><small>WR / PF</small><b>${liveWr == null ? '—' : `${liveWr.toFixed(0)}%`} / ${pfLabel(liveSummary.profitFactor)}</b></div>
          <div class="ll-live-metric"><small>${t(lang, 'Половины', 'Halves')}</small><b>${signedUsd(liveSummary.firstHalfUsd)} / ${signedUsd(liveSummary.secondHalfUsd)}</b></div>
          <div class="ll-live-metric"><small>Max drawdown</small><b class="${liveSummary.maxDrawdownUsd > 0 ? 'neg' : ''}">−$${liveSummary.maxDrawdownUsd.toFixed(2)} / $15</b></div>
          <div class="ll-live-metric"><small>${t(lang, 'Текущая просадка', 'Current drawdown')}</small><b class="${currentDrawdownUsd > 0 ? 'neg' : ''}">−$${currentDrawdownUsd.toFixed(2)}</b></div>
          <div class="ll-live-metric"><small>${t(lang, 'Real − shadow', 'Real − shadow')}</small><b class="${execution.avgGapPct == null ? '' : pnlClass(execution.avgGapPct)}">${execution.avgGapPct == null ? '—' : `${execution.avgGapPct > 0 ? '+' : execution.avgGapPct < 0 ? '−' : ''}${Math.abs(execution.avgGapPct).toFixed(4)} ${t(lang, 'п.п.', 'pp')}`}</b><em>${execution.matched ? `${signedPct(execution.realPct)} vs ${signedPct(execution.shadowPct)} · N ${execution.matched}` : t(lang, 'ждём закрытую пару', 'waiting for a closed pair')}</em></div>
          <div class="ll-live-metric"><small>Latency P50</small><b>${latency(latencyMetrics.signalToProtectedMs)}</b><em>S→O ${latency(latencyMetrics.signalToOrderMs)} · O→POS ${latency(latencyMetrics.orderToPositionMs)} · N ${latencyMetrics.measured}</em></div>
        </div>
        ${liveStrategyDetails}
        <div class="ll-table"><table class="ll-trades ll-live-trades">
          <thead><tr><th>Strategy</th><th>${t(lang, 'Открыта → закрыта UTC', 'Opened → closed UTC')}</th><th>Side / size</th><th>${t(lang, 'Цена входа', 'Entry price')}</th><th>${t(lang, 'Стоп-лосс', 'Stop-loss')}</th><th>${t(lang, 'Цена выхода', 'Exit price')}</th><th>${t(lang, 'Статус', 'Status')}</th><th>Net after costs</th></tr></thead>
          <tbody>${liveTradeRows(liveTrades, lang)}</tbody>
        </table></div>
      </div>` : ''}

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
      group?: string;
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
      group: selectedGroup(req.query.group),
      dataset: selectedDataset(req.query.dataset),
      chartUnit: selectedChartUnit(req.query.chart),
    });
  });
}

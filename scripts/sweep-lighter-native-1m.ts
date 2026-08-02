/**
 * Native Lighter 1-minute strategy sweep.
 *
 * Uses candles downloaded by verify-passive-lowtf.ts with DATA_SOURCE=lighter.
 * Signals are computed only from completed candles and execute at the next
 * candle open. Commission is zero for a Standard account; an independent
 * measured-cost discovery reserve is subtracted from every trade. A second,
 * measured worst-observed reserve is reported as sensitivity evidence only.
 *
 * Run after downloading native candles:
 *   pnpm tsx scripts/sweep-lighter-native-1m.ts
 *   ALLOW_FALLBACK_EXECUTION_COST=1 FALLBACK_EXECUTION_COST_PCT=0.02 \
 *     pnpm tsx scripts/sweep-lighter-native-1m.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atr, ema, rollingStd, rsi, sma, type Candle } from '../src/backtest/indicators.js';
import {
  choppinessIndex,
  connorsRsi,
  elderForceIndexZScore,
  priceVolumeTrendOscillator,
  rollingRegressionResidualZScore,
  rollingVarianceRatio,
  ultimateOscillator,
} from '../src/lib/lighter-independent-indicators.js';
import {
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  lighterFundingPnlPct,
  type LighterFundingPoint,
  type LighterFundingSeries,
} from '../src/lib/lighter-funding-history.js';
import {
  completedFundingZScore,
  fundingCrowdingSide,
} from '../src/lib/lighter-funding-crowding.js';
import {
  completedLagOneReturnCorrelation,
  serialAdaptiveSide,
} from '../src/lib/lighter-serial-adaptive.js';

const SYMBOLS = (process.env.SYMBOLS ?? 'BTC,ETH,SOL')
  .split(',')
  .map((symbol) => symbol.trim())
  .filter(Boolean);
// Selection uses each market's measured executable L2 p95. A common fallback
// would silently turn an adverse scenario into an assumed trading cost, so it
// is disabled unless an exploratory run explicitly opts in. The separate
// adverse result uses the worst executable round-trip observed in the same
// market/notional sample. It is sensitivity evidence only: no arbitrary fixed
// percentage or multiplier can become an eligibility filter.
const FALLBACK_EXECUTION_COST_PCT = Number(
  process.env.FALLBACK_EXECUTION_COST_PCT ?? 0.02,
);
const ALLOW_FALLBACK_EXECUTION_COST = process.env.ALLOW_FALLBACK_EXECUTION_COST === '1';
const FALLBACK_FUNDING_PER_HOUR_PCT = Number(
  process.env.FALLBACK_FUNDING_PER_HOUR_PCT ?? 0.00125,
);
const ALLOW_FALLBACK_FUNDING = process.env.ALLOW_FALLBACK_FUNDING === '1';
const FUNDING_HISTORY_FILES = (
  process.env.FUNDING_HISTORY_FILES
    ?? process.env.FUNDING_HISTORY_FILE
    ?? 'data/lighter-funding-history-native.json'
)
  .split(',')
  .map((file) => file.trim())
  .filter(Boolean)
  .map((file) => resolve(file));
const OUTPUT_JSON = process.env.OUTPUT_JSON ? resolve(process.env.OUTPUT_JSON) : null;
const OUTPUT_INCLUDE_TRADE_DETAILS = process.env.OUTPUT_INCLUDE_TRADE_DETAILS === '1';
const KLINES_DIR = resolve(process.env.LIGHTER_KLINES_DIR ?? 'data/lighter-klines');
const BAR_MINUTES = Number(process.env.BAR_MINUTES ?? 1);
const Z_PERIODS = (process.env.Z_PERIODS ?? '20,60').split(',').map(Number);
const Z_THRESHOLDS = (process.env.Z_THRESHOLDS ?? '1.5,2,2.5,3').split(',').map(Number);
const VWZ_THRESHOLDS = (process.env.VWZ_THRESHOLDS ?? '2.25,2.5,2.75,3').split(',').map(Number);
const Z_SL_PCT = Number(process.env.Z_SL_PCT ?? 1.5) / 100;
const Z_MAX_HOLD_BARS = Number(process.env.Z_MAX_HOLD_BARS ?? 240);
const MAX_BACKTEST_DD_PCT = Number(process.env.MAX_BACKTEST_DD_PCT ?? 15);
const RULE_FILTER = process.env.RULE_FILTER ?? '';
const ENABLE_SQUEEZE = process.env.ENABLE_SQUEEZE === '1';
const ENABLE_TREND_PULLBACK = process.env.ENABLE_TREND_PULLBACK === '1';
const ENABLE_FAILED_BREAKOUT = process.env.ENABLE_FAILED_BREAKOUT === '1';
const ENABLE_HOURLY_FADE = process.env.ENABLE_HOURLY_FADE === '1';
const ENABLE_HOURLY_FADE_HIGHVOL = process.env.ENABLE_HOURLY_FADE_HIGHVOL === '1';
const ENABLE_SERIAL_ADAPTIVE = process.env.ENABLE_SERIAL_ADAPTIVE === '1';
const ENABLE_FUNDING_CROWDING = process.env.ENABLE_FUNDING_CROWDING === '1';
const ENABLE_SHOCK_REVERSAL = process.env.ENABLE_SHOCK_REVERSAL === '1';
const ENABLE_RSI_PULLBACK_ROBUSTNESS = process.env.ENABLE_RSI_PULLBACK_ROBUSTNESS === '1';
const ENABLE_DIRECTIONAL_TREND = process.env.ENABLE_DIRECTIONAL_TREND === '1';
const ENABLE_OSCILLATOR_CONFLUENCE = process.env.ENABLE_OSCILLATOR_CONFLUENCE === '1';
const ENABLE_CONFLUENCE_ROBUSTNESS = process.env.ENABLE_CONFLUENCE_ROBUSTNESS === '1';
const ENABLE_BOLLINGER_RSI_CONFLUENCE =
  process.env.ENABLE_BOLLINGER_RSI_CONFLUENCE === '1';
const ENABLE_TREND_MOMENTUM_RECLAIM =
  process.env.ENABLE_TREND_MOMENTUM_RECLAIM === '1';
const ENABLE_TREND_VOLATILITY_FAMILIES =
  process.env.ENABLE_TREND_VOLATILITY_FAMILIES === '1';
const ENABLE_FAST_CONFLUENCE_FAMILIES =
  process.env.ENABLE_FAST_CONFLUENCE_FAMILIES === '1';
const ENABLE_FAST_CONFLUENCE_FAMILIES_V2 =
  process.env.ENABLE_FAST_CONFLUENCE_FAMILIES_V2 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V3 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V3 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V4 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V4 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V5 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V5 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V6 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V6 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V7 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V7 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V8 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V8 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V9 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V9 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V10 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V10 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V11 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V11 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V12 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V12 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V13 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V13 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V14 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V14 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V15 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V15 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V16 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V16 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V17 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V17 === '1';
const ENABLE_INDEPENDENT_FAMILIES_V18 =
  process.env.ENABLE_INDEPENDENT_FAMILIES_V18 === '1';
const PORTFOLIO_MAX_OPEN = Number(process.env.PORTFOLIO_MAX_OPEN ?? 6);
const PORTFOLIO_POSITION_NOTIONAL_USD = Number(
  process.env.PORTFOLIO_POSITION_NOTIONAL_USD ?? 100,
);
const MAX_PORTFOLIO_DD_PCT = Number(process.env.MAX_PORTFOLIO_DD_PCT ?? 5);
const PORTFOLIO_MIN_COVERAGE_DAYS = Number(
  process.env.PORTFOLIO_MIN_COVERAGE_DAYS ?? 171,
);
const DEFAULT_EXECUTION_COST_FILES = [
  'data/lighter-execution-costs-majors-20260731.json',
  'data/lighter-execution-costs-zec-doge-near-jup.json',
  'data/lighter-execution-costs-lit-pump-gram-xmr.json',
  'data/lighter-execution-costs-popcat-ena-arb-tao.json',
  'data/lighter-execution-costs-hype-20260731.json',
  // The portfolio trades $100 notionals. Keep this file last so its
  // market-specific measurements supersede older $1,000 discovery samples.
  'data/lighter-execution-costs-native-portfolio-100-20260731.json',
  // Created only after the continuous native dataset passes the frozen 21-day
  // quality gate. Once present, it supersedes the short discovery sample.
  'data/lighter-execution-costs-native-frozen.json',
];
const EXECUTION_COST_FILES = (process.env.EXECUTION_COST_FILES
  ?? DEFAULT_EXECUTION_COST_FILES.filter((file) => existsSync(resolve(file))).join(','))
  .split(',')
  .map((file) => file.trim())
  .filter(Boolean);
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 0);
const RECENT_WINDOWS_DAYS = (process.env.RECENT_WINDOWS_DAYS ?? '30,60,90')
  .split(',')
  .map(Number)
  .filter((days) => Number.isFinite(days) && days > 0);

type Side = 'long' | 'short';
type Arrays = {
  c: Candle[];
  close: number[];
  ema200: number[];
  ema300: number[];
  ema400: number[];
  ema500: number[];
  ema5: number[];
  ema8: number[];
  ema13: number[];
  ema21: number[];
  ema34: number[];
  ema55: number[];
  macd: number[];
  macdSignal: number[];
  sma20: number[];
  sma60: number[];
  volumeSma20: number[];
  volumeSma60: number[];
  sd20: number[];
  sd60: number[];
  means: Map<number, number[]>;
  deviations: Map<number, number[]>;
  atr14: number[];
  plusDi14: number[];
  minusDi14: number[];
  adx14: number[];
  supertrend10x3: number[];
  atrPctMean288: number[];
  rsi2: number[];
  rsi7: number[];
  rsi14: number[];
  stoch14: number[];
  stoch14Signal: number[];
  cci20: number[];
  mfi14: number[];
  williams14: number[];
  waveTrend10x21: number[];
  waveTrendSignal4: number[];
  fisher10: number[];
  fisherSignal: number[];
  chaikinMoneyFlow20: number[];
  aroonUp25: number[];
  aroonDown25: number[];
  stochasticRsi14K3: number[];
  stochasticRsi14D3: number[];
  trueStrengthIndex25x13: number[];
  trueStrengthSignal7: number[];
  vortexPlus14: number[];
  vortexMinus14: number[];
  kama10: number[];
  kama30: number[];
  relativeVigor10: number[];
  relativeVigorSignal4: number[];
  trix15: number[];
  trixSignal9: number[];
  ultimateOscillator7x14x28: number[];
  elderForceIndex13Z60: number[];
  choppiness14: number[];
  pvt12x26: number[];
  pvtSignal9: number[];
  deMarker14: number[];
  stochasticMomentum14x3x3: number[];
  stochasticMomentumSignal3: number[];
  connorsRsi3x2x100: number[];
  regressionResidualZ60x60: number[];
  varianceRatio120x5: number[];
  vwap60: number[];
  vwapSd60: number[];
  efficiencyRatio60: number[];
  serialCorrelation120: number[];
  fundingZ168: number[];
  squeeze20: boolean[];
};
type Rule = {
  name: string;
  warmup: number;
  slPct: number;
  maxBars: number;
  entry: (a: Arrays, i: number) => Side | null;
  exit: (a: Arrays, i: number, side: Side) => boolean;
};
type TrendRegime = 'bull' | 'bear' | 'mixed';
type VolatilityRegime = 'highVol' | 'lowVol';
type Trade = {
  side: Side;
  entryAt: number;
  exitAt: number;
  entryIdx: number;
  pct: number;
  fundingPct?: number;
};
type PortfolioTrade = Trade & {
  symbol: string;
  costPct: number;
  adverseCostPct: number;
  trendRegime: TrendRegime;
  volatilityRegime: VolatilityRegime;
};
type ClassifiedTrade = Trade & {
  trendRegime: TrendRegime;
  volatilityRegime: VolatilityRegime;
};
type WindowStats = {
  days: number;
  n: number;
  net: number;
  profitFactor: number;
  winRatePct: number;
  long: number;
  short: number;
};

type ExecutionCostFile = {
  notionalUsd?: number;
  summaries?: Record<string, {
    p95Pct?: number | null;
    maxPct?: number | null;
  }>;
};

type ExecutionCost = { p95Pct: number; adversePct: number };
const executionCostBySymbol = new Map<string, ExecutionCost>();
let usedFallbackExecutionCost = false;
for (const file of EXECUTION_COST_FILES) {
  const parsed = JSON.parse(readFileSync(resolve(file), 'utf8')) as ExecutionCostFile;
  // VWAP/slippage is not portable across order sizes. Never qualify a
  // strategy with measurements collected for a different notional.
  if (
    parsed.notionalUsd == null
    || Math.abs(parsed.notionalUsd - PORTFOLIO_POSITION_NOTIONAL_USD) > 0.01
  ) continue;
  for (const [symbol, summary] of Object.entries(parsed.summaries ?? {})) {
    if (summary.p95Pct != null && Number.isFinite(summary.p95Pct) && summary.p95Pct >= 0) {
      const measuredMax = summary.maxPct != null
        && Number.isFinite(summary.maxPct)
        && summary.maxPct >= summary.p95Pct
        ? summary.maxPct
        : summary.p95Pct;
      executionCostBySymbol.set(symbol.toUpperCase(), {
        p95Pct: summary.p95Pct,
        adversePct: measuredMax,
      });
    }
  }
}

type FundingHistoryFile = {
  symbols?: Record<string, {
    fundings?: LighterFundingPoint[];
  }>;
};
const fundingBySymbol = new Map<string, LighterFundingSeries>();
let usedFallbackFunding = false;
const fundingCoverageBySymbol = new Map<string, {
  points: number;
  internalCoverage: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
}>();
for (const file of FUNDING_HISTORY_FILES) {
  if (!existsSync(file)) continue;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as FundingHistoryFile;
  for (const [symbol, value] of Object.entries(parsed.symbols ?? {})) {
    fundingBySymbol.set(
      symbol.toUpperCase(),
      buildLighterFundingSeries(value.fundings ?? []),
    );
  }
}

function fundingSeries(symbol: string, candles: readonly Candle[]): LighterFundingSeries | null {
  const series = fundingBySymbol.get(symbol.toUpperCase());
  const firstCandle = candles[0]?.t ?? 0;
  const lastCandle = candles.at(-1)?.t ?? 0;
  if (series != null) {
    const coverage = fundingSeriesCoverage(series, firstCandle, lastCandle);
    fundingCoverageBySymbol.set(symbol.toUpperCase(), {
      points: coverage.points,
      internalCoverage: coverage.internalCoverage,
      firstTimestampMs: coverage.firstTimestampMs,
      lastTimestampMs: coverage.lastTimestampMs,
    });
    if (coverage.covered) return series;
    if (!ALLOW_FALLBACK_FUNDING) {
      throw new Error(
        `${symbol}: funding history coverage ${(coverage.internalCoverage * 100).toFixed(2)}% `
        + `does not span ${new Date(firstCandle).toISOString()}..${new Date(lastCandle).toISOString()}`,
      );
    }
  }
  if (ALLOW_FALLBACK_FUNDING) {
    usedFallbackFunding = true;
    return null;
  }
  throw new Error(
    `${symbol}: measured hourly funding history missing. Fetch it first or explicitly set `
    + 'ALLOW_FALLBACK_FUNDING=1 for a non-qualifying exploratory run.',
  );
}

function tradeFundingPct(
  series: LighterFundingSeries | null,
  trade: Trade,
): number {
  if (series != null) {
    return lighterFundingPnlPct(
      series,
      trade.side,
      trade.entryAt,
      trade.exitAt,
    );
  }
  const holdHours = Math.max(0, trade.exitAt - trade.entryAt) / 3_600_000;
  return -holdHours * FALLBACK_FUNDING_PER_HOUR_PCT;
}

function executionCost(symbol: string): ExecutionCost {
  const measured = executionCostBySymbol.get(symbol.toUpperCase());
  if (measured != null) return measured;
  if (ALLOW_FALLBACK_EXECUTION_COST) {
    usedFallbackExecutionCost = true;
    return {
      p95Pct: FALLBACK_EXECUTION_COST_PCT,
      adversePct: FALLBACK_EXECUTION_COST_PCT,
    };
  }
  throw new Error(
    `No measured executable p95 cost for ${symbol}. Sample its L2 first or explicitly set `
    + 'ALLOW_FALLBACK_EXECUTION_COST=1 for a non-qualifying exploratory run.',
  );
}

function aggregateCandles(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return candles;
  const bucketMs = minutes * 60_000;
  const buckets = new Map<number, Candle & { count: number }>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.t / bucketMs) * bucketMs;
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, { t: bucket, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v, count: 1 });
    } else {
      current.h = Math.max(current.h, candle.h);
      current.l = Math.min(current.l, candle.l);
      current.c = candle.c;
      current.v += candle.v;
      current.count++;
    }
  }
  return [...buckets.values()]
    .filter((candle) => candle.count === minutes)
    .map(({ count: _, ...candle }) => candle)
    .sort((a, b) => a.t - b.t);
}

function stochastic(candles: Candle[], period: number): number[] {
  return candles.map((bar, i) => {
    if (i + 1 < period) return 50;
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      high = Math.max(high, candles[j]!.h);
      low = Math.min(low, candles[j]!.l);
    }
    return high > low ? (bar.c - low) / (high - low) * 100 : 50;
  });
}

function cci(candles: Candle[], period: number): number[] {
  const typical = candles.map((bar) => (bar.h + bar.l + bar.c) / 3);
  const mean = sma(typical, period);
  return typical.map((value, i) => {
    if (i + 1 < period) return 0;
    let deviation = 0;
    for (let j = i - period + 1; j <= i; j++) {
      deviation += Math.abs(typical[j]! - mean[i]!);
    }
    deviation /= period;
    return deviation > 0 ? (value - mean[i]!) / (0.015 * deviation) : 0;
  });
}

function moneyFlowIndex(candles: Candle[], period: number): number[] {
  const typical = candles.map((bar) => (bar.h + bar.l + bar.c) / 3);
  const positive = typical.map((value, i) =>
    i > 0 && value > typical[i - 1]! ? value * candles[i]!.v : 0);
  const negative = typical.map((value, i) =>
    i > 0 && value < typical[i - 1]! ? value * candles[i]!.v : 0);
  const positiveSum = sma(positive, period).map((value) => value * period);
  const negativeSum = sma(negative, period).map((value) => value * period);
  return typical.map((_, i) => {
    if (i + 1 < period) return 50;
    if (negativeSum[i]! === 0) return positiveSum[i]! > 0 ? 100 : 50;
    const ratio = positiveSum[i]! / negativeSum[i]!;
    return 100 - 100 / (1 + ratio);
  });
}

function williamsR(candles: Candle[], period: number): number[] {
  return candles.map((bar, i) => {
    if (i + 1 < period) return -50;
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      high = Math.max(high, candles[j]!.h);
      low = Math.min(low, candles[j]!.l);
    }
    return high > low ? -100 * (high - bar.c) / (high - low) : -50;
  });
}

/** Completed-bar DeMarker oscillator, bounded to [0, 1]. */
function deMarker(candles: Candle[], period: number): number[] {
  const up = candles.map((bar, i) =>
    i > 0 ? Math.max(0, bar.h - candles[i - 1]!.h) : 0);
  const down = candles.map((bar, i) =>
    i > 0 ? Math.max(0, candles[i - 1]!.l - bar.l) : 0);
  const upMean = sma(up, period);
  const downMean = sma(down, period);
  return candles.map((_, i) => {
    const denominator = upMean[i]! + downMean[i]!;
    return denominator > 0 ? upMean[i]! / denominator : 0.5;
  });
}

/**
 * Completed-bar Stochastic Momentum Index. The distance from the rolling
 * high/low midpoint and half-range are both double-smoothed before division.
 */
function stochasticMomentumIndex(
  candles: Candle[],
  period: number,
  firstSmooth: number,
  secondSmooth: number,
  signalPeriod: number,
): { oscillator: number[]; signal: number[] } {
  const distance = new Array<number>(candles.length).fill(0);
  const halfRange = new Array<number>(candles.length).fill(0);
  for (let i = period - 1; i < candles.length; i += 1) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      high = Math.max(high, candles[j]!.h);
      low = Math.min(low, candles[j]!.l);
    }
    distance[i] = candles[i]!.c - (high + low) / 2;
    halfRange[i] = (high - low) / 2;
  }
  const smoothDistance = ema(ema(distance, firstSmooth), secondSmooth);
  const smoothRange = ema(ema(halfRange, firstSmooth), secondSmooth);
  const oscillator = smoothDistance.map((value, i) =>
    smoothRange[i]! > 0 ? 100 * value / smoothRange[i]! : 0);
  return { oscillator, signal: ema(oscillator, signalPeriod) };
}

/**
 * LazyBear-style WaveTrend oscillator. All values at index i use only the
 * completed candle i and earlier candles; orders are still filled on i + 1.
 */
function waveTrend(
  candles: Candle[],
  channelPeriod: number,
  averagePeriod: number,
  signalPeriod: number,
): { oscillator: number[]; signal: number[] } {
  const averagePrice = candles.map((bar) => (bar.h + bar.l + bar.c) / 3);
  const esa = ema(averagePrice, channelPeriod);
  const deviation = ema(
    averagePrice.map((value, i) => Math.abs(value - esa[i]!)),
    channelPeriod,
  );
  const channelIndex = averagePrice.map((value, i) =>
    deviation[i]! > 0 ? (value - esa[i]!) / (0.015 * deviation[i]!) : 0);
  const oscillator = ema(channelIndex, averagePeriod);
  return { oscillator, signal: sma(oscillator, signalPeriod) };
}

/** Standard Ehlers Fisher Transform of the rolling HL2 position. */
function fisherTransform(
  candles: Candle[],
  period: number,
): { fisher: number[]; signal: number[] } {
  const fisher = new Array<number>(candles.length).fill(0);
  const signal = new Array<number>(candles.length).fill(0);
  const value = new Array<number>(candles.length).fill(0);
  const hl2 = candles.map((bar) => (bar.h + bar.l) / 2);
  for (let i = 1; i < candles.length; i += 1) {
    signal[i] = fisher[i - 1]!;
    if (i + 1 < period) continue;
    let low = Infinity;
    let high = -Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      low = Math.min(low, hl2[j]!);
      high = Math.max(high, hl2[j]!);
    }
    const normalized = high > low
      ? 2 * ((hl2[i]! - low) / (high - low) - 0.5)
      : 0;
    value[i] = Math.max(
      -0.999,
      Math.min(0.999, 0.33 * normalized + 0.67 * value[i - 1]!),
    );
    fisher[i] = 0.5 * Math.log((1 + value[i]!) / (1 - value[i]!))
      + 0.5 * fisher[i - 1]!;
  }
  return { fisher, signal };
}

/** Completed-bar Chaikin Money Flow; values are bounded to [-1, 1]. */
function chaikinMoneyFlow(candles: Candle[], period: number): number[] {
  const flowVolume = candles.map((bar) => {
    const range = bar.h - bar.l;
    return range > 0 ? ((2 * bar.c - bar.h - bar.l) / range) * bar.v : 0;
  });
  const output = new Array<number>(candles.length).fill(0);
  let flowSum = 0;
  let volumeSum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    flowSum += flowVolume[i]!;
    volumeSum += candles[i]!.v;
    if (i >= period) {
      flowSum -= flowVolume[i - period]!;
      volumeSum -= candles[i - period]!.v;
    }
    if (i + 1 >= period && volumeSum > 0) output[i] = flowSum / volumeSum;
  }
  return output;
}

/** Time-since-extreme Aroon pair, computed only from completed candles. */
function aroon(
  candles: Candle[],
  period: number,
): { up: number[]; down: number[] } {
  const up = new Array<number>(candles.length).fill(50);
  const down = new Array<number>(candles.length).fill(50);
  for (let i = period - 1; i < candles.length; i += 1) {
    let highestIndex = i - period + 1;
    let lowestIndex = highestIndex;
    for (let j = highestIndex + 1; j <= i; j += 1) {
      if (candles[j]!.h >= candles[highestIndex]!.h) highestIndex = j;
      if (candles[j]!.l <= candles[lowestIndex]!.l) lowestIndex = j;
    }
    up[i] = 100 * (period - (i - highestIndex)) / period;
    down[i] = 100 * (period - (i - lowestIndex)) / period;
  }
  return { up, down };
}

/** Completed-bar Stochastic RSI with smoothed K/D lines. */
function stochasticRsi(
  rsiValues: number[],
  period: number,
  smoothK: number,
  smoothD: number,
): { k: number[]; d: number[] } {
  const raw = new Array<number>(rsiValues.length).fill(50);
  for (let i = period - 1; i < rsiValues.length; i += 1) {
    let low = Infinity;
    let high = -Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      low = Math.min(low, rsiValues[j]!);
      high = Math.max(high, rsiValues[j]!);
    }
    raw[i] = high > low ? 100 * (rsiValues[i]! - low) / (high - low) : 50;
  }
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}

/** William Blau True Strength Index and its completed-bar EMA signal. */
function trueStrengthIndex(
  values: number[],
  longPeriod: number,
  shortPeriod: number,
  signalPeriod: number,
): { tsi: number[]; signal: number[] } {
  const momentum = values.map((value, i) => i === 0 ? 0 : value - values[i - 1]!);
  const absoluteMomentum = momentum.map(Math.abs);
  const smoothedMomentum = ema(ema(momentum, longPeriod), shortPeriod);
  const smoothedAbsolute = ema(ema(absoluteMomentum, longPeriod), shortPeriod);
  const tsi = smoothedMomentum.map((value, i) =>
    smoothedAbsolute[i]! > 0 ? 100 * value / smoothedAbsolute[i]! : 0);
  return { tsi, signal: ema(tsi, signalPeriod) };
}

/** Completed-bar Vortex Indicator using rolling true-range normalisation. */
function vortexIndicator(
  candles: Candle[],
  period: number,
): { plus: number[]; minus: number[] } {
  const plus = new Array<number>(candles.length).fill(1);
  const minus = new Array<number>(candles.length).fill(1);
  const trueRanges = new Array<number>(candles.length).fill(0);
  const plusMovement = new Array<number>(candles.length).fill(0);
  const minusMovement = new Array<number>(candles.length).fill(0);
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;
    trueRanges[i] = Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    );
    plusMovement[i] = Math.abs(current.h - previous.l);
    minusMovement[i] = Math.abs(current.l - previous.h);
    trSum += trueRanges[i]!;
    plusSum += plusMovement[i]!;
    minusSum += minusMovement[i]!;
    if (i >= period) {
      trSum -= trueRanges[i - period]!;
      plusSum -= plusMovement[i - period]!;
      minusSum -= minusMovement[i - period]!;
    }
    if (i + 1 >= period && trSum > 0) {
      plus[i] = plusSum / trSum;
      minus[i] = minusSum / trSum;
    }
  }
  return { plus, minus };
}

/** Kaufman Adaptive Moving Average; every value uses completed closes only. */
function kaufmanAdaptiveMovingAverage(
  values: number[],
  efficiencyPeriod: number,
  fastPeriod = 2,
  slowPeriod = 30,
): number[] {
  if (!values.length) return [];
  const output = new Array<number>(values.length).fill(values[0]!);
  const fast = 2 / (fastPeriod + 1);
  const slow = 2 / (slowPeriod + 1);
  let volatility = 0;
  for (let i = 1; i < values.length; i += 1) {
    volatility += Math.abs(values[i]! - values[i - 1]!);
    if (i > efficiencyPeriod) {
      volatility -= Math.abs(
        values[i - efficiencyPeriod]! - values[i - efficiencyPeriod - 1]!,
      );
    }
    const change = i >= efficiencyPeriod
      ? Math.abs(values[i]! - values[i - efficiencyPeriod]!)
      : 0;
    const efficiency = volatility > 0 ? change / volatility : 0;
    const smoothing = (efficiency * (fast - slow) + slow) ** 2;
    output[i] = output[i - 1]! + smoothing * (values[i]! - output[i - 1]!);
  }
  return output;
}

/**
 * Relative Vigor Index with the canonical four-bar symmetric smoothing.
 * Every output value is derived exclusively from completed OHLC bars.
 */
function relativeVigorIndex(
  candles: Candle[],
  period: number,
  signalPeriod: number,
): { vigor: number[]; signal: number[] } {
  const numerator = new Array<number>(candles.length).fill(0);
  const denominator = new Array<number>(candles.length).fill(0);
  for (let i = 3; i < candles.length; i += 1) {
    numerator[i] = (
      (candles[i]!.c - candles[i]!.o)
      + 2 * (candles[i - 1]!.c - candles[i - 1]!.o)
      + 2 * (candles[i - 2]!.c - candles[i - 2]!.o)
      + (candles[i - 3]!.c - candles[i - 3]!.o)
    ) / 6;
    denominator[i] = (
      (candles[i]!.h - candles[i]!.l)
      + 2 * (candles[i - 1]!.h - candles[i - 1]!.l)
      + 2 * (candles[i - 2]!.h - candles[i - 2]!.l)
      + (candles[i - 3]!.h - candles[i - 3]!.l)
    ) / 6;
  }
  const numeratorMean = sma(numerator, period);
  const denominatorMean = sma(denominator, period);
  const vigor = numeratorMean.map((value, i) => (
    denominatorMean[i]! > 0 ? value / denominatorMean[i]! : 0
  ));
  return { vigor, signal: sma(vigor, signalPeriod) };
}

/** Triple-smoothed rate of change (TRIX), plus its canonical EMA9 signal. */
function trix(
  values: number[],
  period: number,
  signalPeriod: number,
): { oscillator: number[]; signal: number[] } {
  const triple = ema(ema(ema(values, period), period), period);
  const oscillator = triple.map((value, i) => {
    const previous = i > 0 ? triple[i - 1]! : value;
    return previous !== 0 ? ((value / previous) - 1) * 100 : 0;
  });
  return { oscillator, signal: ema(oscillator, signalPeriod) };
}

function rollingVolumeWeighted(
  candles: Candle[],
  period: number,
): { mean: number[]; deviation: number[] } {
  const mean = new Array<number>(candles.length).fill(0);
  const deviation = new Array<number>(candles.length).fill(0);
  let volumeSum = 0;
  let weightedSum = 0;
  let weightedSquareSum = 0;
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;
    volumeSum += bar.v;
    weightedSum += bar.c * bar.v;
    weightedSquareSum += bar.c * bar.c * bar.v;
    if (i >= period) {
      const removed = candles[i - period]!;
      volumeSum -= removed.v;
      weightedSum -= removed.c * removed.v;
      weightedSquareSum -= removed.c * removed.c * removed.v;
    }
    if (volumeSum > 0) {
      mean[i] = weightedSum / volumeSum;
      const variance = Math.max(0, weightedSquareSum / volumeSum - mean[i]! * mean[i]!);
      deviation[i] = Math.sqrt(variance);
    } else {
      mean[i] = bar.c;
    }
  }
  return { mean, deviation };
}

/**
 * Kaufman's efficiency ratio. Values near zero describe a noisy/choppy path;
 * values near one describe directional movement. Only completed closes up to
 * index i are used, so it is safe for next-bar execution.
 */
function efficiencyRatio(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(0);
  const changes = values.map((value, i) =>
    i === 0 ? 0 : Math.abs(value - values[i - 1]!));
  let path = 0;
  for (let i = 1; i < values.length; i++) {
    path += changes[i]!;
    if (i > period) path -= changes[i - period]!;
    if (i >= period && path > 0) {
      result[i] = Math.abs(values[i]! - values[i - period]!) / path;
    }
  }
  return result;
}

/** Wilder DMI/ADX from completed candles only. */
function directionalIndex(
  candles: Candle[],
  period: number,
): { plusDi: number[]; minusDi: number[]; adx: number[] } {
  const length = candles.length;
  const trueRange = new Array<number>(length).fill(0);
  const plusDm = new Array<number>(length).fill(0);
  const minusDm = new Array<number>(length).fill(0);
  for (let i = 1; i < length; i += 1) {
    const bar = candles[i]!;
    const prior = candles[i - 1]!;
    trueRange[i] = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prior.c),
      Math.abs(bar.l - prior.c),
    );
    const up = bar.h - prior.h;
    const down = prior.l - bar.l;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  const plusDi = new Array<number>(length).fill(0);
  const minusDi = new Array<number>(length).fill(0);
  const dx = new Array<number>(length).fill(0);
  let trSmooth = 0;
  let plusSmooth = 0;
  let minusSmooth = 0;
  for (let i = 1; i <= period && i < length; i += 1) {
    trSmooth += trueRange[i]!;
    plusSmooth += plusDm[i]!;
    minusSmooth += minusDm[i]!;
  }
  for (let i = period; i < length; i += 1) {
    if (i > period) {
      trSmooth = trSmooth - trSmooth / period + trueRange[i]!;
      plusSmooth = plusSmooth - plusSmooth / period + plusDm[i]!;
      minusSmooth = minusSmooth - minusSmooth / period + minusDm[i]!;
    }
    if (trSmooth <= 0) continue;
    plusDi[i] = 100 * plusSmooth / trSmooth;
    minusDi[i] = 100 * minusSmooth / trSmooth;
    const denominator = plusDi[i]! + minusDi[i]!;
    dx[i] = denominator > 0
      ? 100 * Math.abs(plusDi[i]! - minusDi[i]!) / denominator
      : 0;
  }

  const adx = new Array<number>(length).fill(0);
  const firstAdx = 2 * period - 1;
  if (firstAdx < length) {
    let dxSum = 0;
    for (let i = period; i <= firstAdx; i += 1) dxSum += dx[i]!;
    adx[firstAdx] = dxSum / period;
    for (let i = firstAdx + 1; i < length; i += 1) {
      adx[i] = (adx[i - 1]! * (period - 1) + dx[i]!) / period;
    }
  }
  return { plusDi, minusDi, adx };
}

/** Standard close-confirmed Supertrend direction: +1 bull, -1 bear. */
function supertrendDirection(
  candles: Candle[],
  period: number,
  multiplier: number,
): number[] {
  const atrValues = atr(candles, period);
  const direction = new Array<number>(candles.length).fill(1);
  const upper = new Array<number>(candles.length).fill(0);
  const lower = new Array<number>(candles.length).fill(0);
  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i]!;
    const midpoint = (bar.h + bar.l) / 2;
    const basicUpper = midpoint + multiplier * atrValues[i]!;
    const basicLower = midpoint - multiplier * atrValues[i]!;
    if (i === 0) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      direction[i] = bar.c >= midpoint ? 1 : -1;
      continue;
    }
    const prior = candles[i - 1]!;
    upper[i] = basicUpper < upper[i - 1]! || prior.c > upper[i - 1]!
      ? basicUpper
      : upper[i - 1]!;
    lower[i] = basicLower > lower[i - 1]! || prior.c < lower[i - 1]!
      ? basicLower
      : lower[i - 1]!;
    direction[i] = direction[i - 1] === 1
      ? (bar.c < lower[i]! ? -1 : 1)
      : (bar.c > upper[i]! ? 1 : -1);
  }
  return direction;
}

function build(c: Candle[], funding: LighterFundingSeries | undefined): Arrays {
  const close = c.map((bar) => bar.c);
  const volume = c.map((bar) => bar.v);
  const ema8Values = ema(close, 8);
  const ema21Values = ema(close, 21);
  const ema12Values = ema(close, 12);
  const ema26Values = ema(close, 26);
  const macd = ema12Values.map((value, i) => value - ema26Values[i]!);
  const stoch14 = stochastic(c, 14);
  const vw60 = rollingVolumeWeighted(c, 60);
  const sma20Values = sma(close, 20);
  const sd20Values = rollingStd(close, 20);
  const atr14Values = atr(c, 14);
  const dmi14 = directionalIndex(c, 14);
  const waveTrend10x21 = waveTrend(c, 10, 21, 4);
  const fisher10 = fisherTransform(c, 10);
  const aroon25 = aroon(c, 25);
  const rsi14Values = rsi(c, 14);
  const stochasticRsi14 = stochasticRsi(rsi14Values, 14, 3, 3);
  const tsi25x13 = trueStrengthIndex(close, 25, 13, 7);
  const vortex14 = vortexIndicator(c, 14);
  const relativeVigor10 = relativeVigorIndex(c, 10, 4);
  const trix15 = trix(close, 15, 9);
  const completedBars = c.map((bar) => ({
    close: bar.c,
    high: bar.h,
    low: bar.l,
    volume: bar.v,
  }));
  const pvt12x26 = priceVolumeTrendOscillator(completedBars, 12, 26, 9);
  const stochasticMomentum14x3x3 = stochasticMomentumIndex(c, 14, 3, 3, 3);
  const atrPctMean288 = sma(
    atr14Values.map((value, i) => close[i]! > 0 ? value / close[i]! : 0),
    288,
  );
  return {
    c,
    close,
    ema200: ema(close, 200),
    ema300: ema(close, 300),
    ema400: ema(close, 400),
    ema500: ema(close, 500),
    ema5: ema(close, 5),
    ema8: ema8Values,
    ema13: ema(close, 13),
    ema21: ema21Values,
    ema34: ema(close, 34),
    ema55: ema(close, 55),
    macd,
    macdSignal: ema(macd, 9),
    sma20: sma20Values,
    sma60: sma(close, 60),
    volumeSma20: sma(volume, 20),
    volumeSma60: sma(volume, 60),
    sd20: sd20Values,
    sd60: rollingStd(close, 60),
    means: new Map(Z_PERIODS.map((period) => [period, sma(close, period)])),
    deviations: new Map(Z_PERIODS.map((period) => [period, rollingStd(close, period)])),
    atr14: atr14Values,
    plusDi14: dmi14.plusDi,
    minusDi14: dmi14.minusDi,
    adx14: dmi14.adx,
    supertrend10x3: supertrendDirection(c, 10, 3),
    atrPctMean288,
    rsi2: rsi(c, 2),
    rsi7: rsi(c, 7),
    rsi14: rsi14Values,
    stoch14,
    stoch14Signal: sma(stoch14, 3),
    cci20: cci(c, 20),
    mfi14: moneyFlowIndex(c, 14),
    williams14: williamsR(c, 14),
    waveTrend10x21: waveTrend10x21.oscillator,
    waveTrendSignal4: waveTrend10x21.signal,
    fisher10: fisher10.fisher,
    fisherSignal: fisher10.signal,
    chaikinMoneyFlow20: chaikinMoneyFlow(c, 20),
    aroonUp25: aroon25.up,
    aroonDown25: aroon25.down,
    stochasticRsi14K3: stochasticRsi14.k,
    stochasticRsi14D3: stochasticRsi14.d,
    trueStrengthIndex25x13: tsi25x13.tsi,
    trueStrengthSignal7: tsi25x13.signal,
    vortexPlus14: vortex14.plus,
    vortexMinus14: vortex14.minus,
    kama10: kaufmanAdaptiveMovingAverage(close, 10),
    kama30: kaufmanAdaptiveMovingAverage(close, 30),
    relativeVigor10: relativeVigor10.vigor,
    relativeVigorSignal4: relativeVigor10.signal,
    trix15: trix15.oscillator,
    trixSignal9: trix15.signal,
    ultimateOscillator7x14x28: ultimateOscillator(completedBars, 7, 14, 28),
    elderForceIndex13Z60: elderForceIndexZScore(completedBars, 13, 60),
    choppiness14: choppinessIndex(completedBars, 14),
    pvt12x26: pvt12x26.oscillator,
    pvtSignal9: pvt12x26.signal,
    deMarker14: deMarker(c, 14),
    stochasticMomentum14x3x3: stochasticMomentum14x3x3.oscillator,
    stochasticMomentumSignal3: stochasticMomentum14x3x3.signal,
    connorsRsi3x2x100: connorsRsi(close, 3, 2, 100),
    regressionResidualZ60x60: rollingRegressionResidualZScore(close, 60, 60),
    varianceRatio120x5: rollingVarianceRatio(close, 120, 5),
    vwap60: vw60.mean,
    vwapSd60: vw60.deviation,
    efficiencyRatio60: efficiencyRatio(close, 60),
    serialCorrelation120: completedLagOneReturnCorrelation(close, 120),
    fundingZ168: completedFundingZScore(
      c.map((bar) => bar.t),
      BAR_MINUTES,
      funding,
      168,
    ),
    // Standard TTM-style compression: 2-sigma Bollinger width is contained
    // inside a 1.5 ATR Keltner envelope. Every input is from the completed
    // candle at i; entry still executes only at the next candle open.
    squeeze20: close.map((_, i) =>
      i >= 20 && 2 * sd20Values[i]! <= 1.5 * atr14Values[i]!),
  };
}

function z(a: Arrays, i: number, period: number): number {
  const mean = a.means.get(period)?.[i] ?? 0;
  const sd = a.deviations.get(period)?.[i] ?? 0;
  return sd > 0 ? (a.close[i]! - mean) / sd : 0;
}

function meanFor(a: Arrays, i: number, period: number): number {
  return a.means.get(period)?.[i] ?? 0;
}

function highestBefore(c: Candle[], i: number, period: number): number {
  let high = -Infinity;
  for (let j = i - period; j < i; j++) high = Math.max(high, c[j]!.h);
  return high;
}

function lowestBefore(c: Candle[], i: number, period: number): number {
  let low = Infinity;
  for (let j = i - period; j < i; j++) low = Math.min(low, c[j]!.l);
  return low;
}

function rules(): Rule[] {
  const out: Rule[] = [];

  // Preregistered two-sided confluence suite. The four rules are deliberately
  // few and fixed before looking at their results: a price/RSI extreme must be
  // confirmed by an independent volume or range-position oscillator, while
  // EMA400 keeps the fade aligned with the long regime. This is opt-in so a
  // failed experiment cannot alter the established production library.
  if (ENABLE_OSCILLATOR_CONFLUENCE) {
    out.push({
      name: 'CONF-RSI14-MFI14-30/70+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        if (a.rsi14[i]! < 30 && a.mfi14[i]! < 30 && a.close[i]! > a.ema400[i]!) return 'long';
        if (a.rsi14[i]! > 70 && a.mfi14[i]! > 70 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.rsi14[i]! >= 50 : a.rsi14[i]! <= 50;
      },
    });
    out.push({
      name: 'CONF-RSI14-WILLR14-30/70+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        if (a.rsi14[i]! < 30 && a.williams14[i]! < -80 && a.close[i]! > a.ema400[i]!) return 'long';
        if (a.rsi14[i]! > 70 && a.williams14[i]! > -20 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.rsi14[i]! >= 50 : a.rsi14[i]! <= 50;
      },
    });
    out.push({
      name: 'CONF-VWZ60-2+RSI14-30/70+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const current = a.vwapSd60[i]! > 0
          ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
          : 0;
        if (current < -2 && a.rsi14[i]! < 30 && a.close[i]! > a.ema400[i]!) return 'long';
        if (current > 2 && a.rsi14[i]! > 70 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.close[i]! >= a.vwap60[i]! : a.close[i]! <= a.vwap60[i]!;
      },
    });
    out.push({
      name: 'CONF-VWZ60-2.5+MFI14-35/65+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const current = a.vwapSd60[i]! > 0
          ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
          : 0;
        if (current < -2.5 && a.mfi14[i]! < 35 && a.close[i]! > a.ema400[i]!) return 'long';
        if (current > 2.5 && a.mfi14[i]! > 65 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.close[i]! >= a.vwap60[i]! : a.close[i]! <= a.vwap60[i]!;
      },
    });
  }

  // Preregistered fast, mirrored oscillator suite. These are independent
  // combinations of price deviation, range position and volume pressure; the
  // exact parameters are frozen before running the universe sweep. The same
  // completed-bar rule is applied to every market and both timeframes.
  if (ENABLE_FAST_CONFLUENCE_FAMILIES) {
    out.push({
      name: 'CONF-VWZ60-2.5+WILLR14-20/80+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const current = a.vwapSd60[i]! > 0
          ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
          : 0;
        if (
          current < -2.5
          && a.williams14[i]! < -80
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          current > 2.5
          && a.williams14[i]! > -20
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.vwap60[i]!
          : a.close[i]! <= a.vwap60[i]!;
      },
    });
    out.push({
      name: 'CONF-RSI7-20/80+MFI14-35/65+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        if (
          a.rsi7[i]! < 20
          && a.mfi14[i]! < 35
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.rsi7[i]! > 80
          && a.mfi14[i]! > 65
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.rsi7[i]! >= 50 : a.rsi7[i]! <= 50;
      },
    });
  }

  // Second preregistered mirrored suite. Parameters are frozen before the
  // universe run: one range/volume-weighted setup and one volatility/flow
  // setup, each aligned with EMA400 and evaluated on completed bars only.
  if (ENABLE_FAST_CONFLUENCE_FAMILIES_V2) {
    out.push({
      name: 'CONF-VWZ60-2.25+STOCH14-20/80+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const current = a.vwapSd60[i]! > 0
          ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
          : 0;
        if (
          current < -2.25
          && a.stoch14[i]! < 20
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          current > 2.25
          && a.stoch14[i]! > 80
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.vwap60[i]!
          : a.close[i]! <= a.vwap60[i]!;
      },
    });
    out.push({
      name: 'CONF-BB20-2+MFI14-30/70+EMA400',
      warmup: 402,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const lower = a.sma20[i]! - 2 * a.sd20[i]!;
        const upper = a.sma20[i]! + 2 * a.sd20[i]!;
        if (
          a.close[i]! < lower
          && a.mfi14[i]! < 30
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.close[i]! > upper
          && a.mfi14[i]! > 70
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.sma20[i]!
          : a.close[i]! <= a.sma20[i]!;
      },
    });
  }

  // Preregistered independent v3 suite. These hypotheses intentionally use
  // different state variables from the selected VWZ/oscillator challengers:
  // (1) volatility-compression release with trend momentum, and (2) a CCI
  // pullback reclaim inside an established directional trend. Parameters are
  // frozen before the universe run, mirrored exactly for Long/Short, and use
  // completed bars with next-open execution in simulate().
  if (ENABLE_INDEPENDENT_FAMILIES_V3) {
    out.push({
      name: 'SQUEEZE20-RELEASE+STACK21/55/200+MACD-H120M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const released = a.squeeze20[i - 1] === true && a.squeeze20[i] === false;
        if (!released) return null;
        const longTrend = a.close[i]! > a.ema21[i]!
          && a.ema21[i]! > a.ema55[i]!
          && a.ema55[i]! > a.ema200[i]!
          && a.macd[i]! > a.macdSignal[i]!;
        const shortTrend = a.close[i]! < a.ema21[i]!
          && a.ema21[i]! < a.ema55[i]!
          && a.ema55[i]! < a.ema200[i]!
          && a.macd[i]! < a.macdSignal[i]!;
        if (longTrend) return 'long';
        if (shortTrend) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! < a.ema21[i]!
          : a.close[i]! > a.ema21[i]!;
      },
    });

    out.push({
      name: 'CCI20-RECLAIM100+EMA200/400+ADX18-DMI-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const longReclaim = a.cci20[i - 1]! < -100 && a.cci20[i]! >= -100;
        const shortReclaim = a.cci20[i - 1]! > 100 && a.cci20[i]! <= 100;
        if (
          longReclaim
          && a.close[i]! > a.ema200[i]!
          && a.ema200[i]! > a.ema400[i]!
          && a.adx14[i]! >= 18
          && a.plusDi14[i]! > a.minusDi14[i]!
        ) return 'long';
        if (
          shortReclaim
          && a.close[i]! < a.ema200[i]!
          && a.ema200[i]! < a.ema400[i]!
          && a.adx14[i]! >= 18
          && a.minusDi14[i]! > a.plusDi14[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.cci20[i]! >= 0 : a.cci20[i]! <= 0;
      },
    });
  }

  // Preregistered independent v4 suite. Both rules wait for a completed-bar
  // reclaim after an extreme rather than buying/selling the first touch. The
  // parameters are frozen before the universe run, mirrored exactly for both
  // sides and shared unchanged by every market and both timeframes.
  if (ENABLE_INDEPENDENT_FAMILIES_V4) {
    out.push({
      name: 'BB20-2-RECLAIM+WILLR14-80/20+EMA400-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorLower = a.sma20[i - 1]! - 2 * a.sd20[i - 1]!;
        const priorUpper = a.sma20[i - 1]! + 2 * a.sd20[i - 1]!;
        const lower = a.sma20[i]! - 2 * a.sd20[i]!;
        const upper = a.sma20[i]! + 2 * a.sd20[i]!;
        if (
          a.close[i - 1]! < priorLower
          && a.close[i]! >= lower
          && a.williams14[i]! < -80
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.close[i - 1]! > priorUpper
          && a.close[i]! <= upper
          && a.williams14[i]! > -20
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.sma20[i]!
          : a.close[i]! <= a.sma20[i]!;
      },
    });

    out.push({
      name: 'VWZ60-2.25-RECLAIM+RSI2-10/90+EMA400-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorZ = a.vwapSd60[i - 1]! > 0
          ? (a.close[i - 1]! - a.vwap60[i - 1]!) / a.vwapSd60[i - 1]!
          : 0;
        const currentZ = a.vwapSd60[i]! > 0
          ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
          : 0;
        if (
          priorZ < -2.25
          && currentZ >= -2.25
          && a.rsi2[i]! < 10
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          priorZ > 2.25
          && currentZ <= 2.25
          && a.rsi2[i]! > 90
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.vwap60[i]!
          : a.close[i]! <= a.vwap60[i]!;
      },
    });
  }

  // Preregistered independent v5 suite. The first family tests whether volume
  // pressure confirms a Bollinger reclaim; the second uses an ATR-normalised
  // Keltner reclaim with RSI confirmation. Both are frozen before evaluation,
  // exactly mirrored and execute only after the signal candle has completed.
  if (ENABLE_INDEPENDENT_FAMILIES_V5) {
    out.push({
      name: 'BB20-2-RECLAIM+MFI14-30/70+EMA400-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorLower = a.sma20[i - 1]! - 2 * a.sd20[i - 1]!;
        const priorUpper = a.sma20[i - 1]! + 2 * a.sd20[i - 1]!;
        const lower = a.sma20[i]! - 2 * a.sd20[i]!;
        const upper = a.sma20[i]! + 2 * a.sd20[i]!;
        if (
          a.close[i - 1]! < priorLower
          && a.close[i]! >= lower
          && a.mfi14[i]! < 30
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.close[i - 1]! > priorUpper
          && a.close[i]! <= upper
          && a.mfi14[i]! > 70
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.sma20[i]!
          : a.close[i]! <= a.sma20[i]!;
      },
    });

    out.push({
      name: 'KELTNER21-ATR2-RECLAIM+RSI14-35/65+EMA400-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorLower = a.ema21[i - 1]! - 2 * a.atr14[i - 1]!;
        const priorUpper = a.ema21[i - 1]! + 2 * a.atr14[i - 1]!;
        const lower = a.ema21[i]! - 2 * a.atr14[i]!;
        const upper = a.ema21[i]! + 2 * a.atr14[i]!;
        if (
          a.close[i - 1]! < priorLower
          && a.close[i]! >= lower
          && a.rsi14[i]! < 35
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.close[i - 1]! > priorUpper
          && a.close[i]! <= upper
          && a.rsi14[i]! > 65
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.ema21[i]!
          : a.close[i]! <= a.ema21[i]!;
      },
    });
  }

  // Preregistered independent v6 suite. These are canonical short-horizon
  // mean-reversion hypotheses: Connors-style RSI2 and Internal Bar Strength,
  // each traded only in the EMA200 regime and exited at EMA5. The same fixed,
  // mirrored rule is applied to every market and both timeframes.
  if (ENABLE_INDEPENDENT_FAMILIES_V6) {
    out.push({
      name: 'CONNORS-RSI2-10/90+EMA200-EXIT-EMA5-H120M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        if (a.rsi2[i]! < 10 && a.close[i]! > a.ema200[i]!) return 'long';
        if (a.rsi2[i]! > 90 && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.ema5[i]!
          : a.close[i]! <= a.ema5[i]!;
      },
    });

    out.push({
      name: 'IBS-10/90+EMA200-EXIT-EMA5-H120M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const range = a.c[i]!.h - a.c[i]!.l;
        if (!(range > 0)) return null;
        const ibs = (a.close[i]! - a.c[i]!.l) / range;
        if (ibs < 0.1 && a.close[i]! > a.ema200[i]!) return 'long';
        if (ibs > 0.9 && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.ema5[i]!
          : a.close[i]! <= a.ema5[i]!;
      },
    });
  }

  // Preregistered independent v7 suite. These rules deliberately avoid the
  // oscillator/Z-score families selected in earlier rounds. The first is a
  // canonical 20-bar false-breakout (Turtle Soup) with relative-volume and
  // EMA400 regime confirmation. The second looks for a completed one-bar
  // liquidation impulse that is reclaimed on the following completed bar.
  // Both are exactly mirrored, shared unchanged by every symbol/timeframe,
  // and execute only at the next bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V7) {
    out.push({
      name: 'V7-TURTLESOUP20+RVOL1.25+EMA400-EXIT-SMA20-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorLow = lowestBefore(a.c, i - 1, 20);
        const priorHigh = highestBefore(a.c, i - 1, 20);
        const sweptLow = a.c[i - 1]!.l < priorLow;
        const sweptHigh = a.c[i - 1]!.h > priorHigh;
        const relativeVolume = a.c[i - 1]!.v / Math.max(a.volumeSma20[i - 1]!, 1e-12);
        if (
          sweptLow
          && a.close[i]! >= priorLow
          && relativeVolume >= 1.25
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          sweptHigh
          && a.close[i]! <= priorHigh
          && relativeVolume >= 1.25
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.sma20[i]!
          : a.close[i]! <= a.sma20[i]!;
      },
    });

    out.push({
      name: 'V7-ABSORB-ATR1-RVOL1.5-MIDRECLAIM+EMA200-EXIT-EMA8-H60M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(60 / BAR_MINUTES)),
      entry(a, i) {
        const impulse = a.c[i - 1]!;
        const body = Math.abs(impulse.c - impulse.o);
        const midpoint = (impulse.o + impulse.c) / 2;
        const relativeVolume = impulse.v / Math.max(a.volumeSma20[i - 1]!, 1e-12);
        const impulseReady = body >= a.atr14[i - 1]! && relativeVolume >= 1.5;
        if (
          impulseReady
          && impulse.c < impulse.o
          && a.close[i]! > midpoint
          && a.close[i]! > a.ema200[i]!
        ) return 'long';
        if (
          impulseReady
          && impulse.c > impulse.o
          && a.close[i]! < midpoint
          && a.close[i]! < a.ema200[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.ema8[i]!
          : a.close[i]! <= a.ema8[i]!;
      },
    });
  }

  // Preregistered independent v8 suite. These hypotheses test whether an
  // explicit low-efficiency/choppy-regime condition can prevent the adverse
  // continuation that hurt earlier short-horizon reversion families. The
  // first uses a Bollinger reclaim plus Kaufman ER60; the second uses a
  // Keltner reclaim only while completed ADX14 is below 20. Both retain a
  // long-horizon EMA400 direction filter, are exactly mirrored, and execute
  // only on the next bar open. No parameter grid is exposed for post-hoc
  // rescue if either frozen rule fails.
  if (ENABLE_INDEPENDENT_FAMILIES_V8) {
    out.push({
      name: 'V8-BB20-2-RECLAIM+ER60<0.25+EMA400-EXIT-SMA20-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorLower = a.sma20[i - 1]! - 2 * a.sd20[i - 1]!;
        const priorUpper = a.sma20[i - 1]! + 2 * a.sd20[i - 1]!;
        const lower = a.sma20[i]! - 2 * a.sd20[i]!;
        const upper = a.sma20[i]! + 2 * a.sd20[i]!;
        if (
          a.efficiencyRatio60[i]! <= 0.25
          && a.close[i - 1]! < priorLower
          && a.close[i]! >= lower
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.efficiencyRatio60[i]! <= 0.25
          && a.close[i - 1]! > priorUpper
          && a.close[i]! <= upper
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.sma20[i]!
          : a.close[i]! <= a.sma20[i]!;
      },
    });

    out.push({
      name: 'V8-KELTNER21-ATR2-RECLAIM+ADX<20+EMA400-EXIT-EMA21-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorLower = a.ema21[i - 1]! - 2 * a.atr14[i - 1]!;
        const priorUpper = a.ema21[i - 1]! + 2 * a.atr14[i - 1]!;
        const lower = a.ema21[i]! - 2 * a.atr14[i]!;
        const upper = a.ema21[i]! + 2 * a.atr14[i]!;
        if (
          a.adx14[i]! < 20
          && a.close[i - 1]! < priorLower
          && a.close[i]! >= lower
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.adx14[i]! < 20
          && a.close[i - 1]! > priorUpper
          && a.close[i]! <= upper
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.ema21[i]!
          : a.close[i]! <= a.ema21[i]!;
      },
    });
  }

  // Preregistered independent v9 suite. WaveTrend and Fisher are nonlinear
  // cycle oscillators that have not appeared in the earlier Native Quant
  // families. Both rules are exactly mirrored, require an actual completed-
  // bar reversal from an extreme, align the fade with EMA400, and close at
  // oscillator neutrality. Parameters are deliberately fixed before the
  // universe run; this opt-in block exposes no grid for post-hoc rescue.
  if (ENABLE_INDEPENDENT_FAMILIES_V9) {
    out.push({
      name: 'V9-WAVETREND10/21-X4-EXT60+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.waveTrend10x21[i - 1]! <= a.waveTrendSignal4[i - 1]!
          && a.waveTrend10x21[i]! > a.waveTrendSignal4[i]!;
        const crossedDown = a.waveTrend10x21[i - 1]! >= a.waveTrendSignal4[i - 1]!
          && a.waveTrend10x21[i]! < a.waveTrendSignal4[i]!;
        if (
          crossedUp
          && a.waveTrend10x21[i - 1]! <= -60
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          crossedDown
          && a.waveTrend10x21[i - 1]! >= 60
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.waveTrend10x21[i]! >= 0
          : a.waveTrend10x21[i]! <= 0;
      },
    });

    out.push({
      name: 'V9-FISHER10-XTRIGGER-EXT1.5+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.fisher10[i - 1]! <= a.fisherSignal[i - 1]!
          && a.fisher10[i]! > a.fisherSignal[i]!;
        const crossedDown = a.fisher10[i - 1]! >= a.fisherSignal[i - 1]!
          && a.fisher10[i]! < a.fisherSignal[i]!;
        if (
          crossedUp
          && a.fisher10[i - 1]! <= -1.5
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          crossedDown
          && a.fisher10[i - 1]! >= 1.5
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.fisher10[i]! >= 0 : a.fisher10[i]! <= 0;
      },
    });
  }

  // Preregistered independent v10 suite. CMF tests a volume-weighted
  // accumulation/distribution reversal, while Aroon tests time-since-extreme
  // trend dominance. Neither family reuses price Z-scores or RSI thresholds.
  // Parameters and mirrored long/short rules are frozen before the universe
  // run and every signal still fills only at the next native bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V10) {
    out.push({
      name: 'V10-CMF20-RECLAIM-0.20+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.chaikinMoneyFlow20[i - 1]! <= -0.2
          && a.chaikinMoneyFlow20[i]! > -0.2;
        const crossedDown = a.chaikinMoneyFlow20[i - 1]! >= 0.2
          && a.chaikinMoneyFlow20[i]! < 0.2;
        if (crossedUp && a.close[i]! > a.ema400[i]!) return 'long';
        if (crossedDown && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.chaikinMoneyFlow20[i]! >= 0
          : a.chaikinMoneyFlow20[i]! <= 0;
      },
    });

    out.push({
      name: 'V10-AROON25-X-70+EMA400-REVERSE-H240M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.aroonUp25[i - 1]! <= a.aroonDown25[i - 1]!
          && a.aroonUp25[i]! > a.aroonDown25[i]!;
        const crossedDown = a.aroonDown25[i - 1]! <= a.aroonUp25[i - 1]!
          && a.aroonDown25[i]! > a.aroonUp25[i]!;
        if (crossedUp && a.aroonUp25[i]! >= 70 && a.close[i]! > a.ema400[i]!) {
          return 'long';
        }
        if (crossedDown && a.aroonDown25[i]! >= 70 && a.close[i]! < a.ema400[i]!) {
          return 'short';
        }
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.aroonDown25[i]! > a.aroonUp25[i]!
          : a.aroonUp25[i]! > a.aroonDown25[i]!;
      },
    });
  }

  // Preregistered independent v11 suite. Stochastic RSI tests a normalized
  // momentum reversal, while TSI tests double-smoothed directional momentum.
  // Both rules require a completed-bar signal-line cross after a mirrored
  // extreme, align with EMA400 and fill only at the next native bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V11) {
    out.push({
      name: 'V11-STOCHRSI14-3/3-X20/80+EMA400-EXIT50-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.stochasticRsi14K3[i - 1]! <= a.stochasticRsi14D3[i - 1]!
          && a.stochasticRsi14K3[i]! > a.stochasticRsi14D3[i]!;
        const crossedDown = a.stochasticRsi14K3[i - 1]! >= a.stochasticRsi14D3[i - 1]!
          && a.stochasticRsi14K3[i]! < a.stochasticRsi14D3[i]!;
        if (
          crossedUp
          && a.stochasticRsi14K3[i - 1]! <= 20
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          crossedDown
          && a.stochasticRsi14K3[i - 1]! >= 80
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.stochasticRsi14K3[i]! >= 50
          : a.stochasticRsi14K3[i]! <= 50;
      },
    });

    out.push({
      name: 'V11-TSI25/13-X7-EXT20+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.trueStrengthIndex25x13[i - 1]! <= a.trueStrengthSignal7[i - 1]!
          && a.trueStrengthIndex25x13[i]! > a.trueStrengthSignal7[i]!;
        const crossedDown = a.trueStrengthIndex25x13[i - 1]! >= a.trueStrengthSignal7[i - 1]!
          && a.trueStrengthIndex25x13[i]! < a.trueStrengthSignal7[i]!;
        if (
          crossedUp
          && a.trueStrengthIndex25x13[i - 1]! <= -20
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          crossedDown
          && a.trueStrengthIndex25x13[i - 1]! >= 20
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.trueStrengthIndex25x13[i]! >= 0
          : a.trueStrengthIndex25x13[i]! <= 0;
      },
    });
  }

  // Preregistered independent v12 suite. Vortex tests directional range
  // expansion confirmed by DMI trend strength, while dual KAMA tests an
  // adaptive trend crossover only when the completed path is efficient.
  // Rules are fixed, mirrored and shared by every symbol/timeframe; entries
  // fill at the next native bar open and never use the signal bar fill.
  if (ENABLE_INDEPENDENT_FAMILIES_V12) {
    out.push({
      name: 'V12-VORTEX14-X+ADX20+EMA200-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.vortexPlus14[i - 1]! <= a.vortexMinus14[i - 1]!
          && a.vortexPlus14[i]! > a.vortexMinus14[i]!;
        const crossedDown = a.vortexMinus14[i - 1]! <= a.vortexPlus14[i - 1]!
          && a.vortexMinus14[i]! > a.vortexPlus14[i]!;
        if (crossedUp && a.adx14[i]! >= 20 && a.close[i]! > a.ema200[i]!) return 'long';
        if (crossedDown && a.adx14[i]! >= 20 && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.vortexMinus14[i]! > a.vortexPlus14[i]!
          : a.vortexPlus14[i]! > a.vortexMinus14[i]!;
      },
    });

    out.push({
      name: 'V12-KAMA10/30-X+ER60>0.25+EMA200-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.kama10[i - 1]! <= a.kama30[i - 1]!
          && a.kama10[i]! > a.kama30[i]!;
        const crossedDown = a.kama10[i - 1]! >= a.kama30[i - 1]!
          && a.kama10[i]! < a.kama30[i]!;
        if (
          crossedUp
          && a.efficiencyRatio60[i]! > 0.25
          && a.close[i]! > a.ema200[i]!
        ) return 'long';
        if (
          crossedDown
          && a.efficiencyRatio60[i]! > 0.25
          && a.close[i]! < a.ema200[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.kama10[i]! < a.kama30[i]!
          : a.kama10[i]! > a.kama30[i]!;
      },
    });
  }

  // Preregistered independent v13 suite. RVI tests whether completed candles
  // are closing directionally inside their own ranges; TRIX tests a triple-
  // smoothed trend impulse. The two indicators do not reuse the Z/VWZ signal
  // that already runs in Shadow. Both rules are exactly mirrored, use one
  // canonical parameterisation on every market/timeframe, and fill only at
  // the next native bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V13) {
    out.push({
      name: 'V13-RVI10-X4+EMA200-EXIT-REVERSE-H120M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.relativeVigor10[i - 1]! <= a.relativeVigorSignal4[i - 1]!
          && a.relativeVigor10[i]! > a.relativeVigorSignal4[i]!;
        const crossedDown = a.relativeVigor10[i - 1]! >= a.relativeVigorSignal4[i - 1]!
          && a.relativeVigor10[i]! < a.relativeVigorSignal4[i]!;
        if (crossedUp && a.relativeVigor10[i]! > 0 && a.close[i]! > a.ema200[i]!) {
          return 'long';
        }
        if (crossedDown && a.relativeVigor10[i]! < 0 && a.close[i]! < a.ema200[i]!) {
          return 'short';
        }
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.relativeVigor10[i]! < a.relativeVigorSignal4[i]!
          : a.relativeVigor10[i]! > a.relativeVigorSignal4[i]!;
      },
    });

    out.push({
      name: 'V13-TRIX15-X9+EMA200-EXIT-REVERSE-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.trix15[i - 1]! <= a.trixSignal9[i - 1]!
          && a.trix15[i]! > a.trixSignal9[i]!;
        const crossedDown = a.trix15[i - 1]! >= a.trixSignal9[i - 1]!
          && a.trix15[i]! < a.trixSignal9[i]!;
        if (crossedUp && a.trix15[i]! > 0 && a.close[i]! > a.ema200[i]!) return 'long';
        if (crossedDown && a.trix15[i]! < 0 && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.trix15[i]! < a.trixSignal9[i]!
          : a.trix15[i]! > a.trixSignal9[i]!;
      },
    });
  }

  // Preregistered independent v14 suite. Ultimate Oscillator combines buying
  // pressure over three completed-bar horizons; Elder Force Index combines
  // completed close change with native Lighter volume. Both wait for an
  // extreme to reclaim its boundary, mirror Long/Short exactly, use the same
  // parameters on every market and timeframe, and fill only at next-bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V14) {
    out.push({
      name: 'V14-UO7/14/28-RECLAIM30/70+EMA400-EXIT50-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const prior = a.ultimateOscillator7x14x28[i - 1]!;
        const current = a.ultimateOscillator7x14x28[i]!;
        if (prior < 30 && current >= 30 && a.close[i]! > a.ema400[i]!) return 'long';
        if (prior > 70 && current <= 70 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.ultimateOscillator7x14x28[i]! >= 50
          : a.ultimateOscillator7x14x28[i]! <= 50;
      },
    });

    out.push({
      name: 'V14-EFI13-Z60-RECLAIM2+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const prior = a.elderForceIndex13Z60[i - 1]!;
        const current = a.elderForceIndex13Z60[i]!;
        if (prior < -2 && current >= -2 && a.close[i]! > a.ema400[i]!) return 'long';
        if (prior > 2 && current <= 2 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.elderForceIndex13Z60[i]! >= 0
          : a.elderForceIndex13Z60[i]! <= 0;
      },
    });
  }

  // Preregistered independent v15 suite. The first rule trades the transition
  // from compression into a completed-bar 20-bar range breakout, confirmed by
  // native relative volume. The second trades a price-volume-trend crossover.
  // Both are mirrored Long/Short, share fixed parameters across every market
  // and timeframe, and execute at the following native bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V15) {
    out.push({
      name: 'V15-CHOP14-X38-DONCHIAN20+RVOL1.25+EMA200-EXIT10-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const expansionStarted = a.choppiness14[i - 1]! >= 38.2
          && a.choppiness14[i]! < 38.2;
        const volumeOk = a.c[i]!.v >= a.volumeSma20[i]! * 1.25;
        if (!expansionStarted || !volumeOk) return null;
        if (
          a.close[i]! > highestBefore(a.c, i, 20)
          && a.close[i]! > a.ema200[i]!
        ) return 'long';
        if (
          a.close[i]! < lowestBefore(a.c, i, 20)
          && a.close[i]! < a.ema200[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! < lowestBefore(a.c, i, 10)
          : a.close[i]! > highestBefore(a.c, i, 10);
      },
    });

    out.push({
      name: 'V15-PVT12/26/9-X+EMA200+ADX18-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.pvt12x26[i - 1]! <= a.pvtSignal9[i - 1]!
          && a.pvt12x26[i]! > a.pvtSignal9[i]!;
        const crossedDown = a.pvt12x26[i - 1]! >= a.pvtSignal9[i - 1]!
          && a.pvt12x26[i]! < a.pvtSignal9[i]!;
        if (
          crossedUp
          && a.close[i]! > a.ema200[i]!
          && a.adx14[i]! >= 18
          && a.plusDi14[i]! > a.minusDi14[i]!
        ) return 'long';
        if (
          crossedDown
          && a.close[i]! < a.ema200[i]!
          && a.adx14[i]! >= 18
          && a.minusDi14[i]! > a.plusDi14[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.pvt12x26[i]! < a.pvtSignal9[i]!
          : a.pvt12x26[i]! > a.pvtSignal9[i]!;
      },
    });
  }

  // Preregistered independent v16 suite. Both rules test a completed-bar
  // reversal from an intrabar-range extreme while staying on the EMA400 side
  // of the long regime. DeMarker uses high/low pressure; SMI uses a double-
  // smoothed close location inside the rolling range. Parameters are frozen
  // across every market and both timeframes, with next-bar-open execution.
  if (ENABLE_INDEPENDENT_FAMILIES_V16) {
    out.push({
      name: 'V16-DEMARKER14-RECLAIM0.20/0.80+EMA400-EXIT0.50-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const prior = a.deMarker14[i - 1]!;
        const current = a.deMarker14[i]!;
        if (prior < 0.2 && current >= 0.2 && a.close[i]! > a.ema400[i]!) return 'long';
        if (prior > 0.8 && current <= 0.8 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.deMarker14[i]! >= 0.5 : a.deMarker14[i]! <= 0.5;
      },
    });

    out.push({
      name: 'V16-SMI14/3/3-X3-EXT40+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const crossedUp = a.stochasticMomentum14x3x3[i - 1]!
            <= a.stochasticMomentumSignal3[i - 1]!
          && a.stochasticMomentum14x3x3[i]! > a.stochasticMomentumSignal3[i]!;
        const crossedDown = a.stochasticMomentum14x3x3[i - 1]!
            >= a.stochasticMomentumSignal3[i - 1]!
          && a.stochasticMomentum14x3x3[i]! < a.stochasticMomentumSignal3[i]!;
        if (
          crossedUp
          && a.stochasticMomentum14x3x3[i - 1]! <= -40
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          crossedDown
          && a.stochasticMomentum14x3x3[i - 1]! >= 40
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.stochasticMomentum14x3x3[i]! >= 0
          : a.stochasticMomentum14x3x3[i]! <= 0;
      },
    });
  }

  // Preregistered independent v17 suite. Full Connors RSI combines close
  // momentum, signed streak and a 100-bar return percentile; the regression
  // family measures a completed close against its causal 60-bar least-squares
  // trend and the historical scale of that residual. Both rules are exactly
  // mirrored, share one frozen parameter set across symbols/timeframes, trade
  // only with EMA400 and execute at the next bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V17) {
    out.push({
      name: 'V17-CRSI3/2/100-RECLAIM10/90+EMA400-EXIT50-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const prior = a.connorsRsi3x2x100[i - 1]!;
        const current = a.connorsRsi3x2x100[i]!;
        if (prior < 10 && current >= 10 && a.close[i]! > a.ema400[i]!) return 'long';
        if (prior > 90 && current <= 90 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.connorsRsi3x2x100[i]! >= 50
          : a.connorsRsi3x2x100[i]! <= 50;
      },
    });

    out.push({
      name: 'V17-REGRES60-RESIDZ60-TOUCH2.5+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const residualZ = a.regressionResidualZ60x60[i]!;
        if (residualZ <= -2.5 && a.close[i]! > a.ema400[i]!) return 'long';
        if (residualZ >= 2.5 && a.close[i]! < a.ema400[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.regressionResidualZ60x60[i]! >= 0
          : a.regressionResidualZ60x60[i]! <= 0;
      },
    });
  }

  // Preregistered independent v18 suite. Both hypotheses use the same causal
  // variance-ratio regime classifier but express opposite, predeclared edges:
  // reversion after an extreme only in anti-persistent paths, and range
  // breakout only in persistent paths. Rules are mirrored, fixed across all
  // markets/timeframes and execute at the next native bar open.
  if (ENABLE_INDEPENDENT_FAMILIES_V18) {
    out.push({
      name: 'V18-VR120K5<0.85-Z60-2.5-RECLAIM+EMA400-EXIT0-H120M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(120 / BAR_MINUTES)),
      entry(a, i) {
        const priorZ = z(a, i - 1, 60);
        const currentZ = z(a, i, 60);
        if (
          a.varianceRatio120x5[i]! < 0.85
          && priorZ < -2.5
          && currentZ >= -2.5
          && a.close[i]! > a.ema400[i]!
        ) return 'long';
        if (
          a.varianceRatio120x5[i]! < 0.85
          && priorZ > 2.5
          && currentZ <= 2.5
          && a.close[i]! < a.ema400[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? z(a, i, 60) >= 0 : z(a, i, 60) <= 0;
      },
    });

    out.push({
      name: 'V18-VR120K5>1.15-DONCHIAN20+EMA200-EXIT10-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        if (
          a.varianceRatio120x5[i]! > 1.15
          && a.close[i]! > highestBefore(a.c, i, 20)
          && a.close[i]! > a.ema200[i]!
        ) return 'long';
        if (
          a.varianceRatio120x5[i]! > 1.15
          && a.close[i]! < lowestBefore(a.c, i, 20)
          && a.close[i]! < a.ema200[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! < lowestBefore(a.c, i, 10)
          : a.close[i]! > highestBefore(a.c, i, 10);
      },
    });
  }

  // Preregistered two-sided volatility/oscillator pullback. The completed
  // candle must close beyond Bollinger(20,2), RSI14 must confirm the extreme,
  // and the long-horizon EMA400 trend must still point in the trade direction.
  // One canonical rule is shared by every market and both 1m/5m timeframes;
  // there is deliberately no parameter grid to rescue a failed hypothesis.
  if (ENABLE_BOLLINGER_RSI_CONFLUENCE) {
    out.push({
      name: 'CONF-BB20-2+RSI14-30/70+EMA400-H240M',
      warmup: 402,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const lower = a.sma20[i]! - 2 * a.sd20[i]!;
        const upper = a.sma20[i]! + 2 * a.sd20[i]!;
        if (a.close[i]! < lower && a.rsi14[i]! < 30 && a.close[i]! > a.ema400[i]!) {
          return 'long';
        }
        if (a.close[i]! > upper && a.rsi14[i]! > 70 && a.close[i]! < a.ema400[i]!) {
          return 'short';
        }
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.close[i]! >= a.sma20[i]! : a.close[i]! <= a.sma20[i]!;
      },
    });
  }

  // Preregistered two-sided trend-continuation hypothesis. A fully stacked
  // EMA8/21/55/200 trend must already exist, ADX14 must confirm a directional
  // regime, and RSI14 must reclaim the neutral pullback level from the adverse
  // side. The exact mirror is used for shorts. One canonical rule is applied
  // unchanged to all markets and both 1m/5m datasets.
  if (ENABLE_TREND_MOMENTUM_RECLAIM) {
    out.push({
      name: 'TREND-STACK8/21/55/200+ADX20+RSI45/55-RECLAIM-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars: Math.max(1, Math.round(240 / BAR_MINUTES)),
      entry(a, i) {
        const longTrend = a.ema8[i]! > a.ema21[i]!
          && a.ema21[i]! > a.ema55[i]!
          && a.ema55[i]! > a.ema200[i]!;
        const shortTrend = a.ema8[i]! < a.ema21[i]!
          && a.ema21[i]! < a.ema55[i]!
          && a.ema55[i]! < a.ema200[i]!;
        const longReclaim = a.rsi14[i - 1]! < 45 && a.rsi14[i]! >= 45;
        const shortReclaim = a.rsi14[i - 1]! > 55 && a.rsi14[i]! <= 55;
        if (longTrend && longReclaim && a.adx14[i]! >= 20) return 'long';
        if (shortTrend && shortReclaim && a.adx14[i]! >= 20) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.ema8[i]! < a.ema21[i]!
          : a.ema8[i]! > a.ema21[i]!;
      },
    });
  }

  // Preregistered, mirrored trend/volatility suite. Parameters are fixed
  // before inspecting results and shared unchanged by every market and both
  // timeframes. Signals use only the just-completed candle and execute on the
  // next candle, so neither family can see its own fill candle.
  if (ENABLE_TREND_VOLATILITY_FAMILIES) {
    const maxBars = Math.max(1, Math.round(240 / BAR_MINUTES));
    out.push({
      name: 'TREND-KELTNER20-ATR1.5-RECLAIM+EMA200+ADX20-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars,
      entry(a, i) {
        const priorLower = a.ema21[i - 1]! - 1.5 * a.atr14[i - 1]!;
        const priorUpper = a.ema21[i - 1]! + 1.5 * a.atr14[i - 1]!;
        const lower = a.ema21[i]! - 1.5 * a.atr14[i]!;
        const upper = a.ema21[i]! + 1.5 * a.atr14[i]!;
        const longTrend = a.ema21[i]! > a.ema200[i]!;
        const shortTrend = a.ema21[i]! < a.ema200[i]!;
        if (
          longTrend
          && a.adx14[i]! >= 20
          && a.close[i - 1]! < priorLower
          && a.close[i]! >= lower
        ) return 'long';
        if (
          shortTrend
          && a.adx14[i]! >= 20
          && a.close[i - 1]! > priorUpper
          && a.close[i]! <= upper
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! >= a.ema21[i]!
          : a.close[i]! <= a.ema21[i]!;
      },
    });
    out.push({
      name: 'TREND-DONCHIAN20-BREAKOUT+EMA200+ADX25-H240M',
      warmup: 202,
      slPct: 0.01,
      maxBars,
      entry(a, i) {
        const priorHigh = highestBefore(a.c, i, 20);
        const priorLow = lowestBefore(a.c, i, 20);
        if (
          a.close[i]! > priorHigh
          && a.close[i]! > a.ema200[i]!
          && a.adx14[i]! >= 25
        ) return 'long';
        if (
          a.close[i]! < priorLow
          && a.close[i]! < a.ema200[i]!
          && a.adx14[i]! >= 25
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.close[i]! < a.ema21[i]!
          : a.close[i]! > a.ema21[i]!;
      },
    });
  }

  // Post-selection stability check around the frozen confluence discoveries.
  // This grid is diagnostic only: the centre cells remain the strategies under
  // consideration and neighbouring cells cannot replace them after the fact.
  if (ENABLE_CONFLUENCE_ROBUSTNESS) {
    const trendAverages = [
      [300, (a: Arrays) => a.ema300],
      [400, (a: Arrays) => a.ema400],
      [500, (a: Arrays) => a.ema500],
    ] as const;
    for (const level of [25, 30, 35] as const) {
      for (const williamsEdge of [15, 20, 25] as const) {
        for (const [trend, average] of trendAverages) {
          out.push({
            name: `ROB-RSIW-R${level}-W${williamsEdge}+EMA${trend}`,
            warmup: trend + 2,
            slPct: 0.01,
            maxBars: 120,
            entry(a, i) {
              const trendAverage = average(a);
              if (
                a.rsi14[i]! < level
                && a.williams14[i]! < -100 + williamsEdge
                && a.close[i]! > trendAverage[i]!
              ) return 'long';
              if (
                a.rsi14[i]! > 100 - level
                && a.williams14[i]! > -williamsEdge
                && a.close[i]! < trendAverage[i]!
              ) return 'short';
              return null;
            },
            exit(a, i, side) {
              return side === 'long' ? a.rsi14[i]! >= 50 : a.rsi14[i]! <= 50;
            },
          });
        }
      }
    }
    for (const threshold of [2.25, 2.5, 2.75] as const) {
      for (const mfiLevel of [30, 35, 40] as const) {
        for (const [trend, average] of trendAverages) {
          out.push({
            name: `ROB-VWZMFI-Z${threshold}-M${mfiLevel}+EMA${trend}`,
            warmup: trend + 2,
            slPct: 0.01,
            maxBars: 120,
            entry(a, i) {
              const current = a.vwapSd60[i]! > 0
                ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
                : 0;
              const trendAverage = average(a);
              if (
                current < -threshold
                && a.mfi14[i]! < mfiLevel
                && a.close[i]! > trendAverage[i]!
              ) return 'long';
              if (
                current > threshold
                && a.mfi14[i]! > 100 - mfiLevel
                && a.close[i]! < trendAverage[i]!
              ) return 'short';
              return null;
            },
            exit(a, i, side) {
              return side === 'long'
                ? a.close[i]! >= a.vwap60[i]!
                : a.close[i]! <= a.vwap60[i]!;
            },
          });
        }
      }
    }
  }

  // Preregistered independent trend-following suite. Both rules are canonical,
  // mirrored across Long/Short and share one four-hour time stop at every
  // timeframe. They are opt-in so a rejected result cannot silently change the
  // established research library or be rescued with a post-hoc parameter grid.
  if (ENABLE_DIRECTIONAL_TREND) {
    const maxBars = Math.max(1, Math.round(240 / BAR_MINUTES));
    out.push({
      name: 'DMI14-X25-T200-H240',
      warmup: 202,
      slPct: 0.01,
      maxBars,
      entry(a, i) {
        const crossUp = a.plusDi14[i - 1]! <= a.minusDi14[i - 1]!
          && a.plusDi14[i]! > a.minusDi14[i]!;
        const crossDown = a.minusDi14[i - 1]! <= a.plusDi14[i - 1]!
          && a.minusDi14[i]! > a.plusDi14[i]!;
        if (crossUp && a.adx14[i]! >= 25 && a.close[i]! > a.ema200[i]!) return 'long';
        if (crossDown && a.adx14[i]! >= 25 && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.minusDi14[i]! > a.plusDi14[i]!
          : a.plusDi14[i]! > a.minusDi14[i]!;
      },
    });
    out.push({
      name: 'SUPERTREND10-3-T200-H240',
      warmup: 202,
      slPct: 0.01,
      maxBars,
      entry(a, i) {
        const flipUp = a.supertrend10x3[i - 1]! < 0 && a.supertrend10x3[i]! > 0;
        const flipDown = a.supertrend10x3[i - 1]! > 0 && a.supertrend10x3[i]! < 0;
        if (flipUp && a.close[i]! > a.ema200[i]!) return 'long';
        if (flipDown && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long'
          ? a.supertrend10x3[i]! < 0
          : a.supertrend10x3[i]! > 0;
      },
    });
  }
  for (const [period, os, ob] of [[2, 5, 95], [2, 10, 90], [7, 20, 80], [14, 25, 75]] as const) {
    for (const trend of [0, 400] as const) {
      const key = period === 2 ? 'rsi2' : period === 7 ? 'rsi7' : 'rsi14';
      out.push({
        name: `RSI${period}-${os}/${ob}${trend ? '+EMA400' : ''}`,
        warmup: Math.max(30, trend + 1),
        slPct: 0.01,
        maxBars: 120,
        entry(a, i) {
          const value = a[key][i]!;
          const longOk = trend === 0 || a.close[i]! > a.ema400[i]!;
          const shortOk = trend === 0 || a.close[i]! < a.ema400[i]!;
          if (value < os && longOk) return 'long';
          if (value > ob && shortOk) return 'short';
          return null;
        },
        exit(a, i, side) {
          const value = a[key][i]!;
          return side === 'long' ? value >= 50 : value <= 50;
        },
      });
    }
  }

  // Frozen neighbourhood around the two-sided RSI14/EMA400 discovery rule.
  // This family is opt-in so the normal research library remains unchanged.
  // A candidate is only credible when nearby RSI levels and trend horizons
  // retain the effect; an isolated profitable cell is treated as overfit.
  if (ENABLE_RSI_PULLBACK_ROBUSTNESS) {
    const trendAverages = [
      [300, (a: Arrays) => a.ema300],
      [400, (a: Arrays) => a.ema400],
      [500, (a: Arrays) => a.ema500],
    ] as const;
    for (const level of [20, 25, 30] as const) {
      for (const [trend, average] of trendAverages) {
        if (level === 25 && trend === 400) continue;
        out.push({
          name: `RSI14-${level}/${100 - level}+EMA${trend}`,
          warmup: trend + 2,
          slPct: 0.01,
          maxBars: 120,
          entry(a, i) {
            const trendAverage = average(a);
            if (a.rsi14[i]! < level && a.close[i]! > trendAverage[i]!) return 'long';
            if (a.rsi14[i]! > 100 - level && a.close[i]! < trendAverage[i]!) return 'short';
            return null;
          },
          exit(a, i, side) {
            return side === 'long' ? a.rsi14[i]! >= 50 : a.rsi14[i]! <= 50;
          },
        });
      }
    }
  }

  for (const trend of [0, 400] as const) {
    out.push({
      name: `STOCH14/3-20/80${trend ? '+EMA400' : ''}`,
      warmup: Math.max(30, trend + 1),
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const crossUp = a.stoch14[i - 1]! <= a.stoch14Signal[i - 1]!
          && a.stoch14[i]! > a.stoch14Signal[i]!;
        const crossDown = a.stoch14[i - 1]! >= a.stoch14Signal[i - 1]!
          && a.stoch14[i]! < a.stoch14Signal[i]!;
        const longOk = trend === 0 || a.close[i]! > a.ema400[i]!;
        const shortOk = trend === 0 || a.close[i]! < a.ema400[i]!;
        if (crossUp && a.stoch14[i]! < 20 && longOk) return 'long';
        if (crossDown && a.stoch14[i]! > 80 && shortOk) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.stoch14[i]! >= 50 : a.stoch14[i]! <= 50;
      },
    });

    out.push({
      name: `CCI20-reclaim-100${trend ? '+EMA400' : ''}`,
      warmup: Math.max(30, trend + 1),
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const longOk = trend === 0 || a.close[i]! > a.ema400[i]!;
        const shortOk = trend === 0 || a.close[i]! < a.ema400[i]!;
        if (a.cci20[i - 1]! < -100 && a.cci20[i]! >= -100 && longOk) return 'long';
        if (a.cci20[i - 1]! > 100 && a.cci20[i]! <= 100 && shortOk) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.cci20[i]! >= 0 : a.cci20[i]! <= 0;
      },
    });

    out.push({
      name: `MFI14-20/80${trend ? '+EMA400' : ''}`,
      warmup: Math.max(30, trend + 1),
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const longOk = trend === 0 || a.close[i]! > a.ema400[i]!;
        const shortOk = trend === 0 || a.close[i]! < a.ema400[i]!;
        if (a.mfi14[i]! < 20 && longOk) return 'long';
        if (a.mfi14[i]! > 80 && shortOk) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.mfi14[i]! >= 50 : a.mfi14[i]! <= 50;
      },
    });

    out.push({
      name: `WILLR14-reclaim-10/90${trend ? '+EMA400' : ''}`,
      warmup: Math.max(30, trend + 1),
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const longOk = trend === 0 || a.close[i]! > a.ema400[i]!;
        const shortOk = trend === 0 || a.close[i]! < a.ema400[i]!;
        if (a.williams14[i - 1]! < -90 && a.williams14[i]! >= -90 && longOk) return 'long';
        if (a.williams14[i - 1]! > -10 && a.williams14[i]! <= -10 && shortOk) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.williams14[i]! >= -50 : a.williams14[i]! <= -50;
      },
    });
  }

  for (const trend of [200, 400] as const) {
    const trendLabel = trend === 200 ? 'T200' : 'T400';
    out.push({
      name: `RSI14-reclaim-30/70+${trendLabel}`,
      warmup: trend + 2,
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const trendAverage = trend === 200 ? a.ema200 : a.ema400;
        const crossUp = a.rsi14[i - 1]! < 30 && a.rsi14[i]! >= 30;
        const crossDown = a.rsi14[i - 1]! > 70 && a.rsi14[i]! <= 70;
        if (crossUp && a.close[i]! > trendAverage[i]!) return 'long';
        if (crossDown && a.close[i]! < trendAverage[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.rsi14[i]! >= 55 : a.rsi14[i]! <= 45;
      },
    });
  }

  // Classic two-sided trend pullback: EMA21/55/200 must be fully stacked in
  // the trade direction, while RSI2 identifies a short counter-trend shock.
  // The small threshold/mode grid is frozen and shared by every market.
  for (const threshold of ENABLE_TREND_PULLBACK ? [5, 10] : []) {
    for (const mode of ['touch', 'reclaim'] as const) {
      out.push({
        name: `RSI2PB-${threshold}-${mode}+STACK21/55/200`,
        warmup: 202,
        slPct: 0.01,
        maxBars: 60,
        entry(a, i) {
          const longTrend = a.ema21[i]! > a.ema55[i]!
            && a.ema55[i]! > a.ema200[i]!;
          const shortTrend = a.ema21[i]! < a.ema55[i]!
            && a.ema55[i]! < a.ema200[i]!;
          const longSignal = mode === 'touch'
            ? a.rsi2[i]! < threshold
            : a.rsi2[i - 1]! < threshold && a.rsi2[i]! >= threshold;
          const shortSignal = mode === 'touch'
            ? a.rsi2[i]! > 100 - threshold
            : a.rsi2[i - 1]! > 100 - threshold && a.rsi2[i]! <= 100 - threshold;
          if (longTrend && longSignal) return 'long';
          if (shortTrend && shortSignal) return 'short';
          return null;
        },
        exit(a, i, side) {
          return side === 'long' ? a.rsi2[i]! >= 50 : a.rsi2[i]! <= 50;
        },
      });
    }
  }

  for (const multiplier of [2, 2.5]) {
    for (const mode of ['reclaim', 'breakout'] as const) {
      out.push({
        name: `BB20-${multiplier}-${mode}+T200`,
        warmup: 202,
        slPct: 0.01,
        maxBars: 180,
        entry(a, i) {
          const priorLower = a.sma20[i - 1]! - multiplier * a.sd20[i - 1]!;
          const priorUpper = a.sma20[i - 1]! + multiplier * a.sd20[i - 1]!;
          const lower = a.sma20[i]! - multiplier * a.sd20[i]!;
          const upper = a.sma20[i]! + multiplier * a.sd20[i]!;
          if (mode === 'reclaim') {
            if (
              a.close[i - 1]! < priorLower
              && a.close[i]! >= lower
              && a.close[i]! > a.ema200[i]!
            ) return 'long';
            if (
              a.close[i - 1]! > priorUpper
              && a.close[i]! <= upper
              && a.close[i]! < a.ema200[i]!
            ) return 'short';
          } else {
            if (
              a.close[i - 1]! <= priorUpper
              && a.close[i]! > upper
              && a.close[i]! > a.ema200[i]!
            ) return 'long';
            if (
              a.close[i - 1]! >= priorLower
              && a.close[i]! < lower
              && a.close[i]! < a.ema200[i]!
            ) return 'short';
          }
          return null;
        },
        exit(a, i, side) {
          if (mode === 'reclaim') {
            return side === 'long' ? a.close[i]! >= a.sma20[i]! : a.close[i]! <= a.sma20[i]!;
          }
          return side === 'long' ? a.close[i]! < a.ema21[i]! : a.close[i]! > a.ema21[i]!;
        },
      });
    }
  }

  for (const threshold of VWZ_THRESHOLDS) {
    for (const mode of ['touch', 'reclaim'] as const) {
      out.push({
        name: `VWZ60-${threshold}-${mode}`,
        warmup: 62,
        slPct: Z_SL_PCT,
        maxBars: Z_MAX_HOLD_BARS,
        entry(a, i) {
          const current = a.vwapSd60[i]! > 0
            ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
            : 0;
          const prior = a.vwapSd60[i - 1]! > 0
            ? (a.close[i - 1]! - a.vwap60[i - 1]!) / a.vwapSd60[i - 1]!
            : 0;
          if (mode === 'touch') {
            if (current < -threshold) return 'long';
            if (current > threshold) return 'short';
          } else {
            if (prior < -threshold && current >= -threshold) return 'long';
            if (prior > threshold && current <= threshold) return 'short';
          }
          return null;
        },
        exit(a, i, side) {
          return side === 'long'
            ? a.close[i]! >= a.vwap60[i]!
            : a.close[i]! <= a.vwap60[i]!;
        },
      });
    }
  }

  // Two-sided pullback-in-trend variants. These retain the statistically
  // extreme Z/VWZ entry and mean exit, but only buy above EMA200 and sell
  // below EMA200. The filter is symmetric and identical for every market.
  for (const threshold of [2.5, 3]) {
    for (const mode of ['touch', 'reclaim'] as const) {
      out.push({
        name: `VWZ60T-${threshold}-${mode}`,
        warmup: 202,
        slPct: Z_SL_PCT,
        maxBars: Z_MAX_HOLD_BARS,
        entry(a, i) {
          const current = a.vwapSd60[i]! > 0
            ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
            : 0;
          const prior = a.vwapSd60[i - 1]! > 0
            ? (a.close[i - 1]! - a.vwap60[i - 1]!) / a.vwapSd60[i - 1]!
            : 0;
          const longSignal = mode === 'touch'
            ? current < -threshold
            : prior < -threshold && current >= -threshold;
          const shortSignal = mode === 'touch'
            ? current > threshold
            : prior > threshold && current <= threshold;
          if (longSignal && a.close[i]! > a.ema200[i]!) return 'long';
          if (shortSignal && a.close[i]! < a.ema200[i]!) return 'short';
          return null;
        },
        exit(a, i, side) {
          return side === 'long'
            ? a.close[i]! >= a.vwap60[i]!
            : a.close[i]! <= a.vwap60[i]!;
        },
      });

      out.push({
        name: `Z60T-${threshold}-${mode}`,
        warmup: 202,
        slPct: Z_SL_PCT,
        maxBars: Z_MAX_HOLD_BARS,
        entry(a, i) {
          const current = z(a, i, 60);
          const prior = z(a, i - 1, 60);
          const longSignal = mode === 'touch'
            ? current < -threshold
            : prior < -threshold && current >= -threshold;
          const shortSignal = mode === 'touch'
            ? current > threshold
            : prior > threshold && current <= threshold;
          if (longSignal && a.close[i]! > a.ema200[i]!) return 'long';
          if (shortSignal && a.close[i]! < a.ema200[i]!) return 'short';
          return null;
        },
        exit(a, i, side) {
          const mean = meanFor(a, i, 60);
          return side === 'long' ? a.close[i]! >= mean : a.close[i]! <= mean;
        },
      });
    }
  }

  // Preregistered P2 challenger derived from the P1 regime audit. It keeps
  // the exact P1 threshold, stop, hold and mean exit; the only change is a
  // symmetric EMA200/EMA400 stack. There is deliberately no parameter grid:
  // long requires bull alignment and short requires bear alignment.
  out.push({
    name: 'Z60STACK-2.5-touch',
    warmup: 402,
    slPct: Z_SL_PCT,
    maxBars: Z_MAX_HOLD_BARS,
    entry(a, i) {
      const current = z(a, i, 60);
      if (
        current < -2.5
        && a.close[i]! > a.ema200[i]!
        && a.ema200[i]! > a.ema400[i]!
      ) return 'long';
      if (
        current > 2.5
        && a.close[i]! < a.ema200[i]!
        && a.ema200[i]! < a.ema400[i]!
      ) return 'short';
      return null;
    },
    exit(a, i, side) {
      const mean = meanFor(a, i, 60);
      return side === 'long' ? a.close[i]! >= mean : a.close[i]! <= mean;
    },
  });

  // Preregistered independent liquidity-sweep / failed-breakout family.
  // The completed signal candle must penetrate the PRIOR 20-bar Donchian
  // boundary by at least 0.25 ATR, close back inside the old range in the
  // reversal direction, and carry at least its trailing 20-bar mean volume.
  // Entry is still next-bar open in simulate(). One exact, symmetric rule is
  // shared by every market and both 1m/5m tests; there is no parameter grid.
  if (ENABLE_FAILED_BREAKOUT) out.push({
    name: 'FBR20-A0.25-V1-SMA20',
    warmup: 30,
    slPct: 0.015,
    maxBars: Math.max(1, Math.round(60 / BAR_MINUTES)),
    entry(a, i) {
      const bar = a.c[i]!;
      const priorHigh = highestBefore(a.c, i, 20);
      const priorLow = lowestBefore(a.c, i, 20);
      const penetration = 0.25 * a.atr14[i]!;
      const volumeOk = bar.v >= a.volumeSma20[i]!;
      if (!volumeOk) return null;
      if (
        bar.l <= priorLow - penetration
        && bar.c > priorLow
        && bar.c > bar.o
      ) return 'long';
      if (
        bar.h >= priorHigh + penetration
        && bar.c < priorHigh
        && bar.c < bar.o
      ) return 'short';
      return null;
    },
    exit(a, i, side) {
      return side === 'long'
        ? a.close[i]! >= a.sma20[i]!
        : a.close[i]! <= a.sma20[i]!;
    },
  });

  // Preregistered hour-boundary overreaction fade. Only the first completed
  // candle of each UTC hour can signal. A body of at least one ATR14 with
  // trailing-mean-or-better volume is faded at the next open and held for a
  // fixed 30 minutes. The exact mirrored rule is shared by every market and
  // both tested timeframes; no time-zone, threshold, or symbol grid exists.
  if (ENABLE_HOURLY_FADE) out.push({
    name: 'HOURFADE-A1-V1-H30',
    warmup: 30,
    slPct: 0.015,
    maxBars: Math.max(1, Math.round(30 / BAR_MINUTES)),
    entry(a, i) {
      const bar = a.c[i]!;
      const minute = new Date(bar.t).getUTCMinutes();
      if (minute !== 0) return null;
      const body = Math.abs(bar.c - bar.o);
      if (body < a.atr14[i]! || bar.v < a.volumeSma20[i]!) return null;
      if (bar.c > bar.o) return 'short';
      if (bar.c < bar.o) return 'long';
      return null;
    },
    exit() {
      return false;
    },
  });

  // This follow-up was frozen only after the unfiltered discovery portfolio
  // showed a positive high-volatility segment. It may therefore qualify only
  // on markets excluded from that discovery set. High volatility is defined
  // causally as current ATR14/close above its trailing 288-bar mean; all other
  // hour-fade mechanics remain unchanged.
  if (ENABLE_HOURLY_FADE_HIGHVOL) out.push({
    name: 'HOURFADE-A1-V1-H30+HV288',
    warmup: 290,
    slPct: 0.015,
    maxBars: Math.max(1, Math.round(30 / BAR_MINUTES)),
    entry(a, i) {
      const bar = a.c[i]!;
      if (new Date(bar.t).getUTCMinutes() !== 0) return null;
      const atrPct = bar.c > 0 ? a.atr14[i]! / bar.c : 0;
      if (atrPct <= a.atrPctMean288[i]!) return null;
      const body = Math.abs(bar.c - bar.o);
      if (body < a.atr14[i]! || bar.v < a.volumeSma20[i]!) return null;
      if (bar.c > bar.o) return 'short';
      if (bar.c < bar.o) return 'long';
      return null;
    },
    exit() {
      return false;
    },
  });

  // Preregistered adaptive serial-dependence family. The correlation at i
  // uses returns only through i-1; the completed candle at i supplies the
  // symmetric impulse/fade direction and execution remains at i+1 open.
  if (ENABLE_SERIAL_ADAPTIVE) out.push({
    name: 'SERIAL120-A0.15-B0.5-V1-H15',
    warmup: 122,
    slPct: 0.01,
    maxBars: Math.max(1, Math.round(15 / BAR_MINUTES)),
    entry(a, i) {
      const bar = a.c[i]!;
      return serialAdaptiveSide({
        correlation: a.serialCorrelation120[i]!,
        open: bar.o,
        close: bar.c,
        atr: a.atr14[i]!,
        volume: bar.v,
        volumeMean: a.volumeSma20[i]!,
      });
    },
    exit() {
      return false;
    },
  });

  // Preregistered funding-crowding fade. The latest completed hourly
  // settlement is compared with the preceding 168 settlements, excluding
  // itself from normalization. Price and funding must be extended in the same
  // direction; the trade fades both and executes only at the next bar open.
  if (ENABLE_FUNDING_CROWDING) out.push({
    name: 'FUNDZ168-PZ60-2-H360',
    warmup: 62,
    slPct: 0.015,
    maxBars: Math.max(1, Math.round(360 / BAR_MINUTES)),
    entry(a, i) {
      const priceZ = a.sd60[i]! > 0
        ? (a.close[i]! - a.sma60[i]!) / a.sd60[i]!
        : Number.NaN;
      return fundingCrowdingSide(a.fundingZ168[i]!, priceZ, 2);
    },
    exit(a, i, side) {
      const fundingNormalized = side === 'long'
        ? a.fundingZ168[i]! >= 0
        : a.fundingZ168[i]! <= 0;
      const priceNormalized = side === 'long'
        ? a.close[i]! >= a.sma60[i]!
        : a.close[i]! <= a.sma60[i]!;
      return fundingNormalized || priceNormalized;
    },
  });

  // Preregistered symmetric one-minute shock reversal. A completed candle
  // must move by a fixed multiple of the completed ATR14 and trade at least a
  // fixed multiple of its trailing volume mean. The position fades that move
  // at the next bar open, exits on a completed EMA5 mean reversion, or at the
  // frozen time limit. The intentionally small grid is for discovery across
  // markets; any selected rule must then survive a separate holdout universe.
  if (ENABLE_SHOCK_REVERSAL) {
    for (const bodyAtr of [1.5, 2, 2.5]) {
      for (const volumeRatio of [1, 1.5]) {
        for (const holdMinutes of [15, 30]) {
          out.push({
            name: `SHOCKREV-A${bodyAtr}-V${volumeRatio}-E5-H${holdMinutes}`,
            warmup: 22,
            slPct: 0.01,
            maxBars: Math.max(1, Math.round(holdMinutes / BAR_MINUTES)),
            entry(a, i) {
              const bar = a.c[i]!;
              const normalizedBody = a.atr14[i]! > 0
                ? (bar.c - bar.o) / a.atr14[i]!
                : 0;
              const relativeVolume = a.volumeSma20[i]! > 0
                ? bar.v / a.volumeSma20[i]!
                : 0;
              if (relativeVolume < volumeRatio) return null;
              if (normalizedBody >= bodyAtr) return 'short';
              if (normalizedBody <= -bodyAtr) return 'long';
              return null;
            },
            exit(a, i, side) {
              return side === 'long'
                ? a.close[i]! >= a.ema5[i]!
                : a.close[i]! <= a.ema5[i]!;
            },
          });
        }
      }
    }
  }

  // A predeclared two-sided mean-reversion variant for choppy regimes.
  // Kaufman ER prevents fading a statistically extreme move when the recent
  // path is strongly directional. The small fixed grid is evaluated across
  // every market and must still pass the same OOS/recent/direction gates.
  for (const threshold of [2.5, 3]) {
    for (const efficiencyMax of [0.25, 0.35]) {
      out.push({
        name: `VWZ60-${threshold}-touch+ER60<${efficiencyMax}`,
        warmup: 62,
        slPct: Z_SL_PCT,
        maxBars: Z_MAX_HOLD_BARS,
        entry(a, i) {
          if (a.efficiencyRatio60[i]! > efficiencyMax) return null;
          const current = a.vwapSd60[i]! > 0
            ? (a.close[i]! - a.vwap60[i]!) / a.vwapSd60[i]!
            : 0;
          if (current < -threshold) return 'long';
          if (current > threshold) return 'short';
          return null;
        },
        exit(a, i, side) {
          return side === 'long'
            ? a.close[i]! >= a.vwap60[i]!
            : a.close[i]! <= a.vwap60[i]!;
        },
      });
    }
  }

  for (const period of Z_PERIODS) for (const threshold of Z_THRESHOLDS) {
    for (const mode of ['touch', 'reclaim'] as const) {
      out.push({
        name: `Z${period}-${threshold}-${mode}`,
        warmup: period + 2,
        slPct: Z_SL_PCT,
        maxBars: Z_MAX_HOLD_BARS,
        entry(a, i) {
          const current = z(a, i, period);
          const prior = z(a, i - 1, period);
          if (mode === 'touch') {
            if (current < -threshold) return 'long';
            if (current > threshold) return 'short';
          } else {
            if (prior < -threshold && current >= -threshold) return 'long';
            if (prior > threshold && current <= threshold) return 'short';
          }
          return null;
        },
        exit(a, i, side) {
          const current = a.close[i]!;
          const mean = meanFor(a, i, period);
          return side === 'long' ? current >= mean : current <= mean;
        },
      });
    }
  }

  for (const multiplier of [1.5, 2, 2.5, 3]) {
    out.push({
      name: `Keltner20-${multiplier}-reclaim`,
      warmup: 30,
      slPct: 0.015,
      maxBars: 240,
      entry(a, i) {
        const priorLower = a.sma20[i - 1]! - multiplier * a.atr14[i - 1]!;
        const priorUpper = a.sma20[i - 1]! + multiplier * a.atr14[i - 1]!;
        const lower = a.sma20[i]! - multiplier * a.atr14[i]!;
        const upper = a.sma20[i]! + multiplier * a.atr14[i]!;
        if (a.close[i - 1]! < priorLower && a.close[i]! >= lower) return 'long';
        if (a.close[i - 1]! > priorUpper && a.close[i]! <= upper) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.close[i]! >= a.sma20[i]! : a.close[i]! <= a.sma20[i]!;
      },
    });

    out.push({
      name: `Keltner20-${multiplier}-breakout+T200`,
      warmup: 202,
      slPct: 0.01,
      maxBars: 180,
      entry(a, i) {
        const priorLower = a.sma20[i - 1]! - multiplier * a.atr14[i - 1]!;
        const priorUpper = a.sma20[i - 1]! + multiplier * a.atr14[i - 1]!;
        const lower = a.sma20[i]! - multiplier * a.atr14[i]!;
        const upper = a.sma20[i]! + multiplier * a.atr14[i]!;
        if (
          a.close[i - 1]! <= priorUpper
          && a.close[i]! > upper
          && a.close[i]! > a.ema200[i]!
        ) return 'long';
        if (
          a.close[i - 1]! >= priorLower
          && a.close[i]! < lower
          && a.close[i]! < a.ema200[i]!
        ) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.close[i]! < a.ema21[i]! : a.close[i]! > a.ema21[i]!;
      },
    });
  }

  for (const period of [20, 60, 120]) {
    out.push({
      name: `Donchian${period}-breakout`,
      warmup: period + 2,
      slPct: 0.01,
      maxBars: 240,
      entry(a, i) {
        if (a.close[i]! > highestBefore(a.c, i, period) && a.close[i]! > a.ema200[i]!) return 'long';
        if (a.close[i]! < lowestBefore(a.c, i, period) && a.close[i]! < a.ema200[i]!) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.close[i]! < a.ema200[i]! : a.close[i]! > a.ema200[i]!;
      },
    });
  }

  const emaKey = (period: 5 | 8 | 13 | 21 | 34 | 55): 'ema5' | 'ema8' | 'ema13' | 'ema21' | 'ema34' | 'ema55' =>
    `ema${period}` as 'ema5' | 'ema8' | 'ema13' | 'ema21' | 'ema34' | 'ema55';
  for (const [fast, slow] of [[5, 13], [8, 21], [13, 34], [21, 55]] as const) {
    for (const trend of [0, 200] as const) {
      for (const maxBars of [30, 90]) {
        const fastKey = emaKey(fast);
        const slowKey = emaKey(slow);
        out.push({
          name: `EMA${fast}/${slow}${trend ? '+T200' : ''}-H${maxBars}`,
          warmup: Math.max(slow + 2, trend + 1),
          slPct: 0.01,
          maxBars,
          entry(a, i) {
            const crossUp = a[fastKey][i - 1]! <= a[slowKey][i - 1]! && a[fastKey][i]! > a[slowKey][i]!;
            const crossDown = a[fastKey][i - 1]! >= a[slowKey][i - 1]! && a[fastKey][i]! < a[slowKey][i]!;
            if (crossUp && (!trend || a.close[i]! > a.ema200[i]!)) return 'long';
            if (crossDown && (!trend || a.close[i]! < a.ema200[i]!)) return 'short';
            return null;
          },
          exit(a, i, side) {
            return side === 'long'
              ? a[fastKey][i]! < a[slowKey][i]!
              : a[fastKey][i]! > a[slowKey][i]!;
          },
        });
      }
    }
  }

  for (const trend of [0, 200] as const) {
    out.push({
      name: `MACD12/26/9${trend ? '+T200' : ''}`,
      warmup: Math.max(40, trend + 1),
      slPct: 0.01,
      maxBars: 120,
      entry(a, i) {
        const crossUp = a.macd[i - 1]! <= a.macdSignal[i - 1]! && a.macd[i]! > a.macdSignal[i]!;
        const crossDown = a.macd[i - 1]! >= a.macdSignal[i - 1]! && a.macd[i]! < a.macdSignal[i]!;
        if (crossUp && (!trend || a.close[i]! > a.ema200[i]!)) return 'long';
        if (crossDown && (!trend || a.close[i]! < a.ema200[i]!)) return 'short';
        return null;
      },
      exit(a, i, side) {
        return side === 'long' ? a.macd[i]! < a.macdSignal[i]! : a.macd[i]! > a.macdSignal[i]!;
      },
    });
  }

  for (const period of [5, 10, 20, 40]) {
    for (const volumeRatio of [0, 1, 1.5, 2]) {
      for (const exitEma of [8, 21] as const) {
        const exitKey = emaKey(exitEma);
        out.push({
          name: `BO${period}-V${volumeRatio}-E${exitEma}`,
          warmup: Math.max(30, period + 2),
          slPct: 0.01,
          maxBars: 90,
          entry(a, i) {
            const volumeOk = volumeRatio === 0 || a.c[i]!.v >= a.volumeSma20[i]! * volumeRatio;
            if (!volumeOk) return null;
            if (a.close[i]! > highestBefore(a.c, i, period) && a.close[i]! > a.ema200[i]!) return 'long';
            if (a.close[i]! < lowestBefore(a.c, i, period) && a.close[i]! < a.ema200[i]!) return 'short';
            return null;
          },
          exit(a, i, side) {
            return side === 'long' ? a.close[i]! < a[exitKey][i]! : a.close[i]! > a[exitKey][i]!;
          },
        });
      }
    }
  }

  // Two-sided volatility-compression breakout. This is deliberately a small,
  // frozen grid rather than a market-specific optimization: a squeeze must
  // have existed recently, be released on the signal candle, and price must
  // close through the prior range in the EMA200 direction. Execution occurs
  // at the next open in simulate().
  for (const squeezeLookback of ENABLE_SQUEEZE ? [5, 10] : []) {
    for (const volumeRatio of [0, 1.25]) {
      for (const exitEma of [8, 21] as const) {
        const exitKey = emaKey(exitEma);
        out.push({
          name: `SQZ20-L${squeezeLookback}-V${volumeRatio}-E${exitEma}`,
          warmup: 202,
          slPct: 0.01,
          maxBars: 90,
          entry(a, i) {
            if (a.squeeze20[i]!) return null;
            let recentSqueeze = false;
            for (let j = Math.max(20, i - squeezeLookback); j < i; j++) {
              if (a.squeeze20[j]!) {
                recentSqueeze = true;
                break;
              }
            }
            if (!recentSqueeze) return null;
            const volumeOk = volumeRatio === 0
              || a.c[i]!.v >= a.volumeSma20[i]! * volumeRatio;
            if (!volumeOk) return null;
            if (
              a.close[i]! > highestBefore(a.c, i, 20)
              && a.close[i]! > a.ema200[i]!
            ) return 'long';
            if (
              a.close[i]! < lowestBefore(a.c, i, 20)
              && a.close[i]! < a.ema200[i]!
            ) return 'short';
            return null;
          },
          exit(a, i, side) {
            return side === 'long'
              ? a.close[i]! < a[exitKey][i]!
              : a.close[i]! > a[exitKey][i]!;
          },
        });
      }
    }
  }

  for (const bodyAtr of [0.75, 1, 1.5, 2]) {
    for (const volumeRatio of [0, 1, 1.5, 2]) {
      for (const maxBars of [5, 15, 30]) {
        out.push({
          name: `IMP-A${bodyAtr}-V${volumeRatio}-H${maxBars}`,
          warmup: 201,
          slPct: 0.01,
          maxBars,
          entry(a, i) {
            const bar = a.c[i]!;
            const body = Math.abs(bar.c - bar.o);
            const volumeOk = volumeRatio === 0 || bar.v >= a.volumeSma20[i]! * volumeRatio;
            if (!volumeOk || body < bodyAtr * a.atr14[i]!) return null;
            if (bar.c > bar.o && bar.c > a.ema200[i]!) return 'long';
            if (bar.c < bar.o && bar.c < a.ema200[i]!) return 'short';
            return null;
          },
          exit() {
            return false;
          },
        });
      }
    }
  }
  return out;
}

function simulate(rule: Rule, a: Arrays): Trade[] {
  const trades: Trade[] = [];
  let pendingEntry: Side | null = null;
  let pendingExit = false;
  let position: { side: Side; entry: number; entryAt: number; entryIdx: number } | null = null;

  const closePosition = (bar: Candle, price: number): void => {
    if (!position) return;
    const sign = position.side === 'long' ? 1 : -1;
    trades.push({
      side: position.side,
      entryAt: position.entryAt,
      exitAt: bar.t,
      entryIdx: position.entryIdx,
      pct: sign * (price - position.entry) / position.entry * 100,
    });
    position = null;
    pendingExit = false;
  };

  for (let i = rule.warmup; i < a.c.length; i++) {
    const bar = a.c[i]!;

    if (pendingExit && position) closePosition(bar, bar.o);
    if (pendingEntry && !position) {
      position = { side: pendingEntry, entry: bar.o, entryAt: bar.t, entryIdx: i };
      pendingEntry = null;
    }

    if (position) {
      const stop = position.side === 'long'
        ? position.entry * (1 - rule.slPct)
        : position.entry * (1 + rule.slPct);
      const stopped = position.side === 'long' ? bar.l <= stop : bar.h >= stop;
      if (stopped) {
        closePosition(bar, stop);
        continue;
      }
      if (i - position.entryIdx >= rule.maxBars || rule.exit(a, i, position.side)) pendingExit = true;
      continue;
    }

    if (i + 1 < a.c.length) pendingEntry = rule.entry(a, i);
  }

  if (position && a.c.length) closePosition(a.c[a.c.length - 1]!, a.c[a.c.length - 1]!.c);
  return trades;
}

function tradeNet(trade: Trade, executionCostPct?: number): number {
  if (executionCostPct == null) return trade.pct;
  return trade.pct - executionCostPct + (trade.fundingPct ?? 0);
}

function sum(trades: Trade[], executionCostPct?: number): number {
  return trades.reduce((acc, trade) => acc + tradeNet(trade, executionCostPct), 0);
}

function pf(trades: Trade[], executionCostPct?: number): number {
  let gains = 0;
  let losses = 0;
  for (const trade of trades) {
    const pnl = tradeNet(trade, executionCostPct);
    if (pnl >= 0) gains += pnl;
    else losses -= pnl;
  }
  return losses === 0 ? (gains > 0 ? 99 : 0) : gains / losses;
}

function positiveFolds(trades: Trade[], stress = 0): number {
  if (trades.length < 16) return -1;
  const size = Math.floor(trades.length / 4);
  let positive = 0;
  for (let fold = 0; fold < 4; fold++) {
    const slice = trades.slice(fold * size, fold === 3 ? undefined : (fold + 1) * size);
    if (sum(slice, stress) > 0) positive++;
  }
  return positive;
}

function fmt(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function drawdown(trades: Trade[], stress = 0): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const trade of trades) {
    equity += tradeNet(trade, stress);
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function meanL95(trades: Trade[], stress: number): number {
  if (trades.length < 2) return Number.NEGATIVE_INFINITY;
  const values = trades.map((trade) => tradeNet(trade, stress));
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0)
    / (values.length - 1);
  return mean - 1.645 * Math.sqrt(variance / values.length);
}

function recentStats(trades: Trade[], stress: number): WindowStats[] {
  const latest = trades.at(-1)?.exitAt ?? 0;
  return RECENT_WINDOWS_DAYS.map((days) => {
    const cutoff = latest - days * 86_400_000;
    const recent = trades.filter((trade) => trade.entryAt >= cutoff);
    return {
      days,
      n: recent.length,
      net: sum(recent, stress),
      profitFactor: pf(recent, stress),
      winRatePct: recent.length
        ? recent.filter((trade) => tradeNet(trade, stress) > 0).length / recent.length * 100
        : 0,
      long: sum(recent.filter((trade) => trade.side === 'long'), stress),
      short: sum(recent.filter((trade) => trade.side === 'short'), stress),
    };
  });
}

const loaded = new Map<string, Arrays>();
const candleSourceBySymbol = new Map<string, 'direct' | 'aggregated_from_1m'>();
for (const symbol of SYMBOLS) {
  const directFile = resolve(KLINES_DIR, `${symbol}-${BAR_MINUTES}m.json`);
  const oneMinuteFile = resolve(KLINES_DIR, `${symbol}-1m.json`);
  // Native 5m opens can diverge materially from the executable 1m path on
  // some Lighter markets. Prefer the native 1m series and aggregate it for
  // every higher timeframe; use a direct file only when no 1m source exists.
  const file = existsSync(oneMinuteFile) ? oneMinuteFile : directFile;
  if (!existsSync(file)) continue;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Candle[];
  const maxTime = raw.at(-1)?.t ?? 0;
  const windowed = LOOKBACK_DAYS > 0
    ? raw.filter((candle) => candle.t >= maxTime - LOOKBACK_DAYS * 86_400_000)
    : raw;
  const candles = file === oneMinuteFile
    ? aggregateCandles(windowed, BAR_MINUTES)
    : windowed;
  loaded.set(symbol, build(candles, fundingBySymbol.get(symbol.toUpperCase())));
  candleSourceBySymbol.set(symbol, file === directFile ? 'direct' : 'aggregated_from_1m');
}

const rows: Array<{
  symbol: string;
  rule: string;
  costPct: number;
  adverseCostPct: number;
  trades: ClassifiedTrade[];
  baseline: number;
  stress: number;
  stressPf: number;
  robustStress: number;
  robustPf: number;
  folds: number;
  is: number;
  oos: number;
  long: number;
  short: number;
  recent: WindowStats[];
  coverageDays: number;
  meanL95: number;
  trendRegimes: TrendRegimeStats;
  volatilityRegimes: VolatilityRegimeStats;
}> = [];
const portfolioGroups = new Map<string, PortfolioTrade[]>();

function classifyRegimes(
  arrays: Arrays,
  entryIdx: number,
): { trendRegime: TrendRegime; volatilityRegime: VolatilityRegime } {
  // The trade enters at entryIdx open, so only entryIdx-1 and earlier are
  // available. Regime labels are diagnostic and cannot influence the signal.
  const index = Math.max(0, entryIdx - 1);
  const close = arrays.close[index]!;
  const trendRegime: TrendRegime = close > arrays.ema200[index]!
    && arrays.ema200[index]! > arrays.ema400[index]!
    ? 'bull'
    : close < arrays.ema200[index]! && arrays.ema200[index]! < arrays.ema400[index]!
      ? 'bear'
      : 'mixed';
  const start = Math.max(0, index - 287);
  let atrPctTotal = 0;
  for (let cursor = start; cursor <= index; cursor += 1) {
    atrPctTotal += arrays.atr14[cursor]! / arrays.close[cursor]!;
  }
  const atrPctAverage = atrPctTotal / (index - start + 1);
  const currentAtrPct = arrays.atr14[index]! / close;
  return {
    trendRegime,
    volatilityRegime: currentAtrPct > atrPctAverage ? 'highVol' : 'lowVol',
  };
}

type RegimeStat = { n: number; net: number; profitFactor: number };
type TrendRegimeStats = Record<TrendRegime, RegimeStat>;
type VolatilityRegimeStats = Record<VolatilityRegime, RegimeStat>;

function standaloneRegimeStat(trades: ClassifiedTrade[], costPct: number): RegimeStat {
  return {
    n: trades.length,
    net: sum(trades, costPct),
    profitFactor: pf(trades, costPct),
  };
}

function standaloneTrendRegimes(
  trades: ClassifiedTrade[],
  costPct: number,
): TrendRegimeStats {
  return {
    bull: standaloneRegimeStat(
      trades.filter((trade) => trade.trendRegime === 'bull'), costPct,
    ),
    bear: standaloneRegimeStat(
      trades.filter((trade) => trade.trendRegime === 'bear'), costPct,
    ),
    mixed: standaloneRegimeStat(
      trades.filter((trade) => trade.trendRegime === 'mixed'), costPct,
    ),
  };
}

function standaloneVolatilityRegimes(
  trades: ClassifiedTrade[],
  costPct: number,
): VolatilityRegimeStats {
  return {
    highVol: standaloneRegimeStat(
      trades.filter((trade) => trade.volatilityRegime === 'highVol'), costPct,
    ),
    lowVol: standaloneRegimeStat(
      trades.filter((trade) => trade.volatilityRegime === 'lowVol'), costPct,
    ),
  };
}

for (const [symbol, arrays] of loaded) {
  const coverageDays = Math.max(
    0,
    ((arrays.c.at(-1)?.t ?? 0) - (arrays.c[0]?.t ?? 0)) / 86_400_000,
  );
  const measuredCost = executionCost(symbol);
  const costPct = measuredCost.p95Pct;
  const adverseCostPct = measuredCost.adversePct;
  const measuredFunding = fundingSeries(symbol, arrays.c);
  for (const rule of rules()) {
    if (RULE_FILTER && !rule.name.includes(RULE_FILTER)) continue;
    const trades = simulate(rule, arrays).map((trade) => ({
      ...trade,
      fundingPct: tradeFundingPct(measuredFunding, trade),
    }));
    const classifiedTrades: ClassifiedTrade[] = trades.map((trade) => ({
      ...trade,
      ...classifyRegimes(arrays, trade.entryIdx),
    }));
    if (coverageDays >= PORTFOLIO_MIN_COVERAGE_DAYS) {
      const group = portfolioGroups.get(rule.name) ?? [];
      group.push(...trades.map((trade) => ({
        ...trade,
        symbol,
        costPct,
        adverseCostPct,
        ...classifyRegimes(arrays, trade.entryIdx),
      })));
      portfolioGroups.set(rule.name, group);
    }
    if (trades.length < 20) continue;
    const cut = Math.floor(trades.length * 0.7);
    rows.push({
      symbol,
      rule: rule.name,
      costPct,
      adverseCostPct,
      trades: classifiedTrades,
      baseline: sum(trades),
      stress: sum(trades, costPct),
      stressPf: pf(trades, costPct),
      robustStress: sum(trades, adverseCostPct),
      robustPf: pf(trades, adverseCostPct),
      folds: positiveFolds(trades, costPct),
      is: sum(trades.slice(0, cut), costPct),
      oos: sum(trades.slice(cut), costPct),
      long: sum(trades.filter((trade) => trade.side === 'long'), costPct),
      short: sum(trades.filter((trade) => trade.side === 'short'), costPct),
      recent: recentStats(trades, costPct),
      coverageDays,
      meanL95: meanL95(trades, costPct),
      trendRegimes: standaloneTrendRegimes(classifiedTrades, costPct),
      volatilityRegimes: standaloneVolatilityRegimes(classifiedTrades, costPct),
    });
  }
}

const requiredCoverageDays = Math.max(0, ...RECENT_WINDOWS_DAYS);
const qualificationInputsMeasured =
  !usedFallbackExecutionCost && !usedFallbackFunding;
const qualified = rows
  .filter((row) => qualificationInputsMeasured
    && row.trades.length >= 30
    && row.coverageDays >= requiredCoverageDays * 0.95
    && row.stress > 0
    && row.meanL95 > 0
    && row.stressPf >= 1.2
    && row.folds >= 3
    && row.is > 0
    && row.oos > 0
    && row.long > 0
    && row.short > 0
    && row.trendRegimes.bull.n >= 20
    && row.trendRegimes.bull.net > 0
    && row.trendRegimes.bull.profitFactor >= 1.1
    && row.trendRegimes.bear.n >= 20
    && row.trendRegimes.bear.net > 0
    && row.trendRegimes.bear.profitFactor >= 1.1
    && (row.trendRegimes.mixed.n < 20
      || (row.trendRegimes.mixed.net > 0
        && row.trendRegimes.mixed.profitFactor >= 1.1))
    && row.volatilityRegimes.highVol.n >= 20
    && row.volatilityRegimes.highVol.net > 0
    && row.volatilityRegimes.highVol.profitFactor >= 1.1
    && row.volatilityRegimes.lowVol.n >= 20
    && row.volatilityRegimes.lowVol.net > 0
    && row.volatilityRegimes.lowVol.profitFactor >= 1.1
    && drawdown(row.trades, row.costPct) >= -MAX_BACKTEST_DD_PCT
    && row.recent.every((window) =>
      window.n >= 20
      && window.net > 0
      && window.profitFactor >= 1.1
      && window.long > 0
      && window.short > 0))
  .sort((a, b) => b.stress - a.stress);
const best = [...rows].sort((a, b) => b.stress - a.stress);

function applyPositionCap(
  source: PortfolioTrade[],
  maxOpen: number,
): { accepted: PortfolioTrade[]; dropped: number; maxConcurrent: number } {
  const ordered = [...source].sort((a, b) =>
    a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol));
  const accepted: PortfolioTrade[] = [];
  let openExitTimes: number[] = [];
  let dropped = 0;
  let maxConcurrent = 0;
  for (const trade of ordered) {
    openExitTimes = openExitTimes.filter((exitAt) => exitAt > trade.entryAt);
    if (openExitTimes.length >= maxOpen) {
      dropped++;
      continue;
    }
    accepted.push(trade);
    openExitTimes.push(trade.exitAt);
    maxConcurrent = Math.max(maxConcurrent, openExitTimes.length);
  }
  return { accepted, dropped, maxConcurrent };
}

function portfolioTradeNet(trade: PortfolioTrade, adverse = false): number {
  return tradeNet(trade, adverse ? trade.adverseCostPct : trade.costPct);
}

function portfolioSum(trades: PortfolioTrade[], adverse = false): number {
  return trades.reduce(
    (total, trade) => total + portfolioTradeNet(trade, adverse),
    0,
  );
}

function portfolioPf(trades: PortfolioTrade[], adverse = false): number {
  let gains = 0;
  let losses = 0;
  for (const trade of trades) {
    const pnl = portfolioTradeNet(trade, adverse);
    if (pnl >= 0) gains += pnl;
    else losses -= pnl;
  }
  return losses === 0 ? (gains > 0 ? 99 : 0) : gains / losses;
}

function portfolioDrawdown(trades: PortfolioTrade[]): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const trade of [...trades].sort((a, b) => a.exitAt - b.exitAt)) {
    equity += portfolioTradeNet(trade);
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function portfolioFolds(trades: PortfolioTrade[]): number {
  if (trades.length < 16) return -1;
  const ordered = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  const size = Math.floor(ordered.length / 4);
  let positive = 0;
  for (let fold = 0; fold < 4; fold++) {
    const slice = ordered.slice(
      fold * size,
      fold === 3 ? undefined : (fold + 1) * size,
    );
    if (portfolioSum(slice) > 0) positive++;
  }
  return positive;
}

function portfolioMeanL95(trades: PortfolioTrade[]): number {
  if (trades.length < 2) return Number.NEGATIVE_INFINITY;
  const values = trades.map((trade) => portfolioTradeNet(trade));
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0)
    / (values.length - 1);
  return mean - 1.645 * Math.sqrt(variance / values.length);
}

function portfolioRecent(trades: PortfolioTrade[]): WindowStats[] {
  // High-frequency portfolios can contain hundreds of thousands of trades.
  // Avoid spreading the full array into Math.max: it exhausts the JS argument
  // stack even when there is enough heap to complete the research run.
  const latest = trades.reduce(
    (maximum, trade) => Math.max(maximum, trade.exitAt),
    0,
  );
  return RECENT_WINDOWS_DAYS.map((days) => {
    const recent = trades.filter(
      (trade) => trade.entryAt >= latest - days * 86_400_000,
    );
    return {
      days,
      n: recent.length,
      net: portfolioSum(recent),
      profitFactor: portfolioPf(recent),
      winRatePct: recent.length
        ? recent.filter((trade) => portfolioTradeNet(trade) > 0).length / recent.length * 100
        : 0,
      long: portfolioSum(recent.filter((trade) => trade.side === 'long')),
      short: portfolioSum(recent.filter((trade) => trade.side === 'short')),
    };
  });
}

function portfolioRegimeStat(trades: PortfolioTrade[]): RegimeStat {
  return {
    n: trades.length,
    net: portfolioSum(trades),
    profitFactor: portfolioPf(trades),
  };
}

function portfolioTrendRegimes(trades: PortfolioTrade[]): TrendRegimeStats {
  return {
    bull: portfolioRegimeStat(trades.filter((trade) => trade.trendRegime === 'bull')),
    bear: portfolioRegimeStat(trades.filter((trade) => trade.trendRegime === 'bear')),
    mixed: portfolioRegimeStat(trades.filter((trade) => trade.trendRegime === 'mixed')),
  };
}

function portfolioVolatilityRegimes(trades: PortfolioTrade[]): VolatilityRegimeStats {
  return {
    highVol: portfolioRegimeStat(
      trades.filter((trade) => trade.volatilityRegime === 'highVol'),
    ),
    lowVol: portfolioRegimeStat(
      trades.filter((trade) => trade.volatilityRegime === 'lowVol'),
    ),
  };
}

type PortfolioRow = {
  rule: string;
  trades: PortfolioTrade[];
  dropped: number;
  maxConcurrent: number;
  net: number;
  robustNet: number;
  profitFactor: number;
  winRatePct: number;
  robustProfitFactor: number;
  drawdownUsd: number;
  drawdownPct: number;
  netUsd: number;
  folds: number;
  is: number;
  oos: number;
  long: number;
  short: number;
  meanL95: number;
  recent: WindowStats[];
  activeSymbols: number;
  positiveSymbols: number;
  dominance: number;
  leaveOneOutMinNet: number;
  positiveMonths: number;
  totalMonths: number;
  trendRegimes: TrendRegimeStats;
  volatilityRegimes: VolatilityRegimeStats;
};

const portfolioRows: PortfolioRow[] = [...portfolioGroups.entries()].map(
  ([rule, rawTrades]) => {
    const capped = applyPositionCap(rawTrades, PORTFOLIO_MAX_OPEN);
    const trades = [...capped.accepted].sort((a, b) => a.exitAt - b.exitAt);
    const cut = Math.floor(trades.length * 0.7);
    const bySymbol = new Map<string, PortfolioTrade[]>();
    for (const trade of trades) {
      const symbolTrades = bySymbol.get(trade.symbol) ?? [];
      symbolTrades.push(trade);
      bySymbol.set(trade.symbol, symbolTrades);
    }
    const active = [...bySymbol.values()].filter((symbolTrades) =>
      symbolTrades.length >= 10);
    const symbolNets = active.map((symbolTrades) => portfolioSum(symbolTrades));
    const positiveTotal = symbolNets.reduce(
      (total, value) => total + Math.max(0, value),
      0,
    );
    const monthly = new Map<string, number>();
    for (const trade of trades) {
      const date = new Date(trade.exitAt);
      const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      monthly.set(month, (monthly.get(month) ?? 0) + portfolioTradeNet(trade));
    }
    const net = portfolioSum(trades);
    const drawdownUnits = portfolioDrawdown(trades);
    const capacityUsd = PORTFOLIO_POSITION_NOTIONAL_USD
      * Math.max(1, capped.maxConcurrent);
    return {
      rule,
      trades,
      dropped: capped.dropped,
      maxConcurrent: capped.maxConcurrent,
      net,
      robustNet: portfolioSum(trades, true),
      profitFactor: portfolioPf(trades),
      winRatePct: trades.length
        ? trades.filter((trade) => portfolioTradeNet(trade) > 0).length / trades.length * 100
        : 0,
      robustProfitFactor: portfolioPf(trades, true),
      drawdownUsd: drawdownUnits * PORTFOLIO_POSITION_NOTIONAL_USD / 100,
      drawdownPct: capacityUsd > 0
        ? drawdownUnits * PORTFOLIO_POSITION_NOTIONAL_USD / capacityUsd
        : Number.NEGATIVE_INFINITY,
      netUsd: net * PORTFOLIO_POSITION_NOTIONAL_USD / 100,
      folds: portfolioFolds(trades),
      is: portfolioSum(trades.slice(0, cut)),
      oos: portfolioSum(trades.slice(cut)),
      long: portfolioSum(trades.filter((trade) => trade.side === 'long')),
      short: portfolioSum(trades.filter((trade) => trade.side === 'short')),
      meanL95: portfolioMeanL95(trades),
      recent: portfolioRecent(trades),
      activeSymbols: active.length,
      positiveSymbols: symbolNets.filter((value) => value > 0).length,
      dominance: positiveTotal > 0 ? Math.max(0, ...symbolNets) / positiveTotal : 1,
      leaveOneOutMinNet: symbolNets.length
        ? Math.min(...symbolNets.map((symbolNet) => net - symbolNet))
        : Number.NEGATIVE_INFINITY,
      positiveMonths: [...monthly.values()].filter((value) => value > 0).length,
      totalMonths: monthly.size,
      trendRegimes: portfolioTrendRegimes(trades),
      volatilityRegimes: portfolioVolatilityRegimes(trades),
    };
  },
).filter((row) => row.trades.length >= 30);

const portfolioQualified = portfolioRows.filter((row) =>
  qualificationInputsMeasured
  && row.trades.length >= 120
  && row.net > 0
  && row.profitFactor >= 1.2
  && row.robustNet > 0
  && row.robustProfitFactor >= 1.1
  && row.meanL95 > 0
  && row.folds >= 3
  && row.is > 0
  && row.oos > 0
  && row.long > 0
  && row.short > 0
  && row.drawdownPct >= -MAX_PORTFOLIO_DD_PCT
  && row.activeSymbols >= 4
  && row.positiveSymbols >= Math.max(3, Math.ceil(row.activeSymbols / 2))
  && row.dominance <= 0.6
  && row.leaveOneOutMinNet > 0
  && row.positiveMonths >= Math.max(1, row.totalMonths - 2)
  && row.dropped / (row.trades.length + row.dropped) <= 0.1
  && row.trendRegimes.bull.n >= 20
  && row.trendRegimes.bull.net > 0
  && row.trendRegimes.bull.profitFactor >= 1.1
  && row.trendRegimes.bear.n >= 20
  && row.trendRegimes.bear.net > 0
  && row.trendRegimes.bear.profitFactor >= 1.1
  && (row.trendRegimes.mixed.n < 20
    || (row.trendRegimes.mixed.net > 0
      && row.trendRegimes.mixed.profitFactor >= 1.1))
  && row.volatilityRegimes.highVol.n >= 20
  && row.volatilityRegimes.highVol.net > 0
  && row.volatilityRegimes.highVol.profitFactor >= 1.1
  && row.volatilityRegimes.lowVol.n >= 20
  && row.volatilityRegimes.lowVol.net > 0
  && row.volatilityRegimes.lowVol.profitFactor >= 1.1
  && row.recent.every((window) =>
    window.n >= 20
    && window.net > 0
    && window.profitFactor >= 1.1
    && window.long > 0
    && window.short > 0),
).sort((a, b) => b.net - a.net);

const portfolioBest = [...portfolioRows].sort((a, b) => b.net - a.net);

const print = (row: typeof rows[number]): string =>
  `${row.symbol.padEnd(5)} ${row.rule.padEnd(27)} N${String(row.trades.length).padStart(4)} D${row.coverageDays.toFixed(0).padStart(3)} `
  + `cost p95/max ${row.costPct.toFixed(4)}/${row.adverseCostPct.toFixed(4)}% gross ${fmt(row.baseline).padStart(8)} base ${fmt(row.stress).padStart(8)} PF ${row.stressPf.toFixed(2)} `
  + `observed-max ${fmt(row.robustStress).padStart(8)}/PF${row.robustPf.toFixed(2)} `
  + `DD ${fmt(drawdown(row.trades, row.costPct))} WR ${(row.trades.filter((trade) => tradeNet(trade, row.costPct) > 0).length / row.trades.length * 100).toFixed(1)}% `
  + `L95 ${row.meanL95 >= 0 ? '+' : ''}${row.meanL95.toFixed(4)} `
  + `hold ${median(row.trades.map((trade) => (trade.exitAt - trade.entryAt) / 60_000)).toFixed(0)}m `
  + `f${row.folds}/4 IS/OOS ${fmt(row.is)}/${fmt(row.oos)} L/S ${fmt(row.long)}/${fmt(row.short)} `
  + `trend B[n${row.trendRegimes.bull.n} ${fmt(row.trendRegimes.bull.net)}/PF${row.trendRegimes.bull.profitFactor.toFixed(2)}] `
  + `R[n${row.trendRegimes.bear.n} ${fmt(row.trendRegimes.bear.net)}/PF${row.trendRegimes.bear.profitFactor.toFixed(2)}] `
  + `M[n${row.trendRegimes.mixed.n} ${fmt(row.trendRegimes.mixed.net)}/PF${row.trendRegimes.mixed.profitFactor.toFixed(2)}] `
  + `vol H[n${row.volatilityRegimes.highVol.n} ${fmt(row.volatilityRegimes.highVol.net)}/PF${row.volatilityRegimes.highVol.profitFactor.toFixed(2)}] `
  + `L[n${row.volatilityRegimes.lowVol.n} ${fmt(row.volatilityRegimes.lowVol.net)}/PF${row.volatilityRegimes.lowVol.profitFactor.toFixed(2)}] `
  + row.recent.map((window) =>
    `W${window.days} n${window.n} ${fmt(window.net)}/PF${window.profitFactor.toFixed(2)} `
    + `L/S${fmt(window.long)}/${fmt(window.short)}`).join(' ');

const printPortfolio = (row: PortfolioRow): string =>
  `${row.rule.padEnd(27)} N${String(row.trades.length).padStart(4)} `
  + `net ${fmt(row.net).padStart(8)} PF ${row.profitFactor.toFixed(2)} `
  + `WR ${row.winRatePct.toFixed(1)}% `
  + `adverse ${fmt(row.robustNet).padStart(8)}/PF${row.robustProfitFactor.toFixed(2)} `
  + `PnL $${row.netUsd.toFixed(2)} DD $${row.drawdownUsd.toFixed(2)}/${fmt(row.drawdownPct)}% `
  + `L95 ${row.meanL95 >= 0 ? '+' : ''}${row.meanL95.toFixed(4)} `
  + `f${row.folds}/4 IS/OOS ${fmt(row.is)}/${fmt(row.oos)} `
  + `L/S ${fmt(row.long)}/${fmt(row.short)} `
  + `symbols ${row.positiveSymbols}/${row.activeSymbols}+ dom ${(row.dominance * 100).toFixed(0)}% `
  + `LOO ${fmt(row.leaveOneOutMinNet)} months ${row.positiveMonths}/${row.totalMonths} `
  + `trend BULL[n${row.trendRegimes.bull.n} ${fmt(row.trendRegimes.bull.net)}/PF${row.trendRegimes.bull.profitFactor.toFixed(2)}] `
  + `BEAR[n${row.trendRegimes.bear.n} ${fmt(row.trendRegimes.bear.net)}/PF${row.trendRegimes.bear.profitFactor.toFixed(2)}] `
  + `MIX[n${row.trendRegimes.mixed.n} ${fmt(row.trendRegimes.mixed.net)}/PF${row.trendRegimes.mixed.profitFactor.toFixed(2)}] `
  + `vol HI[n${row.volatilityRegimes.highVol.n} ${fmt(row.volatilityRegimes.highVol.net)}/PF${row.volatilityRegimes.highVol.profitFactor.toFixed(2)}] `
  + `LO[n${row.volatilityRegimes.lowVol.n} ${fmt(row.volatilityRegimes.lowVol.net)}/PF${row.volatilityRegimes.lowVol.profitFactor.toFixed(2)}] `
  + `cap ${row.maxConcurrent}/${PORTFOLIO_MAX_OPEN} drop ${row.dropped} `
  + row.recent.map((window) =>
    `W${window.days} n${window.n} ${fmt(window.net)}/PF${window.profitFactor.toFixed(2)} `
    + `L/S${fmt(window.long)}/${fmt(window.short)}`).join(' ');

const costLabel = executionCostBySymbol.size
  ? `${executionCostBySymbol.size} market-specific p95 costs`
  : `${FALLBACK_EXECUTION_COST_PCT}% explicitly enabled fallback cost`;
const fundingLabel = fundingBySymbol.size
  ? `${fundingBySymbol.size} market-specific hourly funding histories`
  : `${FALLBACK_FUNDING_PER_HOUR_PCT}%/h explicitly enabled fallback funding`;
console.warn(`Native Lighter ${BAR_MINUTES}m · ${[...loaded.keys()].join(', ')} · ${LOOKBACK_DAYS || 'all-cache'}d · zero commission · ${costLabel} · adverse measured max (non-blocking) · ${fundingLabel} · max DD ${MAX_BACKTEST_DD_PCT}%`);
console.warn(`\nQUALIFIED (${qualified.length})`);
console.warn(qualified.length ? qualified.slice(0, 30).map(print).join('\n') : '— none —');
console.warn('\nTOP 30 (including failures)');
console.warn(best.slice(0, 30).map(print).join('\n'));
console.warn(`\nPORTFOLIO QUALIFIED (${portfolioQualified.length}) · one fixed rule across all >=${PORTFOLIO_MIN_COVERAGE_DAYS}d markets · max ${PORTFOLIO_MAX_OPEN} concurrent`);
console.warn(portfolioQualified.length
  ? portfolioQualified.slice(0, 20).map(printPortfolio).join('\n')
  : '— none —');
console.warn('\nPORTFOLIO TOP 20 (including failures)');
console.warn(portfolioBest.slice(0, 20).map(printPortfolio).join('\n'));

if (OUTPUT_JSON) {
  const compactRows = rows.map(({ trades, ...row }) => ({
    ...row,
    trades: trades.length,
    ...(OUTPUT_INCLUDE_TRADE_DETAILS ? { tradeDetails: trades } : {}),
    grossPct: row.baseline,
    netPct: row.stress,
    adverseNetPct: row.robustStress,
    fundingPct: trades.reduce((total, trade) => total + (trade.fundingPct ?? 0), 0),
    maxDrawdownPct: drawdown(trades, row.costPct),
  }));
  const compactPortfolioRows = portfolioRows.map(({ trades, ...row }) => ({
    ...row,
    trades: trades.length,
    fundingPct: trades.reduce((total, trade) => total + (trade.fundingPct ?? 0), 0),
  }));
  const report = {
    version: 'lighter-native-sweep-v2',
    generatedAt: new Date().toISOString(),
    input: {
      symbols: [...loaded.keys()],
      candleSources: Object.fromEntries(candleSourceBySymbol),
      barMinutes: BAR_MINUTES,
      lookbackDays: LOOKBACK_DAYS || null,
      ruleFilter: RULE_FILTER || null,
      positionNotionalUsd: PORTFOLIO_POSITION_NOTIONAL_USD,
      portfolioMaxOpen: PORTFOLIO_MAX_OPEN,
      executionCosts: 'market-specific executable $100 full-round-trip p95',
      adverseExecution: 'market-specific observed maximum; non-blocking sensitivity',
      funding: 'exact Lighter hourly settlements in (entry, exit]',
      fundingHistoryFiles: FUNDING_HISTORY_FILES,
      fundingCoverage: Object.fromEntries(fundingCoverageBySymbol),
      qualificationInputsMeasured,
      usedFallbackExecutionCost,
      usedFallbackFunding,
    },
    qualified: qualified.map((row) => `${row.symbol}:${row.rule}`),
    rows: compactRows,
    portfolioQualified: portfolioQualified.map((row) => row.rule),
    portfolioRows: compactPortfolioRows,
  };
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  const temporary = `${OUTPUT_JSON}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, OUTPUT_JSON);
  console.warn(`\nJSON → ${OUTPUT_JSON}`);
}

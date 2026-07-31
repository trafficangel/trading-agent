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
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  lighterFundingPnlPct,
  type LighterFundingPoint,
  type LighterFundingSeries,
} from '../src/lib/lighter-funding-history.js';

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
const FUNDING_HISTORY_FILE = resolve(
  process.env.FUNDING_HISTORY_FILE ?? 'data/lighter-funding-history-native.json',
);
const OUTPUT_JSON = process.env.OUTPUT_JSON ? resolve(process.env.OUTPUT_JSON) : null;
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
  ema400: number[];
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
  atrPctMean288: number[];
  rsi2: number[];
  rsi7: number[];
  rsi14: number[];
  stoch14: number[];
  stoch14Signal: number[];
  cci20: number[];
  mfi14: number[];
  williams14: number[];
  vwap60: number[];
  vwapSd60: number[];
  efficiencyRatio60: number[];
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
if (existsSync(FUNDING_HISTORY_FILE)) {
  const parsed = JSON.parse(readFileSync(FUNDING_HISTORY_FILE, 'utf8')) as FundingHistoryFile;
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

function build(c: Candle[]): Arrays {
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
  const atrPctMean288 = sma(
    atr14Values.map((value, i) => close[i]! > 0 ? value / close[i]! : 0),
    288,
  );
  return {
    c,
    close,
    ema200: ema(close, 200),
    ema400: ema(close, 400),
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
    atrPctMean288,
    rsi2: rsi(c, 2),
    rsi7: rsi(c, 7),
    rsi14: rsi(c, 14),
    stoch14,
    stoch14Signal: sma(stoch14, 3),
    cci20: cci(c, 20),
    mfi14: moneyFlowIndex(c, 14),
    williams14: williamsR(c, 14),
    vwap60: vw60.mean,
    vwapSd60: vw60.deviation,
    efficiencyRatio60: efficiencyRatio(close, 60),
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
for (const symbol of SYMBOLS) {
  const directFile = resolve('data', 'lighter-klines', `${symbol}-${BAR_MINUTES}m.json`);
  const oneMinuteFile = resolve('data', 'lighter-klines', `${symbol}-1m.json`);
  const file = existsSync(directFile) ? directFile : oneMinuteFile;
  if (!existsSync(file)) continue;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Candle[];
  const maxTime = raw.at(-1)?.t ?? 0;
  const windowed = LOOKBACK_DAYS > 0
    ? raw.filter((candle) => candle.t >= maxTime - LOOKBACK_DAYS * 86_400_000)
    : raw;
  const candles = file === directFile ? windowed : aggregateCandles(windowed, BAR_MINUTES);
  loaded.set(symbol, build(candles));
}

const rows: Array<{
  symbol: string;
  rule: string;
  costPct: number;
  adverseCostPct: number;
  trades: Trade[];
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
      trades,
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

type RegimeStat = { n: number; net: number; profitFactor: number };
type TrendRegimeStats = Record<TrendRegime, RegimeStat>;
type VolatilityRegimeStats = Record<VolatilityRegime, RegimeStat>;

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
console.log(`Native Lighter ${BAR_MINUTES}m · ${[...loaded.keys()].join(', ')} · ${LOOKBACK_DAYS || 'all-cache'}d · zero commission · ${costLabel} · adverse measured max (non-blocking) · ${fundingLabel} · max DD ${MAX_BACKTEST_DD_PCT}%`);
console.log(`\nQUALIFIED (${qualified.length})`);
console.log(qualified.length ? qualified.slice(0, 30).map(print).join('\n') : '— none —');
console.log('\nTOP 30 (including failures)');
console.log(best.slice(0, 30).map(print).join('\n'));
console.log(`\nPORTFOLIO QUALIFIED (${portfolioQualified.length}) · one fixed rule across all >=${PORTFOLIO_MIN_COVERAGE_DAYS}d markets · max ${PORTFOLIO_MAX_OPEN} concurrent`);
console.log(portfolioQualified.length
  ? portfolioQualified.slice(0, 20).map(printPortfolio).join('\n')
  : '— none —');
console.log('\nPORTFOLIO TOP 20 (including failures)');
console.log(portfolioBest.slice(0, 20).map(printPortfolio).join('\n'));

if (OUTPUT_JSON) {
  const compactRows = rows.map(({ trades, ...row }) => ({
    ...row,
    trades: trades.length,
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
      barMinutes: BAR_MINUTES,
      lookbackDays: LOOKBACK_DAYS || null,
      ruleFilter: RULE_FILTER || null,
      positionNotionalUsd: PORTFOLIO_POSITION_NOTIONAL_USD,
      portfolioMaxOpen: PORTFOLIO_MAX_OPEN,
      executionCosts: 'market-specific executable $100 full-round-trip p95',
      adverseExecution: 'market-specific observed maximum; non-blocking sensitivity',
      funding: 'exact Lighter hourly settlements in (entry, exit]',
      fundingHistoryFile:
        process.env.FUNDING_HISTORY_FILE ?? 'data/lighter-funding-history-native.json',
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
  console.log(`\nJSON → ${OUTPUT_JSON}`);
}

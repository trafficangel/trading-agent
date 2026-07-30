/**
 * Second LuxAlgo Quant prototype: symmetric range mean reversion.
 *
 * Research only. No strategy registry changes and no order execution.
 * Run on the VPS:
 *   pnpm tsx scripts/research-lighter-range.ts [1|5]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
const timeframe = process.argv[2] === '1' ? '1' : '5';
const barsPerMinute = 1 / Number(timeframe);
const atrPeriod = Math.round(30 * barsPerMinute);
const fastPeriod = Math.round(30 * barsPerMinute);
const slowPeriod = Math.round(240 * barsPerMinute);
const meanMinutes = [60, 120, 240] as const;
const zThresholds = [1.5, 2, 2.5] as const;
const rangeThresholds = [0.5, 1, 1.5] as const;
const stopAtrValues = [2, 3, 4] as const;
const holdHours = [1, 2, 4] as const;

type Side = 'long' | 'short';
type Trade = { side: Side; entryAt: number; exitAt: number; grossPct: number; durationHours: number };
type Params = { meanBars: number; z: number; rangeAtr: number; stopAtr: number; holdBars: number };
type Metrics = { n: number; net: number; avg: number; pf: number; wr: number; maxDd: number };
type Prepared = {
  candles: Candle[];
  atr: number[];
  fast: number[];
  slow: number[];
  bands: Map<number, { mean: number[]; std: number[] }>;
};
type AssetResult = {
  symbol: string;
  full: Metrics;
  oos: Metrics;
  stress: Metrics;
  long: Metrics;
  short: Metrics;
  positiveFolds: number;
};
type Ranked = {
  params: Params;
  assets: AssetResult[];
  pass: boolean;
  medianOosAvg: number;
  worstOosAvg: number;
  medianStressAvg: number;
  positiveFolds: number;
};

function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  const alpha = 2 / (period + 1);
  let value = values[0] ?? Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    value = i === 0 ? values[i]! : alpha * values[i]! + (1 - alpha) * value;
    if (i >= period - 1) out[i] = value;
  }
  return out;
}

function atr(candles: Candle[], period: number): number[] {
  const trueRange = candles.map((bar, i) => {
    if (i === 0) return bar.h - bar.l;
    const priorClose = candles[i - 1]!.c;
    return Math.max(bar.h - bar.l, Math.abs(bar.h - priorClose), Math.abs(bar.l - priorClose));
  });
  return ema(trueRange, period);
}

function rolling(values: number[], period: number): { mean: number[]; std: number[] } {
  const mean = new Array<number>(values.length).fill(Number.NaN);
  const std = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    sum += value;
    sumSquares += value * value;
    if (i >= period) {
      const removed = values[i - period]!;
      sum -= removed;
      sumSquares -= removed * removed;
    }
    if (i >= period - 1) {
      const average = sum / period;
      mean[i] = average;
      std[i] = Math.sqrt(Math.max(0, sumSquares / period - average * average));
    }
  }
  return { mean, std };
}

function load(symbol: string): Prepared {
  const candles = JSON.parse(
    readFileSync(resolve('data', 'klines', `${symbol}-${timeframe}.json`), 'utf8'),
  ) as Candle[];
  const closes = candles.map((bar) => bar.c);
  const bands = new Map<number, { mean: number[]; std: number[] }>();
  for (const minutes of meanMinutes) {
    const bars = Math.round(minutes * barsPerMinute);
    bands.set(bars, rolling(closes, bars));
  }
  return {
    candles,
    atr: atr(candles, atrPeriod),
    fast: ema(closes, fastPeriod),
    slow: ema(closes, slowPeriod),
    bands,
  };
}

function simulate(data: Prepared, params: Params): Trade[] {
  const { candles, atr: atrValues, fast, slow } = data;
  const band = data.bands.get(params.meanBars)!;
  const warmup = Math.max(slowPeriod, params.meanBars, atrPeriod) + 2;
  const trades: Trade[] = [];
  let pending: { side: Side; atr: number; target: number } | null = null;
  let position: {
    side: Side;
    entryAt: number;
    entryIndex: number;
    entryPrice: number;
    stop: number;
  } | null = null;

  for (let i = warmup; i < candles.length; i += 1) {
    const bar = candles[i]!;
    if (!position && pending) {
      const profitableTarget = pending.side === 'long' ? pending.target > bar.o : pending.target < bar.o;
      if (profitableTarget) {
        const stopDistance = params.stopAtr * pending.atr;
        position = {
          side: pending.side,
          entryAt: bar.t,
          entryIndex: i,
          entryPrice: bar.o,
          stop: pending.side === 'long' ? bar.o - stopDistance : bar.o + stopDistance,
        };
      }
      pending = null;
    }

    if (position) {
      const stopHit = position.side === 'long' ? bar.l <= position.stop : bar.h >= position.stop;
      const knownMean = band.mean[i - 1]!;
      const targetHit = Number.isFinite(knownMean)
        && (position.side === 'long' ? bar.h >= knownMean : bar.l <= knownMean);
      const timedOut = i - position.entryIndex >= params.holdBars;
      let exitPrice: number | null = null;
      if (stopHit) exitPrice = position.stop;
      else if (targetHit) exitPrice = knownMean;
      else if (timedOut) exitPrice = bar.o;
      if (exitPrice !== null) {
        const sign = position.side === 'long' ? 1 : -1;
        trades.push({
          side: position.side,
          entryAt: position.entryAt,
          exitAt: bar.t,
          grossPct: (sign * (exitPrice - position.entryPrice) / position.entryPrice) * 100,
          durationHours: Math.max(0, (bar.t - position.entryAt) / 3_600_000),
        });
        position = null;
        continue;
      }
      continue;
    }

    const a = atrValues[i]!;
    const m = band.mean[i]!;
    const sd = band.std[i]!;
    const previousMean = band.mean[i - 1]!;
    const previousStd = band.std[i - 1]!;
    if (![a, m, sd, previousMean, previousStd, fast[i]!, slow[i]!].every(Number.isFinite) || !(a > 0) || !(sd > 0)) continue;
    const ranging = Math.abs(fast[i]! - slow[i]!) <= params.rangeAtr * a;
    if (!ranging) continue;
    const z = (bar.c - m) / sd;
    const previousZ = (candles[i - 1]!.c - previousMean) / previousStd;
    const newOversold = z <= -params.z && previousZ > -params.z;
    const newOverbought = z >= params.z && previousZ < params.z;
    if (newOversold) pending = { side: 'long', atr: a, target: m };
    else if (newOverbought) pending = { side: 'short', atr: a, target: m };
  }
  return trades;
}

function metrics(trades: Trade[], roundTripBps: number, fundingBpsPer8h: number): Metrics {
  let gain = 0;
  let loss = 0;
  let wins = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const trade of trades) {
    const fundingPct = (fundingBpsPer8h / 100) * (trade.durationHours / 8);
    const net = trade.grossPct - roundTripBps / 100 - fundingPct;
    if (net > 0) {
      gain += net;
      wins += 1;
    } else {
      loss += -net;
    }
    cumulative += net;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
  }
  return {
    n: trades.length,
    net: cumulative,
    avg: trades.length ? cumulative / trades.length : 0,
    pf: loss > 0 ? gain / loss : gain > 0 ? Number.POSITIVE_INFINITY : 0,
    wr: trades.length ? wins / trades.length : 0,
    maxDd,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function evaluate(symbol: string, data: Prepared, params: Params): AssetResult {
  const trades = simulate(data, params);
  const start = data.candles[0]!.t;
  const end = data.candles.at(-1)!.t;
  const holdoutStart = start + (end - start) * 0.8;
  const oosTrades = trades.filter((trade) => trade.entryAt >= holdoutStart);
  let positiveFolds = 0;
  for (let fold = 0; fold < 5; fold += 1) {
    const foldStart = start + (end - start) * (fold / 5);
    const foldEnd = start + (end - start) * ((fold + 1) / 5);
    const foldTrades = trades.filter((trade) => trade.entryAt >= foldStart && trade.entryAt < foldEnd);
    if (metrics(foldTrades, 6, 1).net > 0) positiveFolds += 1;
  }
  return {
    symbol,
    full: metrics(trades, 6, 1),
    oos: metrics(oosTrades, 6, 1),
    stress: metrics(oosTrades, 12, 2),
    long: metrics(oosTrades.filter((trade) => trade.side === 'long'), 6, 1),
    short: metrics(oosTrades.filter((trade) => trade.side === 'short'), 6, 1),
    positiveFolds,
  };
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

const prepared = new Map<string, Prepared>();
for (const symbol of SYMBOLS) prepared.set(symbol, load(symbol));

const ranked: Ranked[] = [];
for (const minutes of meanMinutes) {
  const meanBars = Math.round(minutes * barsPerMinute);
  for (const z of zThresholds) {
    for (const rangeAtr of rangeThresholds) {
      for (const stopAtr of stopAtrValues) {
        for (const hours of holdHours) {
          const params: Params = {
            meanBars,
            z,
            rangeAtr,
            stopAtr,
            holdBars: Math.round(hours * 60 * barsPerMinute),
          };
          const assets = SYMBOLS.map((symbol) => evaluate(symbol, prepared.get(symbol)!, params));
          const medianOosAvg = median(assets.map((asset) => asset.oos.avg));
          const worstOosAvg = Math.min(...assets.map((asset) => asset.oos.avg));
          const medianStressAvg = median(assets.map((asset) => asset.stress.avg));
          const positiveFolds = assets.reduce((sum, asset) => sum + asset.positiveFolds, 0);
          const pass = assets.every((asset) =>
            asset.full.n >= 100
            && asset.oos.n >= 20
            && asset.oos.net > 0
            && asset.stress.net > 0
            && asset.long.n >= 8
            && asset.short.n >= 8
            && asset.long.net > 0
            && asset.short.net > 0
            && asset.positiveFolds >= 3,
          );
          ranked.push({
            params,
            assets,
            pass,
            medianOosAvg,
            worstOosAvg,
            medianStressAvg,
            positiveFolds,
          });
        }
      }
    }
  }
}

ranked.sort((a, b) =>
  Number(b.pass) - Number(a.pass)
  || b.worstOosAvg - a.worstOosAvg
  || b.medianStressAvg - a.medianStressAvg
  || b.positiveFolds - a.positiveFolds,
);

console.log(
  `Lighter Quant range research · ${timeframe}m · BTC/ETH/SOL · next-open fills · `
  + 'realistic 6bps RT + 1bps funding/8h · stress 12bps + 2bps/8h',
);
console.log(`Period: ${new Date(prepared.get('BTCUSDT')!.candles[0]!.t).toISOString()} → ${new Date(prepared.get('BTCUSDT')!.candles.at(-1)!.t).toISOString()}`);
console.log(`Tested ${ranked.length} fixed nearby configurations; PASS ${ranked.filter((row) => row.pass).length}\n`);

for (const [index, row] of ranked.slice(0, 15).entries()) {
  const p = row.params;
  console.log(
    `${String(index + 1).padStart(2)} ${row.pass ? 'PASS' : '    '} `
    + `M${p.meanBars} z${p.z} range${p.rangeAtr} SL${p.stopAtr} H${Math.round(p.holdBars * Number(timeframe) / 60)} `
    + `worstOOS ${formatPct(row.worstOosAvg)}/trade medianStress ${formatPct(row.medianStressAvg)}/trade folds ${row.positiveFolds}/15`,
  );
  for (const asset of row.assets) {
    console.log(
      `   ${asset.symbol.padEnd(9)} N${String(asset.full.n).padStart(4)} `
      + `OOS N${String(asset.oos.n).padStart(3)} net ${formatPct(asset.oos.net)} PF ${asset.oos.pf.toFixed(2)} `
      + `L ${asset.long.n}/${formatPct(asset.long.net)} S ${asset.short.n}/${formatPct(asset.short.net)} `
      + `stress ${formatPct(asset.stress.net)} folds ${asset.positiveFolds}/5 DD ${formatPct(-asset.full.maxDd)}`,
    );
  }
}


/**
 * Adversarial validation for the first LuxAlgo Quant strategy prototype.
 *
 * Strategy:
 * - completed-candle EMA regime filter;
 * - prior-bar Donchian breakout;
 * - next-bar-open entry;
 * - symmetric ATR stop/target and time exit;
 * - no same-bar reversal.
 *
 * This is research only. It does not register a live strategy or send orders.
 *
 * Run on the VPS where data/klines is populated:
 *   pnpm tsx scripts/research-lighter-quant.ts [1|5]
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
const breakoutMinutes = [30, 60, 90] as const;
const separationAtr = [0, 0.1, 0.2] as const;
const stopAtr = [1.5, 2, 2.5] as const;
const rewardR = [1.5, 2, 2.5] as const;
const holdHours = [4, 8, 12] as const;

type Side = 'long' | 'short';
type Trade = {
  side: Side;
  entryAt: number;
  exitAt: number;
  grossPct: number;
  durationHours: number;
};
type Params = {
  breakoutBars: number;
  separationAtr: number;
  stopAtr: number;
  rewardR: number;
  holdBars: number;
};
type Metrics = {
  n: number;
  net: number;
  avg: number;
  pf: number;
  wr: number;
  maxDd: number;
};
type Prepared = {
  candles: Candle[];
  atr: number[];
  fast: number[];
  slow: number[];
  channels: Map<number, { upper: number[]; lower: number[] }>;
};
type AssetResult = {
  symbol: string;
  full: Metrics;
  oos: Metrics;
  stress: Metrics;
  long: Metrics;
  short: Metrics;
  positiveFolds: number;
  trades: Trade[];
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
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const previousClose = candles[i - 1]!.c;
    return Math.max(c.h - c.l, Math.abs(c.h - previousClose), Math.abs(c.l - previousClose));
  });
  return ema(tr, period);
}

function priorChannel(candles: Candle[], period: number): { upper: number[]; lower: number[] } {
  const upper = new Array<number>(candles.length).fill(Number.NaN);
  const lower = new Array<number>(candles.length).fill(Number.NaN);
  const highDeque: number[] = [];
  const lowDeque: number[] = [];
  let highHead = 0;
  let lowHead = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const add = i - 1;
    if (add >= 0) {
      while (highDeque.length > highHead && candles[highDeque.at(-1)!]!.h <= candles[add]!.h) highDeque.pop();
      while (lowDeque.length > lowHead && candles[lowDeque.at(-1)!]!.l >= candles[add]!.l) lowDeque.pop();
      highDeque.push(add);
      lowDeque.push(add);
    }
    const oldest = i - period;
    while (highDeque.length > highHead && highDeque[highHead]! < oldest) highHead += 1;
    while (lowDeque.length > lowHead && lowDeque[lowHead]! < oldest) lowHead += 1;
    if (i >= period && highDeque.length > highHead && lowDeque.length > lowHead) {
      upper[i] = candles[highDeque[highHead]!]!.h;
      lower[i] = candles[lowDeque[lowHead]!]!.l;
    }
    if (highHead > 4096) {
      highDeque.splice(0, highHead);
      highHead = 0;
    }
    if (lowHead > 4096) {
      lowDeque.splice(0, lowHead);
      lowHead = 0;
    }
  }
  return { upper, lower };
}

function load(symbol: string): Prepared {
  const candles = JSON.parse(
    readFileSync(resolve('data', 'klines', `${symbol}-${timeframe}.json`), 'utf8'),
  ) as Candle[];
  const closes = candles.map((c) => c.c);
  const channels = new Map<number, { upper: number[]; lower: number[] }>();
  for (const minutes of breakoutMinutes) {
    const bars = Math.round(minutes * barsPerMinute);
    channels.set(bars, priorChannel(candles, bars));
  }
  return {
    candles,
    atr: atr(candles, atrPeriod),
    fast: ema(closes, fastPeriod),
    slow: ema(closes, slowPeriod),
    channels,
  };
}

function simulate(data: Prepared, params: Params): Trade[] {
  const { candles, atr: atrValues, fast, slow } = data;
  const channel = data.channels.get(params.breakoutBars)!;
  const warmup = Math.max(slowPeriod, params.breakoutBars, atrPeriod) + 2;
  const trades: Trade[] = [];
  let pending: { side: Side; atr: number; signalAt: number } | null = null;
  let position: {
    side: Side;
    entryAt: number;
    entryIndex: number;
    entryPrice: number;
    stop: number;
    target: number;
  } | null = null;

  for (let i = warmup; i < candles.length; i += 1) {
    const bar = candles[i]!;

    if (!position && pending) {
      const entryPrice = bar.o;
      const risk = params.stopAtr * pending.atr;
      if (risk > 0 && Number.isFinite(risk)) {
        position = {
          side: pending.side,
          entryAt: bar.t,
          entryIndex: i,
          entryPrice,
          stop: pending.side === 'long' ? entryPrice - risk : entryPrice + risk,
          target: pending.side === 'long'
            ? entryPrice + risk * params.rewardR
            : entryPrice - risk * params.rewardR,
        };
      }
      pending = null;
    }

    if (position) {
      const stopHit = position.side === 'long' ? bar.l <= position.stop : bar.h >= position.stop;
      const targetHit = position.side === 'long' ? bar.h >= position.target : bar.l <= position.target;
      const timedOut = i - position.entryIndex >= params.holdBars;
      let exitPrice: number | null = null;
      if (stopHit) exitPrice = position.stop; // conservative if stop + target share a bar
      else if (targetHit) exitPrice = position.target;
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
        continue; // no same-bar reversal
      }
      continue;
    }

    const a = atrValues[i]!;
    const f = fast[i]!;
    const s = slow[i]!;
    const upper = channel.upper[i]!;
    const lower = channel.lower[i]!;
    const previousUpper = channel.upper[i - 1]!;
    const previousLower = channel.lower[i - 1]!;
    const previousClose = candles[i - 1]!.c;
    if (![a, f, s, upper, lower, previousUpper, previousLower].every(Number.isFinite) || !(a > 0)) continue;
    const threshold = params.separationAtr * a;
    const newLongBreakout = bar.c > upper && previousClose <= previousUpper;
    const newShortBreakout = bar.c < lower && previousClose >= previousLower;
    if (newLongBreakout && f - s >= threshold) pending = { side: 'long', atr: a, signalAt: bar.t };
    else if (newShortBreakout && s - f >= threshold) pending = { side: 'short', atr: a, signalAt: bar.t };
  }
  return trades;
}

function metrics(trades: Trade[], roundTripBps: number, fundingBpsPer8h: number): Metrics {
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const trade of trades) {
    const fundingPct = (fundingBpsPer8h / 100) * (trade.durationHours / 8);
    const net = trade.grossPct - roundTripBps / 100 - fundingPct;
    if (net > 0) {
      grossProfit += net;
      wins += 1;
    } else {
      grossLoss += -net;
    }
    cumulative += net;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
  }
  return {
    n: trades.length,
    net: cumulative,
    avg: trades.length ? cumulative / trades.length : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
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
    trades,
  };
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

const prepared = new Map<string, Prepared>();
for (const symbol of SYMBOLS) prepared.set(symbol, load(symbol));

const ranked: Ranked[] = [];
for (const minutes of breakoutMinutes) {
  const breakoutBars = Math.round(minutes * barsPerMinute);
  for (const separation of separationAtr) {
    for (const stop of stopAtr) {
      for (const reward of rewardR) {
        for (const hours of holdHours) {
          const params: Params = {
            breakoutBars,
            separationAtr: separation,
            stopAtr: stop,
            rewardR: reward,
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
  `Lighter Quant research · ${timeframe}m · BTC/ETH/SOL · next-open fills · `
  + 'realistic 6bps RT + 1bps funding/8h · stress 12bps + 2bps/8h',
);
console.log(`Period: ${new Date(prepared.get('BTCUSDT')!.candles[0]!.t).toISOString()} → ${new Date(prepared.get('BTCUSDT')!.candles.at(-1)!.t).toISOString()}`);
console.log(`Tested ${ranked.length} fixed nearby configurations; PASS ${ranked.filter((row) => row.pass).length}\n`);

for (const [index, row] of ranked.slice(0, 15).entries()) {
  const p = row.params;
  console.log(
    `${String(index + 1).padStart(2)} ${row.pass ? 'PASS' : '    '} `
    + `D${p.breakoutBars} sep${p.separationAtr} SL${p.stopAtr} R${p.rewardR} H${Math.round(p.holdBars * Number(timeframe) / 60)} `
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

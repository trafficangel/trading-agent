/**
 * Native Lighter 1-minute strategy sweep.
 *
 * Uses candles downloaded by verify-passive-lowtf.ts with DATA_SOURCE=lighter.
 * Signals are computed only from completed candles and execute at the next
 * candle open. Commission is zero for a Standard account; an independent
 * round-trip stress is subtracted from every trade.
 *
 * Run after downloading native candles:
 *   STRESS_RT_PCT=0.02 pnpm tsx scripts/sweep-lighter-native-1m.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atr, ema, rollingStd, rsi, sma, type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = (process.env.SYMBOLS ?? 'BTC,ETH,SOL')
  .split(',')
  .map((symbol) => symbol.trim())
  .filter(Boolean);
const STRESS_RT_PCT = Number(process.env.STRESS_RT_PCT ?? 0.02);
const FUNDING_PER_HOUR_PCT = Number(process.env.FUNDING_PER_HOUR_PCT ?? 0.00125);
const BAR_MINUTES = Number(process.env.BAR_MINUTES ?? 1);
const Z_PERIODS = (process.env.Z_PERIODS ?? '20,60').split(',').map(Number);
const Z_THRESHOLDS = (process.env.Z_THRESHOLDS ?? '1.5,2,2.5,3').split(',').map(Number);
const Z_SL_PCT = Number(process.env.Z_SL_PCT ?? 1.5) / 100;
const Z_MAX_HOLD_BARS = Number(process.env.Z_MAX_HOLD_BARS ?? 240);
const RULE_FILTER = process.env.RULE_FILTER ?? '';
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
};
type Rule = {
  name: string;
  warmup: number;
  slPct: number;
  maxBars: number;
  entry: (a: Arrays, i: number) => Side | null;
  exit: (a: Arrays, i: number, side: Side) => boolean;
};
type Trade = { side: Side; entryAt: number; exitAt: number; pct: number };
type WindowStats = {
  days: number;
  n: number;
  net: number;
  profitFactor: number;
  long: number;
  short: number;
};

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
    sma20: sma(close, 20),
    sma60: sma(close, 60),
    volumeSma20: sma(volume, 20),
    volumeSma60: sma(volume, 60),
    sd20: rollingStd(close, 20),
    sd60: rollingStd(close, 60),
    means: new Map(Z_PERIODS.map((period) => [period, sma(close, period)])),
    deviations: new Map(Z_PERIODS.map((period) => [period, rollingStd(close, period)])),
    atr14: atr(c, 14),
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

  for (const threshold of [2.5, 3]) {
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

function tradeNet(trade: Trade, stress = 0): number {
  const holdHours = Math.max(0, trade.exitAt - trade.entryAt) / 3_600_000;
  return trade.pct - stress - (stress > 0 ? holdHours * FUNDING_PER_HOUR_PCT : 0);
}

function sum(trades: Trade[], stress = 0): number {
  return trades.reduce((acc, trade) => acc + tradeNet(trade, stress), 0);
}

function pf(trades: Trade[], stress = 0): number {
  let gains = 0;
  let losses = 0;
  for (const trade of trades) {
    const pnl = tradeNet(trade, stress);
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
  trades: Trade[];
  baseline: number;
  stress: number;
  stressPf: number;
  folds: number;
  is: number;
  oos: number;
  long: number;
  short: number;
  recent: WindowStats[];
  coverageDays: number;
  meanL95: number;
}> = [];

for (const [symbol, arrays] of loaded) {
  for (const rule of rules()) {
    if (RULE_FILTER && !rule.name.includes(RULE_FILTER)) continue;
    const trades = simulate(rule, arrays);
    if (trades.length < 20) continue;
    const cut = Math.floor(trades.length * 0.7);
    rows.push({
      symbol,
      rule: rule.name,
      trades,
      baseline: sum(trades),
      stress: sum(trades, STRESS_RT_PCT),
      stressPf: pf(trades, STRESS_RT_PCT),
      folds: positiveFolds(trades, STRESS_RT_PCT),
      is: sum(trades.slice(0, cut), STRESS_RT_PCT),
      oos: sum(trades.slice(cut), STRESS_RT_PCT),
      long: sum(trades.filter((trade) => trade.side === 'long'), STRESS_RT_PCT),
      short: sum(trades.filter((trade) => trade.side === 'short'), STRESS_RT_PCT),
      recent: recentStats(trades, STRESS_RT_PCT),
      coverageDays: Math.max(
        0,
        ((arrays.c.at(-1)?.t ?? 0) - (arrays.c[0]?.t ?? 0)) / 86_400_000,
      ),
      meanL95: meanL95(trades, STRESS_RT_PCT),
    });
  }
}

const requiredCoverageDays = Math.max(0, ...RECENT_WINDOWS_DAYS);
const qualified = rows
  .filter((row) => row.trades.length >= 30
    && row.coverageDays >= requiredCoverageDays * 0.95
    && row.stress > 0
    && row.meanL95 > 0
    && row.stressPf >= 1.2
    && row.folds >= 3
    && row.is > 0
    && row.oos > 0
    && row.long > 0
    && row.short > 0
    && row.recent.every((window) =>
      window.n >= 20
      && window.net > 0
      && window.profitFactor >= 1.1
      && window.long > 0
      && window.short > 0))
  .sort((a, b) => b.stress - a.stress);
const best = [...rows].sort((a, b) => b.stress - a.stress);

const print = (row: typeof rows[number]): string =>
  `${row.symbol.padEnd(5)} ${row.rule.padEnd(27)} N${String(row.trades.length).padStart(4)} D${row.coverageDays.toFixed(0).padStart(3)} `
  + `gross ${fmt(row.baseline).padStart(8)} stress ${fmt(row.stress).padStart(8)} PF ${row.stressPf.toFixed(2)} `
  + `DD ${fmt(drawdown(row.trades, STRESS_RT_PCT))} WR ${(row.trades.filter((trade) => tradeNet(trade, STRESS_RT_PCT) > 0).length / row.trades.length * 100).toFixed(1)}% `
  + `L95 ${row.meanL95 >= 0 ? '+' : ''}${row.meanL95.toFixed(4)} `
  + `hold ${median(row.trades.map((trade) => (trade.exitAt - trade.entryAt) / 60_000)).toFixed(0)}m `
  + `f${row.folds}/4 IS/OOS ${fmt(row.is)}/${fmt(row.oos)} L/S ${fmt(row.long)}/${fmt(row.short)} `
  + row.recent.map((window) =>
    `W${window.days} n${window.n} ${fmt(window.net)}/PF${window.profitFactor.toFixed(2)}`).join(' ');

console.log(`Native Lighter ${BAR_MINUTES}m · ${[...loaded.keys()].join(', ')} · ${LOOKBACK_DAYS || 'all-cache'}d · zero commission · ${STRESS_RT_PCT}% RT stress + ${FUNDING_PER_HOUR_PCT}%/h adverse funding`);
console.log(`\nQUALIFIED (${qualified.length})`);
console.log(qualified.length ? qualified.slice(0, 30).map(print).join('\n') : '— none —');
console.log('\nTOP 30 (including failures)');
console.log(best.slice(0, 30).map(print).join('\n'));

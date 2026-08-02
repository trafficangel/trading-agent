#!/usr/bin/env tsx

/**
 * Prove that the live runner's bounded 2,000-bar EMA seed produces the same
 * completed-bar entry decisions as the full-history research calculation for
 * the active frozen regime-qualified oscillator-confluence candidate.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  evaluateBollingerWilliamsReclaim,
  evaluateRsiWilliamsTrend,
  evaluateVwzWilliamsTrend,
  evaluateVwzStochasticTrend,
  type BollingerWilliamsReclaimSnapshot,
  type RsiWilliamsSnapshot,
  type VwzWilliamsSnapshot,
  type VwzStochasticSnapshot,
} from '../src/lib/lighter-oscillator-confluence.js';
import { aggregateCompleteNativeBars } from '../src/lib/lighter-native-timeframe.js';
import type { Vwz60Bar, Z60Signal } from '../src/lib/lighter-z60.js';

const RUNTIME_BARS = Number(process.env.RUNTIME_BARS ?? 2_000);
const BAR_MS = 300_000;

type RawBar = { t: number; h: number; l: number; c: number; v?: number };
type ConfluenceSnapshot = BollingerWilliamsReclaimSnapshot | RsiWilliamsSnapshot | VwzWilliamsSnapshot | VwzStochasticSnapshot;
type AuditConfig = {
  strategyId: string;
  symbol: string;
  path: string;
  sourceMinutes?: 1 | 5;
  evaluate: (bars: readonly Vwz60Bar[]) => ConfluenceSnapshot | null;
  fullSignal: (
    snapshot: ConfluenceSnapshot,
    fullEma: number,
  ) => Z60Signal;
};

function fullEma400(bars: readonly Vwz60Bar[]): number[] {
  const alpha = 2 / 401;
  const values = new Array<number>(bars.length);
  values[0] = bars[0]!.close;
  for (let index = 1; index < bars.length; index += 1) {
    values[index] = bars[index]!.close * alpha + values[index - 1]! * (1 - alpha);
  }
  return values;
}

function readBars(path: string, sourceMinutes: 1 | 5): Vwz60Bar[] {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as RawBar[];
  if (!Array.isArray(raw) || raw.length < RUNTIME_BARS) {
    throw new Error(`${path}: insufficient candles`);
  }
  const bars = raw.map((bar) => ({
    time: Number(bar.t),
    high: Number(bar.h),
    low: Number(bar.l),
    close: Number(bar.c),
    volume: Number(bar.v ?? 0),
  }));
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (
      !Number.isFinite(bar.time)
      || !Number.isFinite(bar.high)
      || !Number.isFinite(bar.low)
      || !Number.isFinite(bar.close)
      || !Number.isFinite(bar.volume)
      || !(bar.high! >= bar.low!)
      || !(bar.close > 0)
      || bar.volume < 0
      || (index > 0 && bar.time - bars[index - 1]!.time !== sourceMinutes * 60_000)
    ) throw new Error(`${path}: invalid or non-gap-free candle at ${index}`);
  }
  if (sourceMinutes === 5) return bars;
  const latest = Math.floor(bars.at(-1)!.time / BAR_MS) * BAR_MS;
  const aggregated = aggregateCompleteNativeBars(raw, 5, latest);
  for (let index = 1; index < aggregated.length; index += 1) {
    if (aggregated[index]!.time - aggregated[index - 1]!.time !== BAR_MS) {
      throw new Error(`${path}: aggregated 5m series is not gap-free at ${index}`);
    }
  }
  return aggregated;
}

const configs: readonly AuditConfig[] = [
  {
    strategyId: 'hype-bb20-willr14-reclaim-ema400-challenger',
    symbol: 'HYPE',
    path: 'data/lighter-klines/HYPE-1m.json',
    sourceMinutes: 1,
    evaluate: (bars) => evaluateBollingerWilliamsReclaim(bars),
    fullSignal(snapshot, fullEma) {
      const value = snapshot as BollingerWilliamsReclaimSnapshot;
      if (
        value.previousClose < value.previousLower
        && value.close >= value.lower
        && value.currentWilliams < -80
        && value.close > fullEma
      ) return 'long';
      if (
        value.previousClose > value.previousUpper
        && value.close <= value.upper
        && value.currentWilliams > -20
        && value.close < fullEma
      ) return 'short';
      return null;
    },
  },
  {
    strategyId: 'hype-vwz60-stoch14-ema400-challenger',
    symbol: 'HYPE',
    path: 'data/lighter-klines/HYPE-1m.json',
    sourceMinutes: 1,
    evaluate: (bars) => evaluateVwzStochasticTrend(bars),
    fullSignal(snapshot, fullEma) {
      const value = snapshot as VwzStochasticSnapshot;
      if (value.currentZ < -2.25 && value.currentStochastic < 20 && value.close > fullEma) {
        return 'long';
      }
      if (value.currentZ > 2.25 && value.currentStochastic > 80 && value.close < fullEma) {
        return 'short';
      }
      return null;
    },
  },
  {
    strategyId: 'zec-rsi14-willr14-ema400',
    symbol: 'ZEC',
    path: 'data/lighter-klines/ZEC-5m.json',
    evaluate: (bars) => evaluateRsiWilliamsTrend(bars),
    fullSignal(snapshot, fullEma) {
      const value = snapshot as RsiWilliamsSnapshot;
      if (value.currentRsi < 30 && value.currentWilliams < -80 && value.close > fullEma) {
        return 'long';
      }
      if (value.currentRsi > 70 && value.currentWilliams > -20 && value.close < fullEma) {
        return 'short';
      }
      return null;
    },
  },
  {
    strategyId: 'xlm-vwz60-willr14-ema400-challenger',
    symbol: 'XLM',
    path: 'data/lighter-klines/XLM-1m.json',
    sourceMinutes: 1,
    evaluate: (bars) => evaluateVwzWilliamsTrend(bars),
    fullSignal(snapshot, fullEma) {
      const value = snapshot as VwzWilliamsSnapshot;
      if (value.currentZ < -2.5 && value.currentWilliams < -80 && value.close > fullEma) {
        return 'long';
      }
      if (value.currentZ > 2.5 && value.currentWilliams > -20 && value.close < fullEma) {
        return 'short';
      }
      return null;
    },
  },
];

const results = configs.map((config) => {
  const bars = readBars(config.path, config.sourceMinutes ?? 5);
  const fullEma = fullEma400(bars);
  let comparableBars = 0;
  let fullSignals = 0;
  let runtimeSignals = 0;
  let signalMismatches = 0;
  let trendSideMismatches = 0;
  let maxEmaDifferencePct = 0;
  const firstMismatches: Array<Record<string, unknown>> = [];
  for (let index = RUNTIME_BARS - 1; index < bars.length; index += 1) {
    const snapshot = config.evaluate(bars.slice(index - RUNTIME_BARS + 1, index + 1));
    if (!snapshot) throw new Error(`${config.strategyId}: runtime evaluator failed at ${index}`);
    const runtimeEma = snapshot.trendMean;
    if (runtimeEma == null) {
      throw new Error(`${config.strategyId}: runtime EMA missing at ${index}`);
    }
    comparableBars += 1;
    const expected = config.fullSignal(snapshot, fullEma[index]!);
    const actual = snapshot.signal;
    if (expected) fullSignals += 1;
    if (actual) runtimeSignals += 1;
    const fullAbove = snapshot.close > fullEma[index]!;
    const runtimeAbove = snapshot.close > runtimeEma;
    if (fullAbove !== runtimeAbove) trendSideMismatches += 1;
    const differencePct = Math.abs(runtimeEma - fullEma[index]!)
      / fullEma[index]! * 100;
    maxEmaDifferencePct = Math.max(maxEmaDifferencePct, differencePct);
    if (expected !== actual) {
      signalMismatches += 1;
      if (firstMismatches.length < 10) {
        firstMismatches.push({
          time: snapshot.barTime,
          expected,
          actual,
          close: snapshot.close,
          fullEma: fullEma[index],
          runtimeEma,
        });
      }
    }
  }
  return {
    strategyId: config.strategyId,
    symbol: config.symbol,
    candles: bars.length,
    comparableBars,
    runtimeWindowBars: RUNTIME_BARS,
    fullSignals,
    runtimeSignals,
    signalMismatches,
    trendSideMismatches,
    maxEmaDifferencePct,
    firstMismatches,
    passed: signalMismatches === 0,
  };
});

const report = {
  version: 'lighter-confluence-runtime-parity-v1',
  generatedAt: new Date().toISOString(),
  barMinutes: 5,
  completedBarsOnly: true,
  runtimeWindowBars: RUNTIME_BARS,
  passed: results.every((result) => result.passed),
  results,
};
const serialized = JSON.stringify(report, null, 2);
const outputPath = process.env['OUTPUT_JSON'];
if (outputPath) {
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp`;
  writeFileSync(temporary, serialized);
  renameSync(temporary, absolute);
}
console.warn(serialized);
if (!report.passed) process.exitCode = 1;

/**
 * Causal 5m Native Quant latency audit using native 1m candles for fills.
 *
 * Signals are evaluated from the same trailing 2,000 completed 5m bars as the
 * production runner. Baseline fills at the next 5m open; the delayed scenario
 * fills one native minute later, conservatively approximating the observed
 * 30–41 second signal-close -> L2 capture path. Stops are checked on every 1m
 * candle, execution uses market-specific $100 p95 round-trip cost, and funding
 * uses exact hourly settlements.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  lighterFundingPnlPct,
  type LighterFundingPoint,
} from '../src/lib/lighter-funding-history.js';
import {
  evaluateRsiWilliamsTrend,
  evaluateVwzMfiTrend,
  rsiWilliamsExit,
} from '../src/lib/lighter-oscillator-confluence.js';
import type { Vwz60Bar } from '../src/lib/lighter-z60.js';

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const HISTORY_BARS = 2_000;
const MAX_HOLD_BARS = 120;
const STOP_PCT = 0.01;
const POSITION_NOTIONAL_USD = 100;
const OUTPUT_JSON = resolve(
  process.env.OUTPUT_JSON ?? 'data/lighter-native-entry-delay-audit.json',
);
const KLINES_DIR = resolve(process.env.LIGHTER_KLINES_DIR ?? 'data/lighter-klines');

type RawCandle = { t: number | string; o: number | string; h: number | string; l: number | string; c: number | string; v?: number | string };
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Side = 'long' | 'short';
type Decision = {
  barTime: number;
  signal: Side | null;
  exitLong: boolean;
  exitShort: boolean;
};
type Trade = {
  side: Side;
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  grossPct: number;
  fundingPct: number;
  netPct: number;
  closeReason: 'indicator' | 'time' | 'stop' | 'end';
};
type StrategyConfig = {
  strategyId: string;
  symbol: string;
  fundingFile: string;
  executionCostFile: string;
  evaluate: (bars: readonly Vwz60Bar[]) => {
    signal: Side | null;
    exitLong: boolean;
    exitShort: boolean;
  } | null;
};

const STRATEGIES: readonly StrategyConfig[] = [
  {
    strategyId: 'zec-rsi14-willr14-ema400',
    symbol: 'ZEC',
    fundingFile: 'data/lighter-funding-history-zec-direct-20260801.json',
    executionCostFile: 'data/lighter-execution-costs-native-portfolio-100-20260731.json',
    evaluate(bars) {
      const snapshot = evaluateRsiWilliamsTrend(bars, 14, 30, 14, 20, 400);
      return snapshot ? {
        signal: snapshot.signal,
        exitLong: rsiWilliamsExit(snapshot, 'long'),
        exitShort: rsiWilliamsExit(snapshot, 'short'),
      } : null;
    },
  },
  {
    strategyId: 'data-vwz60-mfi14-ema400',
    symbol: 'DATA',
    fundingFile: 'data/lighter-funding-history-transfer6-20260801.json',
    executionCostFile: 'data/lighter-execution-costs-transfer6-20260801.json',
    evaluate(bars) {
      const snapshot = evaluateVwzMfiTrend(bars, 60, 2.5, 14, 35, 400);
      return snapshot ? {
        signal: snapshot.signal,
        exitLong: snapshot.close >= snapshot.mean,
        exitShort: snapshot.close <= snapshot.mean,
      } : null;
    },
  },
];

function candles(file: string): Candle[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RawCandle[];
  const normalized = parsed.map((row) => ({
    t: Number(row.t), o: Number(row.o), h: Number(row.h), l: Number(row.l),
    c: Number(row.c), v: Number(row.v ?? 0),
  })).filter((row) =>
    Number.isFinite(row.t) && Number.isFinite(row.o) && row.o > 0
    && Number.isFinite(row.h) && Number.isFinite(row.l) && row.h >= row.l
    && Number.isFinite(row.c) && row.c > 0 && Number.isFinite(row.v) && row.v >= 0)
    .sort((a, b) => a.t - b.t);
  const deduped = [...new Map(normalized.map((row) => [row.t, row])).values()];
  if (!deduped.length) throw new Error(`${file}: no valid candles`);
  return deduped;
}

function requireGapFree(source: readonly Candle[], stepMs: number, label: string): void {
  for (let index = 1; index < source.length; index += 1) {
    if (source[index]!.t - source[index - 1]!.t !== stepMs) {
      throw new Error(
        `${label}: gap ${new Date(source[index - 1]!.t).toISOString()} -> ${new Date(source[index]!.t).toISOString()}`,
      );
    }
  }
}

function executionCost(config: StrategyConfig): number {
  const parsed = JSON.parse(readFileSync(resolve(config.executionCostFile), 'utf8')) as {
    notionalUsd?: number;
    summaries?: Record<string, { p95Pct?: number }>;
  };
  if (parsed.notionalUsd !== POSITION_NOTIONAL_USD) {
    throw new Error(`${config.symbol}: execution cost notional is not $100`);
  }
  const value = parsed.summaries?.[config.symbol]?.p95Pct;
  if (value == null || !Number.isFinite(value) || value < 0) {
    throw new Error(`${config.symbol}: measured p95 execution cost missing`);
  }
  return value;
}

function funding(config: StrategyConfig, start: number, end: number) {
  const parsed = JSON.parse(readFileSync(resolve(config.fundingFile), 'utf8')) as {
    symbols?: Record<string, { fundings?: LighterFundingPoint[] }>;
  };
  const series = buildLighterFundingSeries(parsed.symbols?.[config.symbol]?.fundings ?? []);
  const coverage = fundingSeriesCoverage(series, start, end);
  if (!coverage.covered) {
    throw new Error(`${config.symbol}: funding coverage ${(coverage.internalCoverage * 100).toFixed(2)}%`);
  }
  return { series, coverage };
}

function fundingBounds(config: StrategyConfig): { first: number; last: number } {
  const parsed = JSON.parse(readFileSync(resolve(config.fundingFile), 'utf8')) as {
    symbols?: Record<string, { fundings?: LighterFundingPoint[] }>;
  };
  const points = [...(parsed.symbols?.[config.symbol]?.fundings ?? [])]
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const first = points[0]?.timestampMs;
  const last = points.at(-1)?.timestampMs;
  if (first == null || last == null || !(last > first)) {
    throw new Error(`${config.symbol}: funding bounds missing`);
  }
  return { first, last };
}

function decisions(config: StrategyConfig, fiveMinute: readonly Candle[]): Decision[] {
  const bars: Vwz60Bar[] = fiveMinute.map((row) => ({
    time: row.t, close: row.c, high: row.h, low: row.l, volume: row.v,
  }));
  const result: Decision[] = [];
  for (let index = HISTORY_BARS - 1; index < bars.length; index += 1) {
    const snapshot = config.evaluate(bars.slice(index - HISTORY_BARS + 1, index + 1));
    if (!snapshot) throw new Error(`${config.symbol}: evaluator failed at ${bars[index]!.time}`);
    result.push({ barTime: bars[index]!.time, ...snapshot });
  }
  return result;
}

function grossPct(side: Side, entry: number, exit: number): number {
  return side === 'long' ? (exit / entry - 1) * 100 : (entry / exit - 1) * 100;
}

function simulate(
  config: StrategyConfig,
  oneMinute: readonly Candle[],
  strategyDecisions: readonly Decision[],
  delayMinutes: number,
  costPct: number,
  fundingSeries: ReturnType<typeof buildLighterFundingSeries>,
): Trade[] {
  const byActionTime = new Map(strategyDecisions.map((decision) => [
    decision.barTime + FIVE_MINUTES_MS + delayMinutes * MINUTE_MS,
    decision,
  ]));
  const firstAction = strategyDecisions[0]!.barTime + FIVE_MINUTES_MS + delayMinutes * MINUTE_MS;
  const lastAction = strategyDecisions.at(-1)!.barTime + FIVE_MINUTES_MS + delayMinutes * MINUTE_MS;
  const minutes = oneMinute.filter((bar) => bar.t >= firstAction && bar.t <= lastAction);
  const minuteTimes = new Set(minutes.map((bar) => bar.t));
  for (const actionTime of byActionTime.keys()) {
    if (!minuteTimes.has(actionTime)) {
      throw new Error(`${config.symbol}: missing 1m execution candle ${new Date(actionTime).toISOString()}`);
    }
  }

  let position: { side: Side; entryAt: number; entryPrice: number } | null = null;
  let lastStopBucket: number | null = null;
  const trades: Trade[] = [];
  const close = (bar: Candle, exitPrice: number, reason: Trade['closeReason']) => {
    if (!position) return;
    const gross = grossPct(position.side, position.entryPrice, exitPrice);
    const fundingPct = lighterFundingPnlPct(
      fundingSeries, position.side, position.entryAt, bar.t,
    );
    trades.push({
      side: position.side,
      entryAt: position.entryAt,
      exitAt: bar.t,
      entryPrice: position.entryPrice,
      exitPrice,
      grossPct: gross,
      fundingPct,
      netPct: gross - costPct + fundingPct,
      closeReason: reason,
    });
    position = null;
  };

  for (const minute of minutes) {
    const decision = byActionTime.get(minute.t);
    if (decision) {
      if (position) {
        const indicatorExit = position.side === 'long'
          ? decision.exitLong : decision.exitShort;
        const timedOut = decision.barTime + FIVE_MINUTES_MS - position.entryAt
          >= MAX_HOLD_BARS * FIVE_MINUTES_MS;
        if (indicatorExit || timedOut) close(minute, minute.o, indicatorExit ? 'indicator' : 'time');
      }
      if (
        !position
        && decision.signal
        && lastStopBucket !== decision.barTime
      ) {
        position = { side: decision.signal, entryAt: minute.t, entryPrice: minute.o };
      }
    }
    if (position) {
      const stop = position.side === 'long'
        ? position.entryPrice * (1 - STOP_PCT)
        : position.entryPrice * (1 + STOP_PCT);
      const stopped = position.side === 'long' ? minute.l <= stop : minute.h >= stop;
      if (stopped) {
        const fill = position.side === 'long' ? Math.min(stop, minute.o) : Math.max(stop, minute.o);
        lastStopBucket = Math.floor(minute.t / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
        close(minute, fill, 'stop');
      }
    }
  }
  if (position && minutes.length) close(minutes.at(-1)!, minutes.at(-1)!.c, 'end');
  return trades;
}

function metrics(trades: readonly Trade[]) {
  const values = trades.map((trade) => trade.netPct);
  const gains = values.filter((value) => value >= 0).reduce((a, b) => a + b, 0);
  const losses = -values.filter((value) => value < 0).reduce((a, b) => a + b, 0);
  const net = values.reduce((a, b) => a + b, 0);
  const mean = net / Math.max(1, values.length);
  const variance = values.length > 1
    ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  const cut = Math.floor(values.length * 0.7);
  const foldSize = Math.floor(values.length / 4);
  const folds = Array.from({ length: 4 }, (_, index) =>
    values.slice(index * foldSize, index === 3 ? undefined : (index + 1) * foldSize)
      .reduce((a, b) => a + b, 0));
  const latest = Math.max(0, ...trades.map((trade) => trade.exitAt));
  const recent = [30, 60, 90].map((days) => {
    const selected = trades.filter((trade) => trade.entryAt >= latest - days * 86_400_000);
    const pnl = selected.map((trade) => trade.netPct);
    const win = pnl.filter((value) => value >= 0).reduce((a, b) => a + b, 0);
    const loss = -pnl.filter((value) => value < 0).reduce((a, b) => a + b, 0);
    return {
      days,
      trades: selected.length,
      netPctUnits: pnl.reduce((a, b) => a + b, 0),
      profitFactor: loss ? win / loss : win > 0 ? 99 : 0,
      longPctUnits: selected.filter((trade) => trade.side === 'long').reduce((a, b) => a + b.netPct, 0),
      shortPctUnits: selected.filter((trade) => trade.side === 'short').reduce((a, b) => a + b.netPct, 0),
    };
  });
  return {
    trades: trades.length,
    netPctUnits: net,
    netUsd: net * POSITION_NOTIONAL_USD / 100,
    profitFactor: losses ? gains / losses : gains > 0 ? 99 : 0,
    winRatePct: values.filter((value) => value > 0).length / Math.max(1, values.length) * 100,
    maxDrawdownPct: drawdown,
    meanL95Pct: mean - 1.645 * Math.sqrt(variance / Math.max(1, values.length)),
    positiveFolds: folds.filter((value) => value > 0).length,
    foldNets: folds,
    inSamplePctUnits: values.slice(0, cut).reduce((a, b) => a + b, 0),
    outOfSamplePctUnits: values.slice(cut).reduce((a, b) => a + b, 0),
    longPctUnits: trades.filter((trade) => trade.side === 'long').reduce((a, b) => a + b.netPct, 0),
    shortPctUnits: trades.filter((trade) => trade.side === 'short').reduce((a, b) => a + b.netPct, 0),
    fundingPctUnits: trades.reduce((a, b) => a + b.fundingPct, 0),
    closeReasons: Object.fromEntries(['indicator', 'time', 'stop', 'end'].map((reason) => [
      reason, trades.filter((trade) => trade.closeReason === reason).length,
    ])),
    recent,
  };
}

const audits = STRATEGIES.map((config) => {
  const bounds = fundingBounds(config);
  // A delayed fill needs the minute after the next 5m open. Exclude the
  // unresolved tail rather than inventing funding beyond the last settlement.
  const fiveMinute = candles(resolve(KLINES_DIR, `${config.symbol}-5m.json`))
    .filter((bar) => bar.t + FIVE_MINUTES_MS + MINUTE_MS <= bounds.last);
  const oneMinute = candles(resolve(KLINES_DIR, `${config.symbol}-1m.json`))
    .filter((bar) => bar.t >= bounds.first && bar.t <= bounds.last);
  requireGapFree(fiveMinute, FIVE_MINUTES_MS, `${config.symbol}-5m`);
  requireGapFree(oneMinute, MINUTE_MS, `${config.symbol}-1m`);
  const strategyDecisions = decisions(config, fiveMinute);
  const first = strategyDecisions[0]!.barTime + FIVE_MINUTES_MS;
  const last = strategyDecisions.at(-1)!.barTime + FIVE_MINUTES_MS + MINUTE_MS;
  const costPct = executionCost(config);
  const fundingInput = funding(config, first, last);
  const baselineTrades = simulate(
    config, oneMinute, strategyDecisions, 0, costPct, fundingInput.series,
  );
  const delayedTrades = simulate(
    config, oneMinute, strategyDecisions, 1, costPct, fundingInput.series,
  );
  const baseline = metrics(baselineTrades);
  const delayed = metrics(delayedTrades);
  const retention = baseline.netPctUnits > 0
    ? delayed.netPctUnits / baseline.netPctUnits : Number.NEGATIVE_INFINITY;
  const passed = delayed.trades >= 30
    && delayed.netPctUnits > 0
    && delayed.profitFactor >= 1.2
    && delayed.meanL95Pct > 0
    && delayed.positiveFolds >= 3
    && delayed.inSamplePctUnits > 0
    && delayed.outOfSamplePctUnits > 0
    && delayed.longPctUnits > 0
    && delayed.shortPctUnits > 0
    && delayed.maxDrawdownPct >= -15
    && retention >= 0.5
    && delayed.recent.every((window) =>
      window.trades >= 20
      && window.netPctUnits > 0
      && window.profitFactor >= 1.1
      && window.longPctUnits > 0
      && window.shortPctUnits > 0);
  return {
    strategyId: config.strategyId,
    symbol: config.symbol,
    passed,
    executionCostP95Pct: costPct,
    fundingCoverage: fundingInput.coverage,
    candleCoverage: {
      fiveMinuteBars: fiveMinute.length,
      oneMinuteBars: oneMinute.length,
      first: new Date(first).toISOString(),
      last: new Date(last).toISOString(),
    },
    observedProductionDelaySeconds: { minimum: 30, maximum: 41 },
    baselineNextOpen: baseline,
    delayedOneMinute: delayed,
    delayedNetRetention: retention,
  };
});

const output = {
  version: 'lighter-native-entry-delay-audit-v1',
  generatedAt: new Date().toISOString(),
  assumptions: {
    signalHistoryBars: HISTORY_BARS,
    baselineDelayMinutes: 0,
    delayedScenarioMinutes: 1,
    stopPct: STOP_PCT * 100,
    maxHoldBars: MAX_HOLD_BARS,
    notionalUsd: POSITION_NOTIONAL_USD,
    commissionPct: 0,
    delayedFill: 'native 1m open one minute after the next 5m open',
    stopFill: '1m intrabar stop, gap-through filled at worse 1m open',
    qualification: 'net>0 PF>=1.2 L95>0 3/4 folds IS/OOS and both sides positive DD<=15%, recent windows positive, >=50% baseline net retained',
  },
  passed: audits.every((audit) => audit.passed),
  strategies: audits,
};
mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
const temporary = `${OUTPUT_JSON}.tmp`;
writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`);
renameSync(temporary, OUTPUT_JSON);
console.warn(JSON.stringify({
  output: OUTPUT_JSON,
  passed: output.passed,
  strategies: audits.map((audit) => ({
    strategyId: audit.strategyId,
    passed: audit.passed,
    baselineNet: audit.baselineNextOpen.netPctUnits,
    delayedNet: audit.delayedOneMinute.netPctUnits,
    retention: audit.delayedNetRetention,
    delayedPf: audit.delayedOneMinute.profitFactor,
    delayedDrawdown: audit.delayedOneMinute.maxDrawdownPct,
  })),
}, null, 2));

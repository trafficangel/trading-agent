#!/usr/bin/env tsx

/** Frozen, market-neutral cross-sectional reversal test (see validation doc). */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  lighterFundingPnlPct,
  type LighterFundingSeries,
} from '../src/lib/lighter-funding-history.js';

const SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'LTC', 'HYPE', 'ZEC', 'DOGE',
  'NEAR', 'JUP', 'LIT', 'GRAM', 'XMR', 'ENA', 'TAO',
] as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LOOKBACK_MS = HOUR_MS;
const HOLD_MS = HOUR_MS;
const MIN_DISPERSION_PCT = 2;
const PAIR_STOP_PCT = -2;
const NOTIONAL_PER_LEG_USD = 100;
const MIN_PAIRS = 100;

type SymbolName = (typeof SYMBOLS)[number];
type RawCandle = { t: number; o: number; h: number; l: number; c: number; v?: number };
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Cost = { p95Pct: number; maxPct: number };
type Trade = {
  signalAt: number;
  entryAt: number;
  exitAt: number;
  longSymbol: SymbolName;
  shortSymbol: SymbolName;
  dispersionPct: number;
  longGrossPct: number;
  shortGrossPct: number;
  longFundingPct: number;
  shortFundingPct: number;
  longNetPct: number;
  shortNetPct: number;
  pairNetPct: number;
  pairAdverseNetPct: number;
  trendRegime: 'bull' | 'bear' | 'unknown';
  volatilityRegime: 'high' | 'low' | 'unknown';
  closeReason: 'time' | 'pair_stop';
};

type Position = {
  signalAt: number;
  entryAt: number;
  longSymbol: SymbolName;
  shortSymbol: SymbolName;
  longEntry: number;
  shortEntry: number;
  dispersionPct: number;
  trendRegime: Trade['trendRegime'];
  volatilityRegime: Trade['volatilityRegime'];
};

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadOneMinute(symbol: SymbolName, directory: string): Candle[] {
  const rows = JSON.parse(
    readFileSync(resolve(directory, `${symbol}-1m.json`), 'utf8'),
  ) as RawCandle[];
  return rows
    .map((row) => ({
      t: finite(row.t), o: finite(row.o), h: finite(row.h),
      l: finite(row.l), c: finite(row.c), v: finite(row.v) ?? 0,
    }))
    .filter((row): row is Candle =>
      row.t != null && row.t > 0 && row.t % 60_000 === 0
      && row.o != null && row.o > 0 && row.h != null && row.h > 0
      && row.l != null && row.l > 0 && row.c != null && row.c > 0
      && row.v >= 0)
    .sort((left, right) => left.t - right.t);
}

function aggregate(source: Candle[], minutes: 1 | 5): Candle[] {
  if (minutes === 1) return source;
  const barMs = minutes * 60_000;
  const output: Candle[] = [];
  for (let index = 0; index < source.length;) {
    const bucket = Math.floor(source[index]!.t / barMs) * barMs;
    const rows: Candle[] = [];
    while (index < source.length && source[index]!.t < bucket + barMs) {
      rows.push(source[index]!);
      index++;
    }
    if (
      rows.length !== minutes
      || rows.some((row, offset) => row.t !== bucket + offset * 60_000)
    ) continue;
    output.push({
      t: bucket,
      o: rows[0]!.o,
      h: Math.max(...rows.map((row) => row.h)),
      l: Math.min(...rows.map((row) => row.l)),
      c: rows.at(-1)!.c,
      v: rows.reduce((sum, row) => sum + row.v, 0),
    });
  }
  return output;
}

function candleAt(rows: readonly Candle[], timestamp: number): Candle | null {
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle]!;
    if (row.t === timestamp) return row;
    if (row.t < timestamp) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function btcRegimes(
  btc: readonly Candle[],
  signalAt: number,
): Pick<Trade, 'trendRegime' | 'volatilityRegime'> {
  const current = candleAt(btc, signalAt)?.c ?? null;
  const monthAgo = candleAt(btc, signalAt - 30 * DAY_MS)?.c ?? null;
  const trendRegime: Trade['trendRegime'] = current == null || monthAgo == null
    ? 'unknown'
    : current >= monthAgo ? 'bull' : 'bear';

  const hourlyReturns: number[] = [];
  for (let hoursAgo = 720; hoursAgo >= 1; hoursAgo--) {
    const older = candleAt(btc, signalAt - hoursAgo * HOUR_MS)?.c ?? null;
    const newer = candleAt(btc, signalAt - (hoursAgo - 1) * HOUR_MS)?.c ?? null;
    if (older == null || newer == null) return { trendRegime, volatilityRegime: 'unknown' };
    hourlyReturns.push(Math.log(newer / older));
  }
  const recentVol = standardDeviation(hourlyReturns.slice(-168));
  const baselineVol = standardDeviation(hourlyReturns);
  const volatilityRegime: Trade['volatilityRegime'] = recentVol == null || baselineVol == null
    ? 'unknown'
    : recentVol >= baselineVol ? 'high' : 'low';
  return { trendRegime, volatilityRegime };
}

function loadCosts(path: string): Map<SymbolName, Cost> {
  const body = JSON.parse(readFileSync(path, 'utf8')) as {
    notionalUsd?: number;
    summaries?: Record<string, { p95Pct?: number; maxPct?: number }>;
  };
  if (body.notionalUsd !== NOTIONAL_PER_LEG_USD) {
    throw new Error(`execution cost notional ${body.notionalUsd} != $${NOTIONAL_PER_LEG_USD}`);
  }
  const result = new Map<SymbolName, Cost>();
  for (const symbol of SYMBOLS) {
    const row = body.summaries?.[symbol];
    const p95Pct = finite(row?.p95Pct);
    const maxPct = finite(row?.maxPct);
    if (p95Pct == null || maxPct == null || p95Pct < 0 || maxPct < p95Pct) {
      throw new Error(`${symbol}: invalid measured execution costs`);
    }
    result.set(symbol, { p95Pct, maxPct });
  }
  return result;
}

function loadFunding(path: string): Map<SymbolName, LighterFundingSeries> {
  const body = JSON.parse(readFileSync(path, 'utf8')) as {
    symbols?: Record<string, { fundings?: Array<{
      timestampMs: number;
      ratePctH: number;
      direction: 'long' | 'short';
    }> }>;
  };
  const result = new Map<SymbolName, LighterFundingSeries>();
  for (const symbol of SYMBOLS) {
    const points = body.symbols?.[symbol]?.fundings;
    if (!Array.isArray(points)) throw new Error(`${symbol}: funding history missing`);
    result.set(symbol, buildLighterFundingSeries(points));
  }
  return result;
}

function pricePnl(side: 'long' | 'short', entry: number, exit: number): number {
  return side === 'long' ? (exit / entry - 1) * 100 : (entry / exit - 1) * 100;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function profitFactor(values: readonly number[]): number {
  const gains = sum(values.filter((value) => value > 0));
  const losses = Math.abs(sum(values.filter((value) => value < 0)));
  return losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : 0;
}

function drawdown(values: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function meanL95(values: readonly number[]): number {
  if (!values.length) return Number.NEGATIVE_INFINITY;
  const mean = sum(values) / values.length;
  const deviation = standardDeviation(values) ?? 0;
  return mean - 1.645 * deviation / Math.sqrt(values.length);
}

function positiveFolds(values: readonly number[], folds = 4): number {
  let positive = 0;
  for (let fold = 0; fold < folds; fold++) {
    const start = Math.floor(values.length * fold / folds);
    const end = Math.floor(values.length * (fold + 1) / folds);
    if (sum(values.slice(start, end)) > 0) positive++;
  }
  return positive;
}

function segmentNet(
  trades: readonly Trade[],
  predicate: (trade: Trade) => boolean,
): { n: number; netPct: number; profitFactor: number } {
  const values = trades.filter(predicate).map((trade) => trade.pairNetPct);
  return { n: values.length, netPct: sum(values), profitFactor: profitFactor(values) };
}

function run(minutes: 1 | 5, klinesDir: string, costs: Map<SymbolName, Cost>, funding: Map<SymbolName, LighterFundingSeries>) {
  const barMs = minutes * 60_000;
  const series = new Map<SymbolName, Candle[]>();
  for (const symbol of SYMBOLS) {
    series.set(symbol, aggregate(loadOneMinute(symbol, klinesDir), minutes));
  }
  const commonStart = Math.max(...SYMBOLS.map((symbol) => series.get(symbol)![0]!.t));
  const commonEnd = Math.min(...SYMBOLS.map((symbol) => series.get(symbol)!.at(-1)!.t));
  for (const symbol of SYMBOLS) {
    const coverage = fundingSeriesCoverage(funding.get(symbol)!, commonStart, commonEnd);
    if (!coverage.covered) {
      throw new Error(`${symbol}: funding coverage ${(coverage.internalCoverage * 100).toFixed(2)}% insufficient`);
    }
  }

  const clock = series.get('BTC')!;
  const trades: Trade[] = [];
  let position: Position | null = null;
  for (const bar of clock) {
    if (bar.t < commonStart + LOOKBACK_MS || bar.t > commonEnd - barMs) continue;

    if (position && bar.t >= position.entryAt) {
      const longClose = candleAt(series.get(position.longSymbol)!, bar.t)?.c ?? null;
      const shortClose = candleAt(series.get(position.shortSymbol)!, bar.t)?.c ?? null;
      if (longClose != null && shortClose != null) {
        const markedPair = (
          pricePnl('long', position.longEntry, longClose)
          + pricePnl('short', position.shortEntry, shortClose)
        ) / 2;
        const dueToStop = markedPair <= PAIR_STOP_PCT;
        const dueToTime = bar.t + barMs >= position.entryAt + HOLD_MS;
        if (dueToStop || dueToTime) {
          const exitAt = bar.t + barMs;
          const longExit = candleAt(series.get(position.longSymbol)!, exitAt)?.o ?? null;
          const shortExit = candleAt(series.get(position.shortSymbol)!, exitAt)?.o ?? null;
          if (longExit != null && shortExit != null) {
            const longGrossPct = pricePnl('long', position.longEntry, longExit);
            const shortGrossPct = pricePnl('short', position.shortEntry, shortExit);
            const longFundingPct = lighterFundingPnlPct(
              funding.get(position.longSymbol)!, 'long', position.entryAt, exitAt,
            );
            const shortFundingPct = lighterFundingPnlPct(
              funding.get(position.shortSymbol)!, 'short', position.entryAt, exitAt,
            );
            const longCost = costs.get(position.longSymbol)!;
            const shortCost = costs.get(position.shortSymbol)!;
            const longNetPct = longGrossPct + longFundingPct - longCost.p95Pct;
            const shortNetPct = shortGrossPct + shortFundingPct - shortCost.p95Pct;
            trades.push({
              ...position,
              exitAt,
              longGrossPct,
              shortGrossPct,
              longFundingPct,
              shortFundingPct,
              longNetPct,
              shortNetPct,
              pairNetPct: (longNetPct + shortNetPct) / 2,
              pairAdverseNetPct: (
                longGrossPct + longFundingPct - longCost.maxPct
                + shortGrossPct + shortFundingPct - shortCost.maxPct
              ) / 2,
              closeReason: dueToStop ? 'pair_stop' : 'time',
            });
            position = null;
          }
        }
      }
    }

    if (position || (bar.t + barMs) % HOUR_MS !== 0) continue;
    const returns: Array<{ symbol: SymbolName; value: number }> = [];
    for (const symbol of SYMBOLS) {
      const current = candleAt(series.get(symbol)!, bar.t)?.c ?? null;
      const previous = candleAt(series.get(symbol)!, bar.t - LOOKBACK_MS)?.c ?? null;
      if (current == null || previous == null) break;
      returns.push({ symbol, value: (current / previous - 1) * 100 });
    }
    if (returns.length !== SYMBOLS.length) continue;
    returns.sort((left, right) => left.value - right.value);
    const loser = returns[0]!;
    const winner = returns.at(-1)!;
    const dispersionPct = winner.value - loser.value;
    if (dispersionPct < MIN_DISPERSION_PCT || loser.symbol === winner.symbol) continue;
    const entryAt = bar.t + barMs;
    const longEntry = candleAt(series.get(loser.symbol)!, entryAt)?.o ?? null;
    const shortEntry = candleAt(series.get(winner.symbol)!, entryAt)?.o ?? null;
    if (longEntry == null || shortEntry == null) continue;
    const regimes = btcRegimes(clock, bar.t);
    position = {
      signalAt: bar.t,
      entryAt,
      longSymbol: loser.symbol,
      shortSymbol: winner.symbol,
      longEntry,
      shortEntry,
      dispersionPct,
      ...regimes,
    };
  }

  const values = trades.map((trade) => trade.pairNetPct);
  const adverseValues = trades.map((trade) => trade.pairAdverseNetPct);
  const split = Math.floor(trades.length * 0.7);
  const lastAt = trades.at(-1)?.exitAt ?? commonEnd;
  const windows = [30, 60, 90].map((days) => segmentNet(
    trades,
    (trade) => trade.exitAt > lastAt - days * DAY_MS,
  ));
  const months = new Map<string, number>();
  for (const trade of trades) {
    const month = new Date(trade.exitAt).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + trade.pairNetPct);
  }
  const monthRows = [...months].map(([month, netPct]) => ({ month, netPct }));
  const trend = {
    bull: segmentNet(trades, (trade) => trade.trendRegime === 'bull'),
    bear: segmentNet(trades, (trade) => trade.trendRegime === 'bear'),
  };
  const volatility = {
    high: segmentNet(trades, (trade) => trade.volatilityRegime === 'high'),
    low: segmentNet(trades, (trade) => trade.volatilityRegime === 'low'),
  };
  const longLegNetPct = sum(trades.map((trade) => trade.longNetPct));
  const shortLegNetPct = sum(trades.map((trade) => trade.shortNetPct));
  const qualified = trades.length >= MIN_PAIRS
    && sum(values) > 0
    && profitFactor(values) >= 1.2
    && meanL95(values) > 0
    && positiveFolds(values) === 4
    && sum(values.slice(0, split)) > 0
    && sum(values.slice(split)) > 0
    && longLegNetPct > 0
    && shortLegNetPct > 0
    && windows.every((window) => window.netPct > 0)
    && drawdown(values) >= -5
    && monthRows.filter((row) => row.netPct > 0).length >= 5
    && trend.bull.n > 0 && trend.bull.netPct > 0
    && trend.bear.n > 0 && trend.bear.netPct > 0
    && volatility.high.n > 0 && volatility.high.netPct > 0
    && volatility.low.n > 0 && volatility.low.netPct > 0;

  return {
    timeframe: `${minutes}m`,
    commonStart: new Date(commonStart).toISOString(),
    commonEnd: new Date(commonEnd).toISOString(),
    pairs: trades.length,
    netPct: sum(values),
    netUsd: sum(values) * 2,
    profitFactor: profitFactor(values),
    winRatePct: trades.length
      ? values.filter((value) => value > 0).length / trades.length * 100
      : 0,
    meanL95Pct: meanL95(values),
    adverseNetPct: sum(adverseValues),
    adverseProfitFactor: profitFactor(adverseValues),
    maxDrawdownPct: drawdown(values),
    positiveFolds: positiveFolds(values),
    inSampleNetPct: sum(values.slice(0, split)),
    outOfSampleNetPct: sum(values.slice(split)),
    longLegNetPct,
    shortLegNetPct,
    fundingNetPct: sum(trades.map(
      (trade) => (trade.longFundingPct + trade.shortFundingPct) / 2,
    )),
    windows: windows.map((window, index) => ({ days: [30, 60, 90][index], ...window })),
    months: monthRows,
    positiveMonths: monthRows.filter((row) => row.netPct > 0).length,
    trend,
    volatility,
    stopCloses: trades.filter((trade) => trade.closeReason === 'pair_stop').length,
    qualified,
    trades,
  };
}

const klinesDir = resolve(flagValue('--klines') ?? 'data/lighter-klines');
const costPath = resolve(
  flagValue('--costs') ?? 'data/lighter-execution-costs-native-portfolio-100-20260731.json',
);
const fundingPath = resolve(
  flagValue('--funding') ?? 'data/lighter-funding-history-native.json',
);
const outputPath = resolve(
  flagValue('--output') ?? 'data/lighter-cross-sectional-reversal-results.json',
);
const costs = loadCosts(costPath);
const funding = loadFunding(fundingPath);
const results = [run(1, klinesDir, costs, funding), run(5, klinesDir, costs, funding)];
const resultSummaries = results.map(({ trades: _trades, ...summary }) => summary);
const report = {
  version: 'lighter-cross-sectional-reversal-v1-frozen',
  generatedAt: new Date().toISOString(),
  rule: {
    symbols: SYMBOLS,
    lookbackMinutes: 60,
    rebalance: 'final completed candle of each UTC hour',
    minimumDispersionPct: MIN_DISPERSION_PCT,
    holdingMinutes: 60,
    pairStopPct: PAIR_STOP_PCT,
    notionalPerLegUsd: NOTIONAL_PER_LEG_USD,
    execution: 'next-bar open; market-specific measured $100 full-round-trip p95',
    funding: 'exact public hourly settlements in (entry, exit]',
    maximumConcurrentPairs: 1,
  },
  results: resultSummaries,
  admittedToShadow: results.some((result) => result.qualified),
};
atomicWrite(outputPath, report);
for (const result of results) {
  console.log(
    `${result.timeframe}: N${result.pairs} net ${result.netPct.toFixed(2)}% `
    + `PF${result.profitFactor.toFixed(2)} adverse ${result.adverseNetPct.toFixed(2)}% `
    + `L95 ${result.meanL95Pct.toFixed(4)} DD ${result.maxDrawdownPct.toFixed(2)}% `
    + `folds ${result.positiveFolds}/4 IS/OOS ${result.inSampleNetPct.toFixed(2)}/${result.outOfSampleNetPct.toFixed(2)} `
    + `legs ${result.longLegNetPct.toFixed(2)}/${result.shortLegNetPct.toFixed(2)} `
    + `${result.qualified ? 'QUALIFIED' : 'REJECTED'}`,
  );
}
console.log(`→ ${outputPath}`);

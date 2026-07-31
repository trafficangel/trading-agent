#!/usr/bin/env tsx

/** Frozen dynamic pair-spread mean-reversion test (see validation document). */

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
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BETA_DAYS = 30;
const SPREAD_DAYS = 7;
const DECISION_MINUTES = 15;
const HOLD_MINUTES = 6 * 60;
const MIN_CORRELATION = 0.75;
const MIN_BETA = 0.20;
const MAX_BETA = 3.00;
const ENTRY_Z = 3.0;
const STOP_PCT = 2.0;
const PACKAGE_NOTIONAL_USD = 100;
const MIN_PACKAGES = 120;

type SymbolName = (typeof SYMBOLS)[number];
type RawCandle = { t: number; o: number; h: number; l: number; c: number; v?: number };
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Cost = { p95Pct: number; maxPct: number };
type Regime = 'bull' | 'bear' | 'unknown';
type VolatilityRegime = 'high' | 'low' | 'unknown';
type Direction = 'rich_a' | 'rich_b';
type Candidate = {
  a: SymbolName;
  b: SymbolName;
  beta: number;
  correlation: number;
  z: number;
};
type Exposure = { symbol: SymbolName; weight: number; entry: number };
type Position = Candidate & {
  direction: Direction;
  signalAt: number;
  entryAt: number;
  entryIndex: number;
  exposures: Exposure[];
  regime: Regime;
  volatilityRegime: VolatilityRegime;
};
type Trade = Position & {
  exitAt: number;
  grossPct: number;
  fundingPct: number;
  costPct: number;
  adverseCostPct: number;
  netPct: number;
  adverseNetPct: number;
  closeReason: 'stop' | 'time';
};
type Segment = { n: number; netPct: number; profitFactor: number };

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function loadOneMinute(symbol: SymbolName, directory: string): Candle[] {
  const rows = JSON.parse(
    readFileSync(resolve(directory, `${symbol}-1m.json`), 'utf8'),
  ) as RawCandle[];
  const output = rows
    .map((row) => ({
      t: finite(row.t), o: finite(row.o), h: finite(row.h), l: finite(row.l),
      c: finite(row.c), v: finite(row.v) ?? 0,
    }))
    .filter((row): row is Candle =>
      row.t != null && row.t > 0 && row.t % MINUTE_MS === 0
      && row.o != null && row.o > 0 && row.h != null && row.h > 0
      && row.l != null && row.l > 0 && row.c != null && row.c > 0
      && row.v >= 0)
    .sort((left, right) => left.t - right.t);
  for (let index = 1; index < output.length; index++) {
    if (output[index]!.t === output[index - 1]!.t) {
      throw new Error(`${symbol}: duplicate candle at ${output[index]!.t}`);
    }
  }
  return output;
}

function aggregate(source: readonly Candle[], minutes: 1 | 5): Candle[] {
  if (minutes === 1) return [...source];
  const barMs = minutes * MINUTE_MS;
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
      || rows.some((row, offset) => row.t !== bucket + offset * MINUTE_MS)
    ) continue;
    output.push({
      t: bucket,
      o: rows[0]!.o,
      h: Math.max(...rows.map((row) => row.h)),
      l: Math.min(...rows.map((row) => row.l)),
      c: rows.at(-1)!.c,
      v: rows.reduce((total, row) => total + row.v, 0),
    });
  }
  return output;
}

function alignedSeries(
  source: readonly Candle[],
  commonStart: number,
  commonEnd: number,
  barMs: number,
  symbol: SymbolName,
): Candle[] {
  const rows = source.filter((row) => row.t >= commonStart && row.t <= commonEnd);
  const expected = Math.floor((commonEnd - commonStart) / barMs) + 1;
  if (rows.length !== expected) {
    throw new Error(`${symbol}: ${rows.length}/${expected} common bars; gap-free input required`);
  }
  for (let index = 0; index < rows.length; index++) {
    if (rows[index]!.t !== commonStart + index * barMs) {
      throw new Error(`${symbol}: gap at ${new Date(commonStart + index * barMs).toISOString()}`);
    }
  }
  return rows;
}

function loadCosts(path: string): Map<SymbolName, Cost> {
  const body = JSON.parse(readFileSync(path, 'utf8')) as {
    notionalUsd?: number;
    summaries?: Record<string, { p95Pct?: number; maxPct?: number }>;
  };
  if (body.notionalUsd !== PACKAGE_NOTIONAL_USD) {
    throw new Error(`execution cost notional ${body.notionalUsd} != $${PACKAGE_NOTIONAL_USD}`);
  }
  const result = new Map<SymbolName, Cost>();
  for (const symbol of SYMBOLS) {
    const p95Pct = finite(body.summaries?.[symbol]?.p95Pct);
    const maxPct = finite(body.summaries?.[symbol]?.maxPct);
    if (p95Pct == null || maxPct == null || p95Pct < 0 || maxPct < p95Pct) {
      throw new Error(`${symbol}: invalid measured execution cost`);
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

function buildBestCandidates(
  series: Map<SymbolName, Candle[]>,
  length: number,
  betaBars: number,
  spreadBars: number,
  decisionBars: number,
): Array<Candidate | undefined> {
  const best = Array<Candidate | undefined>(length);
  for (let ai = 0; ai < SYMBOLS.length - 1; ai++) {
    const a = SYMBOLS[ai]!;
    const ac = series.get(a)!;
    for (let bi = ai + 1; bi < SYMBOLS.length; bi++) {
      const b = SYMBOLS[bi]!;
      const bc = series.get(b)!;
      let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
      let sla = 0; let slb = 0; let slaa = 0; let slbb = 0; let slab = 0;
      for (let index = 1; index < length - 1; index++) {
        const x = Math.log(bc[index]!.c / bc[index - 1]!.c);
        const y = Math.log(ac[index]!.c / ac[index - 1]!.c);
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (index > betaBars) {
          const remove = index - betaBars;
          const oldX = Math.log(bc[remove]!.c / bc[remove - 1]!.c);
          const oldY = Math.log(ac[remove]!.c / ac[remove - 1]!.c);
          sx -= oldX; sy -= oldY; sxx -= oldX * oldX; syy -= oldY * oldY; sxy -= oldX * oldY;
        }

        const la = Math.log(ac[index]!.c);
        const lb = Math.log(bc[index]!.c);
        sla += la; slb += lb; slaa += la * la; slbb += lb * lb; slab += la * lb;
        if (index >= spreadBars) {
          const remove = index - spreadBars;
          const oldA = Math.log(ac[remove]!.c);
          const oldB = Math.log(bc[remove]!.c);
          sla -= oldA; slb -= oldB; slaa -= oldA * oldA; slbb -= oldB * oldB; slab -= oldA * oldB;
        }

        if (
          index < betaBars || index < spreadBars
          || index % decisionBars !== decisionBars - 1
        ) continue;
        const covariance = sxy - sx * sy / betaBars;
        const varianceX = sxx - sx * sx / betaBars;
        const varianceY = syy - sy * sy / betaBars;
        if (!(varianceX > 0) || !(varianceY > 0)) continue;
        const beta = covariance / varianceX;
        const correlation = covariance / Math.sqrt(varianceX * varianceY);
        if (
          !Number.isFinite(beta) || beta < MIN_BETA || beta > MAX_BETA
          || !Number.isFinite(correlation) || correlation < MIN_CORRELATION
        ) continue;
        const n = spreadBars;
        const spread = la - beta * lb;
        const mean = (sla - beta * slb) / n;
        const sumSquares = slaa - 2 * beta * slab + beta * beta * slbb;
        const variance = Math.max(0, (sumSquares - n * mean * mean) / (n - 1));
        if (!(variance > 0)) continue;
        const z = (spread - mean) / Math.sqrt(variance);
        if (!Number.isFinite(z) || Math.abs(z) < ENTRY_Z) continue;
        if (!best[index] || Math.abs(z) > Math.abs(best[index]!.z)) {
          best[index] = { a, b, beta, correlation, z };
        }
      }
    }
  }
  return best;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = sum(values) / values.length;
  return Math.sqrt(sum(values.map((value) => (value - mean) ** 2)) / (values.length - 1));
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
  return mean - 1.645 * (standardDeviation(values) ?? 0) / Math.sqrt(values.length);
}

function segment(trades: readonly Trade[], predicate: (trade: Trade) => boolean): Segment {
  const values = trades.filter(predicate).map((trade) => trade.netPct);
  return { n: values.length, netPct: sum(values), profitFactor: profitFactor(values) };
}

function positiveFolds(values: readonly number[]): number {
  let positive = 0;
  for (let fold = 0; fold < 4; fold++) {
    const start = Math.floor(values.length * fold / 4);
    const end = Math.floor(values.length * (fold + 1) / 4);
    if (sum(values.slice(start, end)) > 0) positive++;
  }
  return positive;
}

function buildRegimes(btc: readonly Candle[], minutes: 1 | 5): Array<{
  regime: Regime;
  volatilityRegime: VolatilityRegime;
}> {
  const monthBars = 30 * 24 * 60 / minutes;
  const weekBars = 7 * 24 * 60 / minutes;
  const output = Array.from({ length: btc.length }, () => ({
    regime: 'unknown' as Regime,
    volatilityRegime: 'unknown' as VolatilityRegime,
  }));
  const returns = Array(btc.length).fill(Number.NaN) as number[];
  const prefix = Array(btc.length + 1).fill(0) as number[];
  const prefixSq = Array(btc.length + 1).fill(0) as number[];
  for (let index = 1; index < btc.length; index++) {
    returns[index] = Math.log(btc[index]!.c / btc[index - 1]!.c);
    prefix[index + 1] = prefix[index]! + returns[index]!;
    prefixSq[index + 1] = prefixSq[index]! + returns[index]! ** 2;
  }
  const variance = (end: number, bars: number): number => {
    const start = end - bars + 1;
    const total = prefix[end + 1]! - prefix[start]!;
    const totalSq = prefixSq[end + 1]! - prefixSq[start]!;
    return Math.max(0, (totalSq - total * total / bars) / (bars - 1));
  };
  for (let index = monthBars; index < btc.length; index++) {
    output[index] = {
      regime: btc[index]!.c >= btc[index - monthBars]!.c ? 'bull' : 'bear',
      volatilityRegime: variance(index, weekBars) >= variance(index, monthBars) ? 'high' : 'low',
    };
  }
  return output;
}

function run(
  minutes: 1 | 5,
  klinesDir: string,
  costs: Map<SymbolName, Cost>,
  funding: Map<SymbolName, LighterFundingSeries>,
) {
  const barMs = minutes * MINUTE_MS;
  const raw = new Map<SymbolName, Candle[]>();
  for (const symbol of SYMBOLS) raw.set(symbol, aggregate(loadOneMinute(symbol, klinesDir), minutes));
  const commonStart = Math.max(...SYMBOLS.map((symbol) => raw.get(symbol)![0]!.t));
  const commonEnd = Math.min(...SYMBOLS.map((symbol) => raw.get(symbol)!.at(-1)!.t));
  const series = new Map<SymbolName, Candle[]>();
  for (const symbol of SYMBOLS) {
    series.set(symbol, alignedSeries(raw.get(symbol)!, commonStart, commonEnd, barMs, symbol));
    const coverage = fundingSeriesCoverage(funding.get(symbol)!, commonStart, commonEnd);
    if (!coverage.covered) {
      throw new Error(`${symbol}: funding coverage ${(coverage.internalCoverage * 100).toFixed(2)}% insufficient`);
    }
  }
  const btc = series.get('BTC')!;
  const betaBars = BETA_DAYS * 24 * 60 / minutes;
  const spreadBars = SPREAD_DAYS * 24 * 60 / minutes;
  const decisionBars = DECISION_MINUTES / minutes;
  const holdBars = HOLD_MINUTES / minutes;
  const best = buildBestCandidates(series, btc.length, betaBars, spreadBars, decisionBars);
  const regimeRows = buildRegimes(btc, minutes);
  const trades: Trade[] = [];
  let position: Position | null = null;

  for (let index = 0; index < btc.length - 1; index++) {
    if (position && index >= position.entryIndex) {
      let markPct = 0;
      for (const exposure of position.exposures) {
        const mark = series.get(exposure.symbol)![index]!.c;
        markPct += exposure.weight * (mark / exposure.entry - 1) * 100;
      }
      const stop = markPct <= -STOP_PCT;
      const time = index + 1 - position.entryIndex >= holdBars;
      if (stop || time) {
        const exitIndex = index + 1;
        const exitAt = btc[exitIndex]!.t;
        let grossPct = 0;
        let fundingPct = 0;
        let costPct = 0;
        let adverseCostPct = 0;
        for (const exposure of position.exposures) {
          const exit = series.get(exposure.symbol)![exitIndex]!.o;
          grossPct += exposure.weight * (exit / exposure.entry - 1) * 100;
          const side = exposure.weight >= 0 ? 'long' : 'short';
          fundingPct += Math.abs(exposure.weight) * lighterFundingPnlPct(
            funding.get(exposure.symbol)!, side, position.entryAt, exitAt,
          );
          costPct += Math.abs(exposure.weight) * costs.get(exposure.symbol)!.p95Pct;
          adverseCostPct += Math.abs(exposure.weight) * costs.get(exposure.symbol)!.maxPct;
        }
        trades.push({
          ...position,
          exitAt,
          grossPct,
          fundingPct,
          costPct,
          adverseCostPct,
          netPct: grossPct + fundingPct - costPct,
          adverseNetPct: grossPct + fundingPct - adverseCostPct,
          closeReason: stop ? 'stop' : 'time',
        });
        position = null;
      }
    }

    if (position) continue;
    const candidate = best[index];
    if (!candidate) continue;
    const direction: Direction = candidate.z > 0 ? 'rich_a' : 'rich_b';
    const spreadDirection = candidate.z > 0 ? -1 : 1;
    const rawWeights = [
      { symbol: candidate.a, weight: spreadDirection },
      { symbol: candidate.b, weight: -spreadDirection * candidate.beta },
    ];
    const grossWeight = sum(rawWeights.map((row) => Math.abs(row.weight)));
    const entryIndex = index + 1;
    const exposures = rawWeights.map((row): Exposure => ({
      symbol: row.symbol,
      weight: row.weight / grossWeight,
      entry: series.get(row.symbol)![entryIndex]!.o,
    }));
    position = {
      ...candidate,
      direction,
      signalAt: btc[index]!.t,
      entryAt: btc[entryIndex]!.t,
      entryIndex,
      exposures,
      ...regimeRows[index]!,
    };
  }

  const values = trades.map((trade) => trade.netPct);
  const adverseValues = trades.map((trade) => trade.adverseNetPct);
  const split = Math.floor(trades.length * 0.7);
  const inSample = values.slice(0, split);
  const outOfSample = values.slice(split);
  const lastAt = trades.at(-1)?.exitAt ?? commonEnd;
  const windows = [30, 60, 90].map((days) => ({
    days,
    total: segment(trades, (trade) => trade.exitAt > lastAt - days * DAY_MS),
    richA: segment(trades, (trade) =>
      trade.exitAt > lastAt - days * DAY_MS && trade.direction === 'rich_a'),
    richB: segment(trades, (trade) =>
      trade.exitAt > lastAt - days * DAY_MS && trade.direction === 'rich_b'),
  }));
  const months = new Map<string, number>();
  for (const trade of trades) {
    const month = new Date(trade.exitAt).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + trade.netPct);
  }
  const monthRows = [...months].map(([month, netPct]) => ({ month, netPct }));
  const bySymbol = Object.fromEntries(SYMBOLS.map((symbol) => {
    const rows = trades.filter((trade) => trade.a === symbol || trade.b === symbol);
    return [symbol, { n: rows.length, netPct: sum(rows.map((trade) => trade.netPct / 2)) }];
  })) as Record<SymbolName, { n: number; netPct: number }>;
  const activeSymbols = SYMBOLS.filter((symbol) => bySymbol[symbol].n >= 10);
  const positiveContributions = activeSymbols.map((symbol) => Math.max(0, bySymbol[symbol].netPct));
  const positiveTotal = sum(positiveContributions);
  const dominance = positiveTotal > 0 ? Math.max(...positiveContributions) / positiveTotal : 1;
  const leaveOneOutMinPct = activeSymbols.length
    ? Math.min(...activeSymbols.map((symbol) => sum(
      trades.filter((trade) => trade.a !== symbol && trade.b !== symbol).map((trade) => trade.netPct),
    )))
    : Number.NEGATIVE_INFINITY;
  const richA = segment(trades, (trade) => trade.direction === 'rich_a');
  const richB = segment(trades, (trade) => trade.direction === 'rich_b');
  const bull = segment(trades, (trade) => trade.regime === 'bull');
  const bear = segment(trades, (trade) => trade.regime === 'bear');
  const high = segment(trades, (trade) => trade.volatilityRegime === 'high');
  const low = segment(trades, (trade) => trade.volatilityRegime === 'low');
  const qualified = trades.length >= MIN_PACKAGES
    && sum(values) > 0 && profitFactor(values) >= 1.2 && meanL95(values) > 0
    && sum(adverseValues) > 0 && profitFactor(adverseValues) >= 1.1
    && drawdown(values) >= -5 && positiveFolds(values) === 4
    && sum(inSample) > 0 && profitFactor(inSample) >= 1.1
    && outOfSample.length >= 30 && sum(outOfSample) > 0 && profitFactor(outOfSample) >= 1.1
    && richA.netPct > 0 && richB.netPct > 0
    && windows.every((window) =>
      window.total.netPct > 0 && window.richA.netPct > 0 && window.richB.netPct > 0)
    && monthRows.filter((row) => row.netPct > 0).length >= 5
    && bull.n >= 20 && bull.netPct > 0 && bear.n >= 20 && bear.netPct > 0
    && high.n >= 20 && high.netPct > 0 && low.n >= 20 && low.netPct > 0
    && activeSymbols.length >= 6 && leaveOneOutMinPct > 0 && dominance <= 0.6;

  return {
    timeframe: `${minutes}m`,
    commonStart: new Date(commonStart).toISOString(),
    commonEnd: new Date(commonEnd).toISOString(),
    packages: trades.length,
    netPct: sum(values),
    netUsd: sum(values),
    profitFactor: profitFactor(values),
    adverseNetPct: sum(adverseValues),
    adverseProfitFactor: profitFactor(adverseValues),
    meanL95Pct: meanL95(values),
    maxDrawdownPct: drawdown(values),
    positiveFolds: positiveFolds(values),
    inSample: { n: inSample.length, netPct: sum(inSample), profitFactor: profitFactor(inSample) },
    outOfSample: { n: outOfSample.length, netPct: sum(outOfSample), profitFactor: profitFactor(outOfSample) },
    directions: { richA, richB },
    regimes: { bull, bear, high, low },
    windows,
    months: monthRows,
    positiveMonths: monthRows.filter((row) => row.netPct > 0).length,
    breadth: { activeSymbols: activeSymbols.length, dominance, leaveOneOutMinPct, bySymbol },
    fundingNetPct: sum(trades.map((trade) => trade.fundingPct)),
    closeReasons: {
      stop: trades.filter((trade) => trade.closeReason === 'stop').length,
      time: trades.filter((trade) => trade.closeReason === 'time').length,
    },
    qualified,
  };
}

const klinesDir = resolve(flagValue('--klines') ?? 'data/lighter-klines');
const costPath = resolve(
  flagValue('--costs') ?? 'data/lighter-execution-costs-native-portfolio-100-20260731.json',
);
const fundingPath = resolve(flagValue('--funding') ?? 'data/lighter-funding-history-native.json');
const outputPath = resolve(
  flagValue('--output') ?? 'data/lighter-dynamic-pair-spread-results.json',
);
const costs = loadCosts(costPath);
const funding = loadFunding(fundingPath);
const results = [run(1, klinesDir, costs, funding), run(5, klinesDir, costs, funding)];
const report = {
  version: 'lighter-dynamic-pair-spread-v1-frozen',
  generatedAt: new Date().toISOString(),
  preregistrationCommit: '20749d2',
  rule: {
    symbols: SYMBOLS,
    betaDays: BETA_DAYS,
    spreadDays: SPREAD_DAYS,
    decisionMinutes: DECISION_MINUTES,
    entryZ: ENTRY_Z,
    minimumCorrelation: MIN_CORRELATION,
    betaRange: [MIN_BETA, MAX_BETA],
    maximumHoldMinutes: HOLD_MINUTES,
    stopPct: STOP_PCT,
    packageNotionalUsd: PACKAGE_NOTIONAL_USD,
    execution: 'next-bar open, measured market-specific $100 p95; exact funding',
    maximumConcurrentPackages: 1,
  },
  results,
  admittedToShadow: results.some((result) => result.qualified),
};
atomicWrite(outputPath, report);
for (const result of results) {
  console.log(
    `${result.timeframe}: N${result.packages} net ${result.netPct.toFixed(2)}% `
    + `PF${result.profitFactor.toFixed(2)} adverse ${result.adverseNetPct.toFixed(2)}% `
    + `L95 ${result.meanL95Pct.toFixed(4)} DD ${result.maxDrawdownPct.toFixed(2)}% `
    + `folds ${result.positiveFolds}/4 IS/OOS ${result.inSample.netPct.toFixed(2)}/${result.outOfSample.netPct.toFixed(2)} `
    + `directions ${result.directions.richA.netPct.toFixed(2)}/${result.directions.richB.netPct.toFixed(2)} `
    + `${result.qualified ? 'QUALIFIED' : 'REJECTED'}`,
  );
}
console.log(`→ ${outputPath}`);

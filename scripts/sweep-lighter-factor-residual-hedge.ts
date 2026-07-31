#!/usr/bin/env tsx

/** Frozen BTC+ETH factor-residual hedge test (see validation document). */

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
const ALTS = SYMBOLS.filter((symbol) => symbol !== 'BTC' && symbol !== 'ETH');
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BETA_DAYS = 7;
const Z_DAYS = 7;
const SIGNAL_MINUTES = 60;
const DECISION_MINUTES = 15;
const MAX_HOLD_MINUTES = 60;
const ENTRY_Z = 2.5;
const STOP_Z = 4;
const MIN_R2 = 0.30;
const MAX_ABS_BETA = 3;
const RIDGE_TRACE_MULTIPLIER = 1e-6;
const PACKAGE_NOTIONAL_USD = 100;
const MIN_PACKAGES = 120;

type SymbolName = (typeof SYMBOLS)[number];
type Alt = (typeof ALTS)[number];
type RawCandle = { t: number; o: number; h: number; l: number; c: number; v?: number };
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Cost = { p95Pct: number; maxPct: number };
type Model = { betaBtc: number[]; betaEth: number[]; r2: number[]; z: number[] };
type Exposure = { symbol: SymbolName; weight: number; entry: number };
type Regime = 'bull' | 'bear' | 'unknown';
type VolatilityRegime = 'high' | 'low' | 'unknown';
type Direction = 'negative_z' | 'positive_z';
type CloseReason = 'mean' | 'decointegration' | 'time';
type Position = {
  alt: Alt;
  direction: Direction;
  signalAt: number;
  entryAt: number;
  entryIndex: number;
  entryZ: number;
  exposures: Exposure[];
  regime: Regime;
  volatilityRegime: VolatilityRegime;
};
type Trade = Position & {
  exitAt: number;
  exitZ: number;
  grossPct: number;
  fundingPct: number;
  costPct: number;
  adverseCostPct: number;
  netPct: number;
  adverseNetPct: number;
  closeReason: CloseReason;
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

function buildModel(
  alt: readonly Candle[],
  btc: readonly Candle[],
  eth: readonly Candle[],
  betaBars: number,
  signalBars: number,
  zBars: number,
): Model {
  const length = alt.length;
  const betaBtc = Array(length).fill(Number.NaN) as number[];
  const betaEth = Array(length).fill(Number.NaN) as number[];
  const r2 = Array(length).fill(Number.NaN) as number[];
  const residual = Array(length).fill(Number.NaN) as number[];
  const residualMove = Array(length).fill(Number.NaN) as number[];
  const z = Array(length).fill(Number.NaN) as number[];
  const x1 = Array(length).fill(Number.NaN) as number[];
  const x2 = Array(length).fill(Number.NaN) as number[];
  const y = Array(length).fill(Number.NaN) as number[];
  let sx1 = 0; let sx2 = 0; let sy = 0;
  let sx1x1 = 0; let sx2x2 = 0; let syy = 0;
  let sx1x2 = 0; let sx1y = 0; let sx2y = 0;
  for (let index = 1; index < length; index++) {
    x1[index] = Math.log(btc[index]!.c / btc[index - 1]!.c);
    x2[index] = Math.log(eth[index]!.c / eth[index - 1]!.c);
    y[index] = Math.log(alt[index]!.c / alt[index - 1]!.c);
    const add1 = x1[index]!; const add2 = x2[index]!; const addY = y[index]!;
    sx1 += add1; sx2 += add2; sy += addY;
    sx1x1 += add1 * add1; sx2x2 += add2 * add2; syy += addY * addY;
    sx1x2 += add1 * add2; sx1y += add1 * addY; sx2y += add2 * addY;
    if (index > betaBars) {
      const remove = index - betaBars;
      const old1 = x1[remove]!; const old2 = x2[remove]!; const oldY = y[remove]!;
      sx1 -= old1; sx2 -= old2; sy -= oldY;
      sx1x1 -= old1 * old1; sx2x2 -= old2 * old2; syy -= oldY * oldY;
      sx1x2 -= old1 * old2; sx1y -= old1 * oldY; sx2y -= old2 * oldY;
    }
    if (index < betaBars) continue;
    const n = betaBars;
    const v11 = sx1x1 - sx1 * sx1 / n;
    const v22 = sx2x2 - sx2 * sx2 / n;
    const v12 = sx1x2 - sx1 * sx2 / n;
    const c1 = sx1y - sx1 * sy / n;
    const c2 = sx2y - sx2 * sy / n;
    const vy = syy - sy * sy / n;
    const ridge = RIDGE_TRACE_MULTIPLIER * Math.max(v11 + v22, 1e-18);
    const a11 = v11 + ridge;
    const a22 = v22 + ridge;
    const determinant = a11 * a22 - v12 * v12;
    if (!(determinant > 0) || !(vy > 0)) continue;
    const b1 = (c1 * a22 - c2 * v12) / determinant;
    const b2 = (c2 * a11 - c1 * v12) / determinant;
    if (!Number.isFinite(b1) || !Number.isFinite(b2)) continue;
    betaBtc[index] = b1;
    betaEth[index] = b2;
    const explained = Math.max(0, b1 * c1 + b2 * c2);
    r2[index] = Math.min(1, explained / vy);
    residual[index] = (addY - sy / n) - b1 * (add1 - sx1 / n) - b2 * (add2 - sx2 / n);
    if (index < betaBars + signalBars - 1) continue;
    let move = 0;
    let complete = true;
    for (let offset = 0; offset < signalBars; offset++) {
      const value = residual[index - offset]!;
      if (!Number.isFinite(value)) { complete = false; break; }
      move += value;
    }
    if (complete) residualMove[index] = move;
  }

  let moveSum = 0;
  let moveSumSq = 0;
  let moveCount = 0;
  for (let index = 0; index < length; index++) {
    const value = residualMove[index]!;
    if (Number.isFinite(value)) {
      moveSum += value;
      moveSumSq += value * value;
      moveCount++;
    }
    if (index >= zBars) {
      const old = residualMove[index - zBars]!;
      if (Number.isFinite(old)) {
        moveSum -= old;
        moveSumSq -= old * old;
        moveCount--;
      }
    }
    if (!Number.isFinite(value) || moveCount < zBars) continue;
    const mean = moveSum / moveCount;
    const variance = Math.max(0, (moveSumSq - moveSum * moveSum / moveCount) / (moveCount - 1));
    if (variance > 0) z[index] = (value - mean) / Math.sqrt(variance);
  }
  return { betaBtc, betaEth, r2, z };
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

function regimes(btc: readonly Candle[], index: number, minutes: 1 | 5): {
  regime: Regime;
  volatilityRegime: VolatilityRegime;
} {
  const monthBars = 30 * 24 * 60 / minutes;
  const weekBars = 7 * 24 * 60 / minutes;
  if (index < monthBars) return { regime: 'unknown', volatilityRegime: 'unknown' };
  const regime: Regime = btc[index]!.c >= btc[index - monthBars]!.c ? 'bull' : 'bear';
  const returns: number[] = [];
  for (let cursor = index - monthBars + 1; cursor <= index; cursor++) {
    returns.push(Math.log(btc[cursor]!.c / btc[cursor - 1]!.c));
  }
  const baseline = standardDeviation(returns);
  const recent = standardDeviation(returns.slice(-weekBars));
  const volatilityRegime: VolatilityRegime = baseline == null || recent == null
    ? 'unknown'
    : recent >= baseline ? 'high' : 'low';
  return { regime, volatilityRegime };
}

function run(
  minutes: 1 | 5,
  klinesDir: string,
  costs: Map<SymbolName, Cost>,
  funding: Map<SymbolName, LighterFundingSeries>,
) {
  const barMs = minutes * MINUTE_MS;
  const raw = new Map<SymbolName, Candle[]>();
  for (const symbol of SYMBOLS) {
    raw.set(symbol, aggregate(loadOneMinute(symbol, klinesDir), minutes));
  }
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
  const eth = series.get('ETH')!;
  const betaBars = BETA_DAYS * 24 * 60 / minutes;
  const zBars = Z_DAYS * 24 * 60 / minutes;
  const signalBars = SIGNAL_MINUTES / minutes;
  const decisionBars = DECISION_MINUTES / minutes;
  const maxHoldBars = MAX_HOLD_MINUTES / minutes;
  const models = new Map<Alt, Model>();
  for (const alt of ALTS) {
    models.set(alt, buildModel(series.get(alt)!, btc, eth, betaBars, signalBars, zBars));
  }

  const trades: Trade[] = [];
  let position: Position | null = null;
  for (let index = 0; index < btc.length - 1; index++) {
    if (position && index >= position.entryIndex) {
      const model = models.get(position.alt)!;
      const currentZ = model.z[index]!;
      const meanClose = Number.isFinite(currentZ) && (
        position.direction === 'negative_z' ? currentZ >= 0 : currentZ <= 0
      );
      const decointegration = Number.isFinite(currentZ) && (
        position.direction === 'negative_z' ? currentZ <= -STOP_Z : currentZ >= STOP_Z
      );
      const timeClose = index + 1 - position.entryIndex >= maxHoldBars;
      if (meanClose || decointegration || timeClose) {
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
          exitZ: currentZ,
          grossPct,
          fundingPct,
          costPct,
          adverseCostPct,
          netPct: grossPct + fundingPct - costPct,
          adverseNetPct: grossPct + fundingPct - adverseCostPct,
          closeReason: decointegration ? 'decointegration' : meanClose ? 'mean' : 'time',
        });
        position = null;
      }
    }

    if (position || index % decisionBars !== decisionBars - 1) continue;
    const candidates = ALTS.flatMap((alt) => {
      const model = models.get(alt)!;
      const z = model.z[index]!;
      const betaBtc = model.betaBtc[index]!;
      const betaEth = model.betaEth[index]!;
      const r2 = model.r2[index]!;
      if (
        !Number.isFinite(z) || Math.abs(z) < ENTRY_Z
        || !Number.isFinite(betaBtc) || !Number.isFinite(betaEth)
        || Math.abs(betaBtc) > MAX_ABS_BETA || Math.abs(betaEth) > MAX_ABS_BETA
        || !Number.isFinite(r2) || r2 < MIN_R2
      ) return [];
      return [{ alt, z, betaBtc, betaEth }];
    }).sort((left, right) => Math.abs(right.z) - Math.abs(left.z));
    const candidate = candidates[0];
    if (!candidate) continue;
    const direction: Direction = candidate.z < 0 ? 'negative_z' : 'positive_z';
    const residualDirection = candidate.z < 0 ? 1 : -1;
    const rawWeights: Array<{ symbol: SymbolName; weight: number }> = [
      { symbol: candidate.alt, weight: residualDirection },
      { symbol: 'BTC', weight: -residualDirection * candidate.betaBtc },
      { symbol: 'ETH', weight: -residualDirection * candidate.betaEth },
    ];
    const grossWeight = sum(rawWeights.map((row) => Math.abs(row.weight)));
    if (!(grossWeight > 0)) continue;
    const entryIndex = index + 1;
    const exposureRows = rawWeights
      .map((row) => ({ ...row, weight: row.weight / grossWeight }))
      .filter((row) => Math.abs(row.weight) > 1e-8)
      .map((row): Exposure => ({
        ...row,
        entry: series.get(row.symbol)![entryIndex]!.o,
      }));
    position = {
      alt: candidate.alt,
      direction,
      signalAt: btc[index]!.t,
      entryAt: btc[entryIndex]!.t,
      entryIndex,
      entryZ: candidate.z,
      exposures: exposureRows,
      ...regimes(btc, index, minutes),
    };
  }

  const values = trades.map((trade) => trade.netPct);
  const adverseValues = trades.map((trade) => trade.adverseNetPct);
  const split = Math.floor(trades.length * 0.7);
  const lastAt = trades.at(-1)?.exitAt ?? commonEnd;
  const windows = [30, 60, 90].map((days) => ({
    days,
    total: segment(trades, (trade) => trade.exitAt > lastAt - days * DAY_MS),
    negativeZ: segment(trades, (trade) =>
      trade.exitAt > lastAt - days * DAY_MS && trade.direction === 'negative_z'),
    positiveZ: segment(trades, (trade) =>
      trade.exitAt > lastAt - days * DAY_MS && trade.direction === 'positive_z'),
  }));
  const months = new Map<string, number>();
  for (const trade of trades) {
    const month = new Date(trade.exitAt).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + trade.netPct);
  }
  const monthRows = [...months].map(([month, netPct]) => ({ month, netPct }));
  const byAlt = Object.fromEntries(ALTS.map((alt) => {
    const rows = trades.filter((trade) => trade.alt === alt);
    return [alt, { n: rows.length, netPct: sum(rows.map((trade) => trade.netPct)) }];
  })) as Record<Alt, { n: number; netPct: number }>;
  const activeAlts = ALTS.filter((alt) => byAlt[alt].n >= 10);
  const positiveContributions = activeAlts.map((alt) => Math.max(0, byAlt[alt].netPct));
  const positiveTotal = sum(positiveContributions);
  const dominance = positiveTotal > 0 ? Math.max(...positiveContributions) / positiveTotal : 1;
  const leaveOneOutMinPct = activeAlts.length
    ? Math.min(...activeAlts.map((alt) => sum(
      trades.filter((trade) => trade.alt !== alt).map((trade) => trade.netPct),
    )))
    : Number.NEGATIVE_INFINITY;
  const negativeZ = segment(trades, (trade) => trade.direction === 'negative_z');
  const positiveZ = segment(trades, (trade) => trade.direction === 'positive_z');
  const bull = segment(trades, (trade) => trade.regime === 'bull');
  const bear = segment(trades, (trade) => trade.regime === 'bear');
  const high = segment(trades, (trade) => trade.volatilityRegime === 'high');
  const low = segment(trades, (trade) => trade.volatilityRegime === 'low');
  const inSample = values.slice(0, split);
  const outOfSample = values.slice(split);
  const qualified = trades.length >= MIN_PACKAGES
    && sum(values) > 0 && profitFactor(values) >= 1.2 && meanL95(values) > 0
    && sum(adverseValues) > 0 && profitFactor(adverseValues) >= 1.1
    && drawdown(values) >= -5 && positiveFolds(values) === 4
    && sum(inSample) > 0 && profitFactor(inSample) >= 1.1
    && outOfSample.length >= 30 && sum(outOfSample) > 0 && profitFactor(outOfSample) >= 1.1
    && negativeZ.netPct > 0 && positiveZ.netPct > 0
    && windows.every((window) =>
      window.total.netPct > 0 && window.negativeZ.netPct > 0 && window.positiveZ.netPct > 0)
    && monthRows.filter((row) => row.netPct > 0).length >= 5
    && bull.n >= 20 && bull.netPct > 0 && bear.n >= 20 && bear.netPct > 0
    && high.n >= 20 && high.netPct > 0 && low.n >= 20 && low.netPct > 0
    && activeAlts.length >= 6 && leaveOneOutMinPct > 0 && dominance <= 0.6;

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
    outOfSample: {
      n: outOfSample.length,
      netPct: sum(outOfSample),
      profitFactor: profitFactor(outOfSample),
    },
    directions: { negativeZ, positiveZ },
    regimes: { bull, bear, high, low },
    windows,
    months: monthRows,
    positiveMonths: monthRows.filter((row) => row.netPct > 0).length,
    breadth: { activeAlts: activeAlts.length, dominance, leaveOneOutMinPct, byAlt },
    fundingNetPct: sum(trades.map((trade) => trade.fundingPct)),
    closeReasons: {
      mean: trades.filter((trade) => trade.closeReason === 'mean').length,
      decointegration: trades.filter((trade) => trade.closeReason === 'decointegration').length,
      time: trades.filter((trade) => trade.closeReason === 'time').length,
    },
    qualified,
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
  flagValue('--output') ?? 'data/lighter-factor-residual-hedge-results.json',
);
const costs = loadCosts(costPath);
const funding = loadFunding(fundingPath);
const results = [run(1, klinesDir, costs, funding), run(5, klinesDir, costs, funding)];
const report = {
  version: 'lighter-factor-residual-hedge-v1-frozen',
  generatedAt: new Date().toISOString(),
  preregistrationCommit: '2afe7f9',
  rule: {
    symbols: SYMBOLS,
    factors: ['BTC', 'ETH'],
    betaDays: BETA_DAYS,
    residualSignalMinutes: SIGNAL_MINUTES,
    residualZDays: Z_DAYS,
    decisionMinutes: DECISION_MINUTES,
    entryZ: ENTRY_Z,
    exitZ: 0,
    stopZ: STOP_Z,
    maximumHoldMinutes: MAX_HOLD_MINUTES,
    minimumR2: MIN_R2,
    maximumAbsoluteBeta: MAX_ABS_BETA,
    ridgeTraceMultiplier: RIDGE_TRACE_MULTIPLIER,
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
    + `directions ${result.directions.negativeZ.netPct.toFixed(2)}/${result.directions.positiveZ.netPct.toFixed(2)} `
    + `${result.qualified ? 'QUALIFIED' : 'REJECTED'}`,
  );
}
console.log(`→ ${outputPath}`);

/** Walk-forward microstructure feature audit for the Tokyo 250ms collector. */

import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fitRidgeLinear, predictLinear, type LinearModel } from '../lib/hft-linear-model.js';
import { makerFillIndex } from '../lib/hft-maker-fill.js';

const DATA_DIR = resolve(process.argv[2] ?? process.env.HFT_DATA_DIR ?? 'data/hft-leadlag');
const HOURS = Number(process.argv[3] ?? 48);
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const RESULT_PATH = resolve(DATA_DIR, 'feature-audit.json');
const SAMPLE_MS = 250;
const SAMPLE_STRIDE = 4;
const TAKER_RT_BPS = 9;
const MAKER_TAKER_BPS = 6;
const STRESS_EXTRA_BPS = 3;
const MAKER_TTL_STEPS = 8;
const HORIZONS_MS = [1_000, 2_000, 5_000, 10_000];
const THRESHOLDS_BPS = [1, 2, 3, 4, 5, 6, 8, 10];
const FEATURE_NAMES = [
  'cexLead250ms',
  'cexLead500ms',
  'cexLead1s',
  'hlLagBps',
  'hlBookImbalance',
  'binanceBookImbalance',
  'bybitBookImbalance',
  'hlFlowImbalance',
  'cexFlowImbalance',
  'hlSpreadBps',
  'hlDepthImbalance',
  'cexDisagreementBps',
  'cexLiquidationImbalance',
  'cexLiquidationLogUsd',
];

type PackedRow = {
  v: number;
  t: number;
  s: string;
  h: number[];
  b: number[];
  y: number[];
  f: Array<number | null>;
  x?: number[];
  l?: number[];
};

type Point = {
  t: number;
  hlBid: number;
  hlAsk: number;
  hlBidSize: number;
  hlAskSize: number;
  hlPrints: number[];
  features: number[];
};

type View = {
  signals: number;
  fills: number;
  fillRate: number;
  netBps: number;
  meanBps: number;
  profitFactor: number;
  winRate: number;
  positiveHours: number;
  hours: number;
  withoutBestBps: number;
};

function midpoint(book: number[]): number {
  return (book[0]! + book[1]!) / 2;
}

function imbalance(bid: number, ask: number): number {
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : 0;
}

function flowImbalance(flow: Array<number | null>, offset: number): number {
  const buy = flow[offset] ?? 0;
  const sell = flow[offset + 1] ?? 0;
  return buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
}

function cexMoveBps(raw: PackedRow[], index: number, lookback: number): [number, number] {
  const previous = raw[Math.max(0, index - lookback)]!;
  const current = raw[index]!;
  return [
    (midpoint(current.b) / midpoint(previous.b) - 1) * 10_000,
    (midpoint(current.y) / midpoint(previous.y) - 1) * 10_000,
  ];
}

async function readCoin(files: string[], coin: string): Promise<Point[]> {
  const raw: PackedRow[] = [];
  for (const path of files) {
    const lines = createInterface({
      input: createReadStream(path).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line) as PackedRow;
      if (row.v === 1 && row.s === coin) raw.push(row);
    }
  }
  raw.sort((a, b) => a.t - b.t);
  const points: Point[] = [];
  let basis = 0;
  const basisAlpha = 1 / 240;
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]!;
    const hlMid = midpoint(row.h);
    const binMid = midpoint(row.b);
    const byMid = midpoint(row.y);
    const cexMid = (binMid + byMid) / 2;
    const observedBasis = hlMid / cexMid - 1;
    if (i === 0) basis = observedBasis;
    const [bin250, by250] = cexMoveBps(raw, i, 1);
    const [bin500, by500] = cexMoveBps(raw, i, 2);
    const [bin1s, by1s] = cexMoveBps(raw, i, 4);
    const liquidationBuy = (row.l?.[0] ?? 0) + (row.l?.[2] ?? 0);
    const liquidationSell = (row.l?.[1] ?? 0) + (row.l?.[3] ?? 0);
    points.push({
      t: row.t,
      hlBid: row.h[0]!,
      hlAsk: row.h[1]!,
      hlBidSize: row.h[2]!,
      hlAskSize: row.h[3]!,
      hlPrints: row.x ?? [],
      features: [
        (bin250 + by250) / 2,
        (bin500 + by500) / 2,
        (bin1s + by1s) / 2,
        ((cexMid * (1 + basis)) / hlMid - 1) * 10_000,
        imbalance(row.h[2]!, row.h[3]!),
        imbalance(row.b[2]!, row.b[3]!),
        imbalance(row.y[2]!, row.y[3]!),
        flowImbalance(row.f, 0),
        (flowImbalance(row.f, 5) + flowImbalance(row.f, 10)) / 2,
        ((row.h[1]! - row.h[0]!) / hlMid) * 10_000,
        imbalance(row.h[4]!, row.h[5]!),
        Math.abs(bin1s - by1s),
        imbalance(liquidationBuy, liquidationSell),
        Math.log1p(liquidationBuy + liquidationSell),
      ],
    });
    basis = (1 - basisAlpha) * basis + basisAlpha * observedBasis;
  }
  return points;
}

function mid(point: Point): number {
  return (point.hlBid + point.hlAsk) / 2;
}

function futureMidBps(points: Point[], signalIdx: number, horizonSteps: number): number {
  const entryIdx = signalIdx + 1;
  return (mid(points[entryIdx + horizonSteps]!) / mid(points[entryIdx]!) - 1) * 10_000;
}

function trainingSamples(
  points: Point[],
  from: number,
  to: number,
  horizonSteps: number,
): Array<{ features: number[]; target: number }> {
  const samples: Array<{ features: number[]; target: number }> = [];
  for (let i = Math.max(4, from); i + 1 + horizonSteps < to; i += SAMPLE_STRIDE) {
    const target = futureMidBps(points, i, horizonSteps);
    if (Number.isFinite(target) && points[i]!.features.every(Number.isFinite)) {
      samples.push({ features: points[i]!.features, target });
    }
  }
  return samples;
}

function tradeNetBps(
  points: Point[],
  signalIdx: number,
  side: 1 | -1,
  horizonSteps: number,
  latencySteps: number,
  execution: 'taker' | 'maker',
  feeBps: number,
): { exitIdx: number; netBps: number } | null {
  const startIdx = signalIdx + latencySteps;
  if (startIdx + horizonSteps >= points.length) return null;
  const start = points[startIdx]!;
  if (execution === 'taker') {
    const exitIdx = startIdx + horizonSteps;
    const entry = side === 1 ? start.hlAsk : start.hlBid;
    const exit = side === 1 ? points[exitIdx]!.hlBid : points[exitIdx]!.hlAsk;
    return { exitIdx, netBps: side * (exit / entry - 1) * 10_000 - feeBps };
  }
  const quote = side === 1 ? start.hlBid : start.hlAsk;
  const queue = side === 1 ? start.hlBidSize : start.hlAskSize;
  const fillIdx = makerFillIndex(
    points,
    startIdx + 1,
    Math.min(points.length - horizonSteps - 1, startIdx + MAKER_TTL_STEPS),
    side,
    quote,
    queue,
  );
  if (fillIdx < 0) return null;
  const exitIdx = fillIdx + horizonSteps;
  const exit = side === 1 ? points[exitIdx]!.hlBid : points[exitIdx]!.hlAsk;
  return { exitIdx, netBps: side * (exit / quote - 1) * 10_000 - feeBps };
}

function evaluate(
  points: Point[],
  model: LinearModel,
  from: number,
  to: number,
  horizonSteps: number,
  thresholdBps: number,
  execution: 'taker' | 'maker',
  latencySteps: number,
  feeBps: number,
): View {
  let signals = 0;
  let fills = 0;
  let netBps = 0;
  let gains = 0;
  let losses = 0;
  let wins = 0;
  let best = 0;
  let nextAvailable = from;
  const hours = new Map<string, number>();
  for (let i = Math.max(4, from); i + latencySteps + horizonSteps < to; i += SAMPLE_STRIDE) {
    if (i < nextAvailable) continue;
    const prediction = predictLinear(model, points[i]!.features);
    if (!Number.isFinite(prediction) || Math.abs(prediction) < thresholdBps) continue;
    signals++;
    const side: 1 | -1 = prediction > 0 ? 1 : -1;
    const trade = tradeNetBps(points, i, side, horizonSteps, latencySteps, execution, feeBps);
    if (!trade || trade.exitIdx >= to) continue;
    fills++;
    netBps += trade.netBps;
    best = Math.max(best, trade.netBps);
    if (trade.netBps > 0) {
      gains += trade.netBps;
      wins++;
    } else losses -= trade.netBps;
    const hour = new Date(points[trade.exitIdx]!.t).toISOString().slice(0, 13);
    hours.set(hour, (hours.get(hour) ?? 0) + trade.netBps);
    nextAvailable = trade.exitIdx;
  }
  return {
    signals,
    fills,
    fillRate: signals ? fills / signals : 0,
    netBps,
    meanBps: fills ? netBps / fills : 0,
    profitFactor: losses ? gains / losses : gains ? 99 : 0,
    winRate: fills ? wins / fills : 0,
    positiveHours: [...hours.values()].filter((value) => value > 0).length,
    hours: hours.size,
    withoutBestBps: netBps - best,
  };
}

function roundedView(view: View): View {
  return Object.fromEntries(
    Object.entries(view).map(([key, value]) => [key, Math.round(value * 10_000) / 10_000]),
  ) as View;
}

function chooseThreshold(
  points: Point[],
  model: LinearModel,
  from: number,
  to: number,
  horizonSteps: number,
  execution: 'taker' | 'maker',
): { thresholdBps: number; validation: View; validationStress: View } {
  const candidates = THRESHOLDS_BPS.map((thresholdBps) => {
    const validation = evaluate(
      points,
      model,
      from,
      to,
      horizonSteps,
      thresholdBps,
      execution,
      1,
      execution === 'taker' ? TAKER_RT_BPS : MAKER_TAKER_BPS,
    );
    const validationStress = evaluate(
      points,
      model,
      from,
      to,
      horizonSteps,
      thresholdBps,
      execution,
      2,
      (execution === 'taker' ? TAKER_RT_BPS : MAKER_TAKER_BPS) + STRESS_EXTRA_BPS,
    );
    return { thresholdBps, validation, validationStress };
  });
  return candidates.sort(
    (a, b) =>
      Number(b.validationStress.fills >= 30) - Number(a.validationStress.fills >= 30) ||
      b.validationStress.netBps - a.validationStress.netBps,
  )[0]!;
}

function completedFiles(): string[] {
  const status = existsSync(STATUS_PATH)
    ? (JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as { currentPath?: string })
    : {};
  const current = status.currentPath ? basename(status.currentPath) : '';
  const cutoff = Date.now() - HOURS * 3_600_000;
  return readdirSync(DATA_DIR)
    .filter((name) => /^leadlag-\d{12}\.ndjson\.gz$/.test(name) && name !== current)
    .map((name) => resolve(DATA_DIR, name))
    .filter((path) => {
      const stamp = basename(path).slice(8, 20);
      const time = Date.UTC(
        Number(stamp.slice(0, 4)),
        Number(stamp.slice(4, 6)) - 1,
        Number(stamp.slice(6, 8)),
        Number(stamp.slice(8, 10)),
        Number(stamp.slice(10, 12)),
      );
      return time >= cutoff;
    })
    .sort();
}

async function main(): Promise<void> {
  if (!existsSync(DATA_DIR)) throw new Error(`missing data dir ${DATA_DIR}`);
  const files = completedFiles();
  if (!files.length) throw new Error('no completed leadlag segments yet');
  const status = JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as { markets?: string[] };
  const coins = status.markets ?? [];
  const rows: Array<Record<string, unknown>> = [];
  for (const coin of coins) {
    const points = await readCoin(files, coin);
    if (points.length < 10_000) continue;
    const trainEnd = Math.floor(points.length * 0.6);
    const validationEnd = Math.floor(points.length * 0.8);
    const dataDays = new Set(points.map((point) => new Date(point.t).toISOString().slice(0, 10)))
      .size;
    for (const horizonMs of HORIZONS_MS) {
      const horizonSteps = Math.round(horizonMs / SAMPLE_MS);
      const samples = trainingSamples(points, 0, trainEnd, horizonSteps);
      const model = fitRidgeLinear(samples, 10);
      if (!model) continue;
      for (const execution of ['taker', 'maker'] as const) {
        const selected = chooseThreshold(
          points,
          model,
          trainEnd,
          validationEnd,
          horizonSteps,
          execution,
        );
        const test = evaluate(
          points,
          model,
          validationEnd,
          points.length,
          horizonSteps,
          selected.thresholdBps,
          execution,
          1,
          execution === 'taker' ? TAKER_RT_BPS : MAKER_TAKER_BPS,
        );
        const testStress = evaluate(
          points,
          model,
          validationEnd,
          points.length,
          horizonSteps,
          selected.thresholdBps,
          execution,
          2,
          (execution === 'taker' ? TAKER_RT_BPS : MAKER_TAKER_BPS) + STRESS_EXTRA_BPS,
        );
        const passes =
          dataDays >= 7 &&
          selected.validationStress.fills >= 100 &&
          selected.validationStress.netBps > 0 &&
          selected.validationStress.withoutBestBps > 0 &&
          selected.validationStress.profitFactor >= 1.1 &&
          testStress.fills >= 100 &&
          testStress.netBps > 0 &&
          testStress.withoutBestBps > 0 &&
          testStress.profitFactor >= 1.1 &&
          testStress.positiveHours / Math.max(1, testStress.hours) >= 0.6;
        rows.push({
          coin,
          horizonMs,
          execution,
          dataDays,
          samples: samples.length,
          thresholdBps: selected.thresholdBps,
          featureWeights: Object.fromEntries(
            FEATURE_NAMES.map((name, index) => [name, model.weights[index + 1]]),
          ),
          validation: roundedView(selected.validation),
          validationStress: roundedView(selected.validationStress),
          test: roundedView(test),
          testStress: roundedView(testStress),
          passes,
        });
      }
    }
    console.warn(`feature audit ${coin}: ${points.length} points`);
  }
  rows.sort(
    (a, b) =>
      Number(b.passes) - Number(a.passes) ||
      ((b.testStress as View).netBps ?? 0) - ((a.testStress as View).netBps ?? 0),
  );
  const result = {
    version: 'hft-feature-audit-v1',
    generatedAt: Date.now(),
    hoursRequested: HOURS,
    files: files.map((path) => basename(path)),
    featureNames: FEATURE_NAMES,
    split: { train: 0.6, validation: 0.2, test: 0.2 },
    costsBps: {
      takerRoundTrip: TAKER_RT_BPS,
      makerTaker: MAKER_TAKER_BPS,
      extraStress: STRESS_EXTRA_BPS,
      baseLatencyMs: SAMPLE_MS,
      stressLatencyMs: SAMPLE_MS * 2,
    },
    gates: {
      minDataDays: 7,
      minValidationStressFills: 100,
      minTestStressFills: 100,
      minStressProfitFactor: 1.1,
      minPositiveHourFraction: 0.6,
      positiveWithoutBest: true,
    },
    passing: rows.filter((row) => row.passes),
    rows,
  };
  const temporary = `${RESULT_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(result, null, 2));
  renameSync(temporary, RESULT_PATH);
  console.warn(
    `feature audit: ${files.length} segments, ${result.passing.length}/${rows.length} passing -> ${RESULT_PATH}`,
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

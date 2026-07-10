/**
 * Read-only temporal audit for the current HL Momentum confirm-long segment.
 *
 * Keeps correlated market waves from dominating the conclusion by reporting
 * both per-trade and five-minute cluster statistics across chronological folds.
 * Run on the VPS, where the production SQLite database lives:
 *   pnpm tsx scripts/hl-momentum-segment-analysis.ts
 */

/* eslint-disable no-console -- operator CLI intentionally prints an audit table */

import { db } from '../src/db/client.js';
import { HL_MOMENTUM_CALIBRATION_VERSION } from '../src/lib/hl-momentum-calibration.js';

type Row = {
  id: number;
  coin: string;
  opened_at: number;
  closed_at: number;
  pnl_pct: number;
  close_reason: string | null;
  signal: string;
};

type Trade = Row & {
  r3: number;
  r12: number;
  h1: number;
  impulseRatio: number;
  volRatio: number;
  score: number;
  probability: number;
};

type Stats = {
  n: number;
  average: number;
  sum: number;
  winRate: number;
  profitFactor: number | null;
};

type Candidate = {
  name: string;
  keep: (trade: Trade) => boolean;
};

const FOLD_COUNT = 4;
const CLUSTER_MS = 5 * 60_000;

const rows = db.prepare<[string], Row>(`
  SELECT id, coin, opened_at, closed_at, pnl_pct, close_reason, signal
    FROM hl_momentum_shadow_log
   WHERE closed_at IS NOT NULL
     AND pnl_pct IS NOT NULL
     AND side = 'long'
     AND signal LIKE '%layer=confirm%'
     AND signal LIKE ?
   ORDER BY opened_at ASC, id ASC
`).all(`%cv=${HL_MOMENTUM_CALIBRATION_VERSION}%`);

function metric(signal: string, pattern: RegExp): number | null {
  const match = signal.match(pattern);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function parse(row: Row): Trade | null {
  const r3 = metric(row.signal, /\br3=([-+]?\d+(?:\.\d+)?)/);
  const r12 = metric(row.signal, /\br12m=([-+]?\d+(?:\.\d+)?)/);
  const h1 = metric(row.signal, /\bh1=([-+]?\d+(?:\.\d+)?)/);
  const impulseRatio = metric(row.signal, /\bir=([-+]?\d+(?:\.\d+)?)/);
  const volRatio = metric(row.signal, /\bvol=([-+]?\d+(?:\.\d+)?)x/);
  const score = metric(row.signal, /\[score=([-+]?\d+(?:\.\d+)?)/);
  const probability = metric(row.signal, /\bp=([-+]?\d+(?:\.\d+)?)/);
  if ([r3, r12, h1, impulseRatio, volRatio, score, probability].some((value) => value == null)) return null;
  return {
    ...row,
    r3: r3!,
    r12: r12!,
    h1: h1!,
    impulseRatio: impulseRatio!,
    volRatio: volRatio!,
    score: score!,
    probability: probability!,
  };
}

function stats(pnls: number[]): Stats {
  if (pnls.length === 0) return { n: 0, average: 0, sum: 0, winRate: 0, profitFactor: null };
  const sum = pnls.reduce((total, pnl) => total + pnl, 0);
  const grossProfit = pnls.reduce((total, pnl) => total + Math.max(0, pnl), 0);
  const grossLoss = pnls.reduce((total, pnl) => total + Math.max(0, -pnl), 0);
  return {
    n: pnls.length,
    average: sum / pnls.length,
    sum,
    winRate: pnls.filter((pnl) => pnl > 0).length / pnls.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}

function tradeStats(trades: Trade[]): Stats {
  return stats(trades.map((trade) => trade.pnl_pct));
}

function clusterStats(trades: Trade[]): Stats {
  const clusters = new Map<number, number[]>();
  for (const trade of trades) {
    const bucket = Math.floor(trade.opened_at / CLUSTER_MS) * CLUSTER_MS;
    const pnls = clusters.get(bucket) ?? [];
    pnls.push(trade.pnl_pct);
    clusters.set(bucket, pnls);
  }
  return stats([...clusters.values()].map((pnls) => pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length));
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function fmt(statsValue: Stats): string {
  const pf = statsValue.profitFactor == null ? (statsValue.sum > 0 ? 'inf' : '-') : statsValue.profitFactor.toFixed(2);
  return `n=${String(statsValue.n).padStart(3)} avg=${pct(statsValue.average).padStart(8)} sum=${pct(statsValue.sum).padStart(9)} WR=${(statsValue.winRate * 100).toFixed(0).padStart(2)}% PF=${pf}`;
}

function folds(trades: Trade[]): Trade[][] {
  return Array.from({ length: FOLD_COUNT }, (_, index) => {
    const start = Math.floor(index * trades.length / FOLD_COUNT);
    const end = Math.floor((index + 1) * trades.length / FOLD_COUNT);
    return trades.slice(start, end);
  });
}

const trades = rows.map(parse).filter((trade): trade is Trade => trade != null);
if (trades.length !== rows.length) {
  console.error(`Unable to parse ${rows.length - trades.length}/${rows.length} rows`);
  process.exitCode = 1;
}

const candidates: Candidate[] = [
  { name: 'baseline', keep: () => true },
  { name: 'impulse >= 1.5x', keep: (trade) => trade.impulseRatio >= 1.5 },
  { name: 'impulse >= 1.8x', keep: (trade) => trade.impulseRatio >= 1.8 },
  { name: '|r3| >= 0.40%', keep: (trade) => Math.abs(trade.r3) >= 0.40 },
  { name: '|r3| >= 0.50%', keep: (trade) => Math.abs(trade.r3) >= 0.50 },
  { name: 'volume < 2x', keep: (trade) => trade.volRatio < 2 },
  { name: 'volume outside 2-3x', keep: (trade) => trade.volRatio < 2 || trade.volRatio >= 3 },
  { name: 'h1 <= -0.40%', keep: (trade) => trade.h1 <= -0.40 },
  { name: 'h1 >= -0.40%', keep: (trade) => trade.h1 >= -0.40 },
  { name: 'strong move + impulse', keep: (trade) => Math.abs(trade.r3) >= 0.50 && trade.impulseRatio >= 1.8 },
];

console.log('\nHL Momentum confirm-long temporal audit');
console.log(`model ${HL_MOMENTUM_CALIBRATION_VERSION} · parsed ${trades.length}/${rows.length}`);
console.log(`range ${new Date(trades[0]?.opened_at ?? 0).toISOString()} -> ${new Date(trades.at(-1)?.closed_at ?? 0).toISOString()}\n`);

const temporalFolds = folds(trades);
console.log('Baseline chronological folds');
temporalFolds.forEach((fold, index) => {
  console.log(`  F${index + 1} trades ${fmt(tradeStats(fold))} · clusters ${fmt(clusterStats(fold))}`);
});

console.log('\nPredefined filters (all · recent 40 · four fold averages · five-minute clusters)');
for (const candidate of candidates) {
  const kept = trades.filter(candidate.keep);
  const recent = trades.slice(-40).filter(candidate.keep);
  const foldAverages = temporalFolds.map((fold) => tradeStats(fold.filter(candidate.keep)).average);
  const positiveFolds = foldAverages.filter((average) => average > 0).length;
  console.log(`\n${candidate.name}`);
  console.log(`  all      ${fmt(tradeStats(kept))}`);
  console.log(`  recent40 ${fmt(tradeStats(recent))}`);
  console.log(`  clusters ${fmt(clusterStats(kept))}`);
  console.log(`  folds    ${foldAverages.map(pct).join('  ')} · positive ${positiveFolds}/${FOLD_COUNT}`);
}

console.log('\nFeature bins');
const bins: Array<{ name: string; select: (trade: Trade) => string }> = [
  { name: 'impulse', select: (trade) => trade.impulseRatio < 1.2 ? '<1.2' : trade.impulseRatio < 1.5 ? '1.2-1.5' : trade.impulseRatio < 1.8 ? '1.5-1.8' : trade.impulseRatio < 2.1 ? '1.8-2.1' : '2.1+' },
  { name: '|r3|', select: (trade) => Math.abs(trade.r3) < 0.3 ? '<0.3' : Math.abs(trade.r3) < 0.4 ? '0.3-0.4' : Math.abs(trade.r3) < 0.5 ? '0.4-0.5' : '0.5+' },
  { name: 'volume', select: (trade) => trade.volRatio < 2 ? '<2' : trade.volRatio < 3 ? '2-3' : trade.volRatio < 4 ? '3-4' : '4+' },
  { name: 'h1', select: (trade) => trade.h1 < -0.75 ? '<-0.75' : trade.h1 < -0.4 ? '-0.75..-0.4' : trade.h1 < -0.2 ? '-0.4..-0.2' : trade.h1 < 0 ? '-0.2..0' : '0+' },
];

for (const bin of bins) {
  const grouped = new Map<string, Trade[]>();
  for (const trade of trades) {
    const key = bin.select(trade);
    const values = grouped.get(key) ?? [];
    values.push(trade);
    grouped.set(key, values);
  }
  console.log(`  ${bin.name}`);
  for (const [key, values] of grouped) console.log(`    ${key.padEnd(12)} ${fmt(tradeStats(values))}`);
}

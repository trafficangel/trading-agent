/**
 * Causal lead-lag and conservative maker-fill analyzer for collector output.
 *
 * Reads completed 15-minute gzip segments, computes a slowly moving HL/CEX
 * basis, and tests pre-registered lead/lag thresholds. Taker fills cross the
 * actual HL BBO. Maker fills require a strict trade-through of our quote, an
 * intentionally pessimistic proxy for clearing all displayed queue ahead.
 * Every row is also replayed with one 250ms latency step and +3bps cost stress.
 *
 * Usage: node dist/hft/leadlag-analyzer.js [data-dir] [hours]
 */

import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const DATA_DIR = resolve(process.argv[2] ?? process.env.HFT_DATA_DIR ?? 'data/hft-leadlag');
const HOURS = Number(process.argv[3] ?? 24);
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const RESULT_PATH = resolve(DATA_DIR, 'analysis.json');
const SAMPLE_MS = 250;
const TAKER_RT_BPS = 9;
const MAKER_TAKER_BPS = 6;
const EXTRA_STRESS_BPS = 3;
const LEAD_THRESHOLDS = [1, 2, 3, 4, 5];
const LAG_THRESHOLDS = [0.5, 1, 2, 3];
const HORIZONS_MS = [500, 1_000, 2_000, 5_000];
const MAKER_TTL_MS = 2_000;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];

type PackedRow = { v: number; t: number; s: string; h: number[]; b: number[]; y: number[]; f: Array<number | null>; x?: number[] };
type Point = {
  t: number;
  hlBid: number;
  hlAsk: number;
  hlBidSize: number;
  hlAskSize: number;
  binMid: number;
  byMid: number;
  hlBuyHigh: number | null;
  hlSellLow: number | null;
  hlPrints: number[];
  lagBps: number;
  leadBps: number;
  agrees: boolean;
};
type Metric = {
  signals: number;
  n: number;
  sum: number;
  stressSum: number;
  gains: number;
  losses: number;
  wins: number;
  lastExitByCoin: Map<string, number>;
  coinNet: Map<string, number>;
  days: Map<string, number>;
};
type Pair = { now: Metric; delayed: Metric };

const metric = (): Metric => ({ signals: 0, n: 0, sum: 0, stressSum: 0, gains: 0, losses: 0, wins: 0, lastExitByCoin: new Map(), coinNet: new Map(), days: new Map() });
const pairs = new Map<string, Pair>();
const pairFor = (key: string): Pair => {
  let pair = pairs.get(key);
  if (!pair) { pair = { now: metric(), delayed: metric() }; pairs.set(key, pair); }
  return pair;
};

function dayKey(t: number): string { return new Date(t).toISOString().slice(0, 10); }

function record(m: Metric, coin: string, entryAt: number, exitAt: number, netBps: number): void {
  if (entryAt <= (m.lastExitByCoin.get(coin) ?? 0)) return;
  m.n++;
  m.sum += netBps;
  m.stressSum += netBps - EXTRA_STRESS_BPS;
  if (netBps > 0) { m.wins++; m.gains += netBps; } else m.losses -= netBps;
  m.lastExitByCoin.set(coin, exitAt);
  m.coinNet.set(coin, (m.coinNet.get(coin) ?? 0) + netBps);
  const day = dayKey(exitAt);
  m.days.set(day, (m.days.get(day) ?? 0) + netBps);
}

function midpoint(book: number[]): number { return (book[0]! + book[1]!) / 2; }

async function readCoin(files: string[], coin: string): Promise<Point[]> {
  const raw: PackedRow[] = [];
  for (const path of files) {
    const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line) as PackedRow;
      if (row.v === 1 && row.s === coin) raw.push(row);
    }
  }
  raw.sort((a, b) => a.t - b.t);
  const points: Point[] = [];
  let basis = 0;
  const alpha = 1 / 240; // roughly one minute at 250ms
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]!;
    const hlMid = midpoint(row.h), binMid = midpoint(row.b), byMid = midpoint(row.y);
    const cexMid = (binMid + byMid) / 2;
    const observedBasis = hlMid / cexMid - 1;
    if (i === 0) basis = observedBasis;
    const fairHl = cexMid * (1 + basis);
    const lagBps = (fairHl / hlMid - 1) * 10_000;
    const prev = raw[Math.max(0, i - 2)]!;
    const binRet = (binMid / midpoint(prev.b) - 1) * 10_000;
    const byRet = (byMid / midpoint(prev.y) - 1) * 10_000;
    points.push({
      t: row.t,
      hlBid: row.h[0]!, hlAsk: row.h[1]!, hlBidSize: row.h[2]!, hlAskSize: row.h[3]!,
      binMid, byMid,
      hlBuyHigh: row.f[2] ?? null,
      hlSellLow: row.f[3] ?? null,
      hlPrints: row.x ?? [],
      lagBps,
      leadBps: (binRet + byRet) / 2,
      agrees: Math.sign(binRet) === Math.sign(byRet) && Math.sign(binRet) !== 0,
    });
    basis = (1 - alpha) * basis + alpha * observedBasis;
  }
  return points;
}

function grossBps(side: 1 | -1, entry: number, exit: number): number {
  return side * (exit - entry) / entry * 10_000;
}

function evaluate(points: Point[], coin: string): void {
  const ttlSteps = Math.round(MAKER_TTL_MS / SAMPLE_MS);
  for (const leadThreshold of LEAD_THRESHOLDS) for (const lagThreshold of LAG_THRESHOLDS) {
    for (let i = 240; i < points.length - 24; i++) {
      const signal = points[i]!;
      if (!signal.agrees || Math.abs(signal.leadBps) < leadThreshold) continue;
      const side: 1 | -1 = signal.leadBps > 0 ? 1 : -1;
      if (side * signal.lagBps < lagThreshold) continue;

      for (const horizonMs of HORIZONS_MS) {
        const horizonSteps = Math.round(horizonMs / SAMPLE_MS);
        const baseKey = `L${leadThreshold}_G${lagThreshold}_H${horizonMs}`;
        for (const delay of [0, 1] as const) {
          const startIdx = i + delay;
          const start = points[startIdx]!;
          const exit = points[startIdx + horizonSteps]!;

          const takerKey = `${baseKey}_TAKER`;
          const takerMetric = delay === 0 ? pairFor(takerKey).now : pairFor(takerKey).delayed;
          takerMetric.signals++;
          const takerEntry = side === 1 ? start.hlAsk : start.hlBid;
          const takerExit = side === 1 ? exit.hlBid : exit.hlAsk;
          record(takerMetric, coin, start.t, exit.t, grossBps(side, takerEntry, takerExit) - TAKER_RT_BPS);

          const makerKey = `${baseKey}_MAKER`;
          const makerMetric = delay === 0 ? pairFor(makerKey).now : pairFor(makerKey).delayed;
          makerMetric.signals++;
          const quote = side === 1 ? start.hlBid : start.hlAsk;
          let queueAhead = side === 1 ? start.hlBidSize : start.hlAskSize;
          let fillIdx = -1;
          for (let j = startIdx + 1; j <= Math.min(points.length - horizonSteps - 1, startIdx + ttlSteps); j++) {
            const p = points[j]!;
            for (let k = 0; k < p.hlPrints.length; k += 2) {
              const price = p.hlPrints[k]!; const signedSize = p.hlPrints[k + 1]!;
              const relevant = side === 1 ? signedSize < 0 && price <= quote : signedSize > 0 && price >= quote;
              if (!relevant) continue;
              const tradedThrough = side === 1 ? price < quote : price > quote;
              if (tradedThrough) { fillIdx = j; break; }
              queueAhead -= Math.abs(signedSize);
              if (queueAhead <= 0) { fillIdx = j; break; }
            }
            if (fillIdx >= 0) break;
          }
          if (fillIdx >= 0) {
            const makerExitPoint = points[fillIdx + horizonSteps]!;
            const makerExit = side === 1 ? makerExitPoint.hlBid : makerExitPoint.hlAsk;
            record(makerMetric, coin, points[fillIdx]!.t, makerExitPoint.t, grossBps(side, quote, makerExit) - MAKER_TAKER_BPS);
          }
        }
      }
    }
  }
  console.warn(`leadlag analyzed ${coin}: ${points.length} points`);
}

function summarize(key: string, pair: Pair) {
  const view = (m: Metric) => {
    const positiveDays = [...m.days.values()].filter((x) => x > 0).length;
    return {
      signals: m.signals,
      fills: m.n,
      fillRate: m.signals ? m.n / m.signals : 0,
      netBps: m.sum,
      stressNetBps: m.stressSum,
      meanBps: m.n ? m.sum / m.n : 0,
      winRate: m.n ? m.wins / m.n : 0,
      profitFactor: m.losses > 0 ? m.gains / m.losses : m.gains > 0 ? 99 : 0,
      positiveDays,
      days: m.days.size,
      positiveCoins: [...m.coinNet.values()].filter((x) => x > 0).length,
      coins: Object.fromEntries(m.coinNet),
    };
  };
  const now = view(pair.now), delayed = view(pair.delayed);
  return {
    key,
    now,
    delayed,
    passes: now.fills >= 30 && now.stressNetBps > 0 && delayed.stressNetBps > 0 && now.profitFactor >= 1.1 && now.positiveCoins >= 2 && now.days >= 2 && now.positiveDays / now.days >= 0.6,
  };
}

(async () => {
  if (!existsSync(DATA_DIR)) throw new Error(`missing data dir ${DATA_DIR}`);
  const status = existsSync(STATUS_PATH) ? JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as { currentPath?: string } : {};
  const current = status.currentPath ? basename(status.currentPath) : '';
  const cutoff = Date.now() - HOURS * 3_600_000;
  const files = readdirSync(DATA_DIR)
    .filter((name) => /^leadlag-\d{12}\.ndjson\.gz$/.test(name) && name !== current)
    .map((name) => resolve(DATA_DIR, name))
    .filter((path) => {
      const stamp = basename(path).slice(8, 20);
      const t = Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)), Number(stamp.slice(8, 10)), Number(stamp.slice(10, 12)));
      return t >= cutoff;
    })
    .sort();
  if (!files.length) throw new Error('no completed leadlag segments yet');

  for (const coin of COINS) evaluate(await readCoin(files, coin), coin);
  const rows = [...pairs.entries()].map(([key, pair]) => summarize(key, pair)).sort((a, b) =>
    Number(b.now.fills > 0) - Number(a.now.fills > 0) || b.now.stressNetBps - a.now.stressNetBps,
  );
  const result = {
    version: 'leadlag-analysis-v1',
    generatedAt: Date.now(),
    hoursRequested: HOURS,
    files: files.map((path) => basename(path)),
    costsBps: { takerRoundTrip: TAKER_RT_BPS, makerTaker: MAKER_TAKER_BPS, extraStress: EXTRA_STRESS_BPS },
    gates: { minFills: 30, minProfitFactor: 1.1, minPositiveDayFraction: 0.6, latencyStressMs: SAMPLE_MS },
    passing: rows.filter((row) => row.passes),
    topTaker: rows.filter((row) => row.key.endsWith('_TAKER') && row.now.fills > 0).slice(0, 20),
    topMaker: rows.filter((row) => row.key.endsWith('_MAKER') && row.now.fills > 0).slice(0, 20),
    noFillMaker: rows.filter((row) => row.key.endsWith('_MAKER') && row.now.signals > 0 && row.now.fills === 0).slice(0, 20),
  };
  const tmp = `${RESULT_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(result, null, 2));
  renameSync(tmp, RESULT_PATH);
  console.warn(`leadlag analysis: ${files.length} segments, ${result.passing.length} passing configs -> ${RESULT_PATH}`);
})().catch((error) => { console.error(error); process.exit(1); });

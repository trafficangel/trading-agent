/**
 * Bybit Post-Shock Absorption replay. Read-only: no private client or order path.
 *
 * Usage: node dist/hft/post-shock-analyzer.js [data-dir] [hours|all]
 */
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
import {
  detectPostShockAbsorptions,
  POST_SHOCK_ABSORPTION_V1,
  type AbsorptionPoint,
  type AbsorptionSignal,
} from '../lib/post-shock-absorption.js';
import {
  executePostShockSignal,
  POST_SHOCK_EXECUTION_V1,
  type PostShockExecutionProfile,
} from '../lib/post-shock-execution.js';

const DATA_DIR = resolve(process.argv[2] ?? process.env.HFT_DATA_DIR ?? 'data/hft-leadlag');
const HOURS_ARG = process.argv[3] ?? 'all';
const HOURS = HOURS_ARG === 'all' ? Number.POSITIVE_INFINITY : Number(HOURS_ARG);
if (HOURS_ARG !== 'all' && (!(HOURS > 0) || !Number.isFinite(HOURS))) {
  throw new Error('hours must be a positive number or "all"');
}
const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const RESULT_PATH = resolve(DATA_DIR, 'post-shock-analysis.json');

type PackedRow = {
  v: number;
  t: number;
  s: string;
  y: number[];
  f: Array<number | null>;
  z?: number[];
};

type ReplayPoint = AbsorptionPoint & { hlPrints: number[]; exactPrints: boolean };
type Profile = PostShockExecutionProfile & { name: string };
type Attempt = { coin: string; signalAt: number };
type Trade = {
  coin: string;
  signalAt: number;
  fillAt: number;
  exitAt: number;
  side: 1 | -1;
  netBps: number;
  reason: 'target-maker' | 'target-taker' | 'stop-taker' | 'time-taker';
};

const PROFILES: Profile[] = [
  { name: 'base-250ms', latencySteps: 1, queueMultiplier: 1.25, extraCostBps: 0 },
  { name: 'stress-500ms', latencySteps: 2, queueMultiplier: 1.5, extraCostBps: 2.5 },
  { name: 'severe-1000ms', latencySteps: 4, queueMultiplier: 2, extraCostBps: 4.5 },
];

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function fileTimestamp(name: string): number {
  const stamp = name.slice(8, 20);
  return Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
  );
}

async function readCoin(files: string[], coin: string): Promise<ReplayPoint[]> {
  const points: ReplayPoint[] = [];
  for (const path of files) {
    const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line) as PackedRow;
      if (row.v !== 1 || row.s !== coin || row.y.length < 6 || row.f.length < 15) continue;
      points.push({
        t: row.t,
        bid: row.y[0]!,
        ask: row.y[1]!,
        bidSize: row.y[2]!,
        askSize: row.y[3]!,
        bid5: row.y[4]!,
        ask5: row.y[5]!,
        buyQty: row.f[10] ?? 0,
        sellQty: row.f[11] ?? 0,
        hlPrints: row.z ?? [],
        exactPrints: Array.isArray(row.z),
      });
    }
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function evaluateCoin(
  coin: string,
  points: ReplayPoint[],
  signals: AbsorptionSignal[],
  profile: Profile,
): { attempts: Attempt[]; trades: Trade[] } {
  const attempts: Attempt[] = [];
  const trades: Trade[] = [];
  let nextAvailableAt = 0;
  for (const signal of signals) {
    const signalAt = points[signal.index]!.t;
    if (signalAt <= nextAvailableAt) continue;
    attempts.push({ coin, signalAt });
    const execution = executePostShockSignal(points, signal, profile, POST_SHOCK_EXECUTION_V1);
    if (!execution) continue;
    const trade = {
      coin,
      signalAt,
      fillAt: points[execution.fillIndex]!.t,
      exitAt: points[execution.exitIndex]!.t,
      side: execution.side,
      netBps: execution.netBps,
      reason: execution.reason,
    };
    trades.push(trade);
    nextAvailableAt = trade.exitAt;
  }
  return { attempts, trades };
}

function summarize(attempts: Attempt[], trades: Trade[]) {
  const ordered = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  let gains = 0;
  let losses = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownBps = 0;
  let best = Number.NEGATIVE_INFINITY;
  const dates = new Map<string, number>();
  const coins = new Map<string, number>();
  const reasons: Record<Trade['reason'], number> = {
    'target-maker': 0,
    'target-taker': 0,
    'stop-taker': 0,
    'time-taker': 0,
  };
  for (const trade of ordered) {
    equity += trade.netBps;
    peak = Math.max(peak, equity);
    maxDrawdownBps = Math.max(maxDrawdownBps, peak - equity);
    best = Math.max(best, trade.netBps);
    if (trade.netBps > 0) gains += trade.netBps;
    else losses -= trade.netBps;
    dates.set(dateKey(trade.exitAt), (dates.get(dateKey(trade.exitAt)) ?? 0) + trade.netBps);
    coins.set(trade.coin, (coins.get(trade.coin) ?? 0) + trade.netBps);
    reasons[trade.reason]++;
  }
  const netBps = ordered.reduce((sum, trade) => sum + trade.netBps, 0);
  const round = (value: number): number => Math.round(value * 10_000) / 10_000;
  return {
    signals: attempts.length,
    fills: ordered.length,
    fillRate: attempts.length ? round(ordered.length / attempts.length) : 0,
    netBps: round(netBps),
    meanBps: ordered.length ? round(netBps / ordered.length) : 0,
    profitFactor: losses > 0 ? round(gains / losses) : gains > 0 ? 99 : 0,
    winRate: ordered.length ? round(ordered.filter((trade) => trade.netBps > 0).length / ordered.length) : 0,
    maxDrawdownBps: round(maxDrawdownBps),
    withoutBestBps: ordered.length ? round(netBps - best) : 0,
    positiveDates: [...dates.values()].filter((value) => value > 0).length,
    dates: dates.size,
    positiveCoins: [...coins.values()].filter((value) => value > 0).length,
    coins: Object.fromEntries(coins),
    reasons,
  };
}

function withinDates<T extends { signalAt: number }>(rows: T[], dates: Set<string>): T[] {
  return rows.filter((row) => dates.has(dateKey(row.signalAt)));
}

async function main(): Promise<void> {
  if (!existsSync(DATA_DIR)) throw new Error(`missing data dir ${DATA_DIR}`);
  const status = existsSync(STATUS_PATH)
    ? JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as { markets?: string[]; currentPath?: string }
    : {};
  const current = status.currentPath ? basename(status.currentPath) : '';
  const cutoff = Number.isFinite(HOURS) ? Date.now() - HOURS * 3_600_000 : 0;
  const files = readdirSync(DATA_DIR)
    .filter((name) => /^leadlag-\d{12}\.ndjson\.gz$/.test(name) && name !== current)
    .filter((name) => fileTimestamp(name) >= cutoff)
    .sort()
    .map((name) => resolve(DATA_DIR, name));
  if (!files.length) throw new Error('no completed replay segments');
  const dates = [...new Set(files.map((path) => dateKey(fileTimestamp(basename(path)))))].sort();
  const split = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * 0.6)));
  const inSampleDates = new Set(dates.slice(0, split));
  const outOfSampleDates = new Set(dates.slice(split));
  const coins = status.markets?.length ? status.markets : ['BTC', 'ETH', 'SOL', 'XRP'];

  const aggregate = new Map(PROFILES.map((profile) => [profile.name, { attempts: [] as Attempt[], trades: [] as Trade[] }]));
  let pointsRead = 0;
  let exactPrintPoints = 0;
  let detectedSignals = 0;
  for (const coin of coins) {
    const points = await readCoin(files, coin);
    const signals = detectPostShockAbsorptions(points, POST_SHOCK_ABSORPTION_V1);
    pointsRead += points.length;
    exactPrintPoints += points.filter((point) => point.exactPrints).length;
    detectedSignals += signals.length;
    for (const profile of PROFILES) {
      const result = evaluateCoin(coin, points, signals, profile);
      aggregate.get(profile.name)!.attempts.push(...result.attempts);
      aggregate.get(profile.name)!.trades.push(...result.trades);
    }
    console.warn(`post-shock ${coin}: ${points.length} points, ${signals.length} causal signals`);
  }

  const profiles = Object.fromEntries(PROFILES.map((profile) => {
    const rows = aggregate.get(profile.name)!;
    return [profile.name, {
      config: profile,
      all: summarize(rows.attempts, rows.trades),
      inSample: summarize(withinDates(rows.attempts, inSampleDates), withinDates(rows.trades, inSampleDates)),
      outOfSample: summarize(withinDates(rows.attempts, outOfSampleDates), withinDates(rows.trades, outOfSampleDates)),
    }];
  }));
  const gate = profiles['stress-500ms']!.outOfSample;
  const positiveDateFraction = gate.dates ? gate.positiveDates / gate.dates : 0;
  const researchPass = gate.fills >= 30
    && gate.netBps > 0
    && gate.withoutBestBps > 0
    && gate.profitFactor >= 1.2
    && gate.maxDrawdownBps <= 200
    && gate.positiveCoins >= 3
    && positiveDateFraction >= 2 / 3;
  const liveEligible = researchPass && gate.fills >= 500 && gate.dates >= 30;
  const exactCoverage = pointsRead ? exactPrintPoints / pointsRead : 0;
  const verdict = exactCoverage < 0.99
    ? 'DATA_UPGRADE_REQUIRED'
    : liveEligible
      ? 'LIVE_CANARY_REVIEW'
      : researchPass
        ? 'RESEARCH_PASS_NOT_LIVE'
        : gate.fills < 30
          ? 'COLLECT_MORE'
          : 'REJECT';
  const result = {
    version: 'post-shock-absorption-v1',
    generatedAt: Date.now(),
    files: files.map((path) => basename(path)),
    coins,
    dates,
    inSampleDates: [...inSampleDates],
    outOfSampleDates: [...outOfSampleDates],
    pointsRead,
    exactPrintPoints,
    exactPrintCoverage: exactCoverage,
    detectedSignals,
    signalConfig: POST_SHOCK_ABSORPTION_V1,
    execution: {
      entryTtlMs: POST_SHOCK_EXECUTION_V1.entryTtlSteps * POST_SHOCK_EXECUTION_V1.sampleMs,
      maxHoldMs: POST_SHOCK_EXECUTION_V1.maxHoldSteps * POST_SHOCK_EXECUTION_V1.sampleMs,
      stopExtensionFraction: POST_SHOCK_EXECUTION_V1.stopExtensionFraction,
      makerFeeBps: POST_SHOCK_EXECUTION_V1.makerFeeBps,
      takerFeeBps: POST_SHOCK_EXECUTION_V1.takerFeeBps,
    },
    gates: {
      research: 'stress-500ms OOS: >=30 fills, net and net-without-best >0, PF>=1.2, maxDD<=200bps, >=3 positive coins, >=2/3 positive dates',
      live: 'research pass plus >=500 OOS fills across >=30 OOS dates',
    },
    verdict,
    researchPass,
    liveEligible,
    profiles,
  };
  const temporary = `${RESULT_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(result, null, 2));
  renameSync(temporary, RESULT_PATH);
  console.warn(`post-shock verdict=${verdict} exact=${(exactCoverage * 100).toFixed(1)}% OOS fills=${gate.fills} net=${gate.netBps} PF=${gate.profitFactor}`);
  console.warn(`post-shock result -> ${RESULT_PATH}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

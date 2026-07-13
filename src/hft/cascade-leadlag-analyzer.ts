/**
 * Cascade Lead-Lag replay. Read-only: no private client or order path.
 *
 * Usage: node dist/hft/cascade-leadlag-analyzer.js [data-dir] [hours|all]
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
  CASCADE_EXECUTION_V1,
  CASCADE_LEADLAG_V1,
  detectCascadeLeadLagSignals,
  executeCascadeSignal,
  type CascadeExecutionProfile,
  type CascadePoint,
  type CascadeSignal,
} from '../lib/cascade-leadlag.js';

const DATA_DIR = resolve(process.argv[2] ?? process.env.HFT_DATA_DIR ?? 'data/hft-leadlag');
const HOURS_ARG = process.argv[3] ?? 'all';
const HOURS = HOURS_ARG === 'all' ? Number.POSITIVE_INFINITY : Number(HOURS_ARG);
if (HOURS_ARG !== 'all' && (!(HOURS > 0) || !Number.isFinite(HOURS))) {
  throw new Error('hours must be a positive number or "all"');
}

const STATUS_PATH = resolve(DATA_DIR, 'status.json');
const RESULT_PATH = resolve(DATA_DIR, 'cascade-leadlag-analysis.json');
const LEADERS = ['BTC', 'ETH', 'SOL'];
const DEFAULT_LAGGERS = ['ETH', 'SOL', 'XRP', 'UNI', 'VIRTUAL', 'JUP', 'SAGA'];
const PROFILES: Array<CascadeExecutionProfile & { name: string }> = [
  { name: 'base-250ms', latencySteps: 1, extraCostBps: 0 },
  { name: 'stress-500ms', latencySteps: 2, extraCostBps: 3 },
  { name: 'severe-1000ms', latencySteps: 4, extraCostBps: 6 },
];

type PackedRow = {
  v: number;
  t: number;
  s: string;
  b: number[];
  y: number[];
  f: Array<number | null>;
};
type Attempt = { pair: string; signalAt: number };
type Trade = {
  pair: string;
  leader: string;
  lagger: string;
  signalAt: number;
  entryAt: number;
  exitAt: number;
  side: 1 | -1;
  netBps: number;
  reason: 'target-taker' | 'stop-taker' | 'time-taker';
};

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

async function readCoin(files: string[], coin: string): Promise<CascadePoint[]> {
  const points: CascadePoint[] = [];
  for (const path of files) {
    const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line) as PackedRow;
      if (row.v !== 1 || row.s !== coin || row.b.length < 2 || row.y.length < 6 || row.f.length < 15) continue;
      points.push({
        t: row.t,
        bid: row.y[0]!,
        ask: row.y[1]!,
        bid5: row.y[4]!,
        ask5: row.y[5]!,
        binanceBid: row.b[0]!,
        binanceAsk: row.b[1]!,
        bybitBid: row.y[0]!,
        bybitAsk: row.y[1]!,
        buyQty: row.f[10] ?? 0,
        sellQty: row.f[11] ?? 0,
      });
    }
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function alignByTimestamp(leader: CascadePoint[], lagger: CascadePoint[]): [CascadePoint[], CascadePoint[]] {
  const alignedLeader: CascadePoint[] = [];
  const alignedLagger: CascadePoint[] = [];
  let i = 0;
  let j = 0;
  while (i < leader.length && j < lagger.length) {
    const lt = leader[i]!.t;
    const gt = lagger[j]!.t;
    if (lt === gt) {
      alignedLeader.push(leader[i]!);
      alignedLagger.push(lagger[j]!);
      i++;
      j++;
    } else if (lt < gt) i++;
    else j++;
  }
  return [alignedLeader, alignedLagger];
}

function evaluatePair(
  leaderName: string,
  laggerName: string,
  leader: CascadePoint[],
  lagger: CascadePoint[],
  profile: CascadeExecutionProfile,
): { attempts: Attempt[]; trades: Trade[]; rawSignals: CascadeSignal[] } {
  const pair = `${leaderName}->${laggerName}`;
  const [alignedLeader, alignedLagger] = alignByTimestamp(leader, lagger);
  const rawSignals = detectCascadeLeadLagSignals(leaderName, laggerName, alignedLeader, alignedLagger);
  const attempts: Attempt[] = [];
  const trades: Trade[] = [];
  let nextAvailableAt = 0;
  for (const signal of rawSignals) {
    const signalAt = alignedLagger[signal.index]!.t;
    if (signalAt <= nextAvailableAt) continue;
    attempts.push({ pair, signalAt });
    const execution = executeCascadeSignal(alignedLagger, signal, profile);
    if (!execution) continue;
    const trade: Trade = {
      pair,
      leader: leaderName,
      lagger: laggerName,
      signalAt,
      entryAt: alignedLagger[execution.entryIndex]!.t,
      exitAt: alignedLagger[execution.exitIndex]!.t,
      side: execution.side,
      netBps: execution.netBps,
      reason: execution.reason,
    };
    trades.push(trade);
    nextAvailableAt = trade.exitAt;
  }
  return { attempts, trades, rawSignals };
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
  const pairs = new Map<string, number>();
  const laggers = new Map<string, number>();
  const reasons: Record<Trade['reason'], number> = {
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
    pairs.set(trade.pair, (pairs.get(trade.pair) ?? 0) + trade.netBps);
    laggers.set(trade.lagger, (laggers.get(trade.lagger) ?? 0) + trade.netBps);
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
    positivePairs: [...pairs.values()].filter((value) => value > 0).length,
    pairs: Object.fromEntries(pairs),
    positiveLaggers: [...laggers.values()].filter((value) => value > 0).length,
    laggers: Object.fromEntries(laggers),
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
  const markets = status.markets?.length ? status.markets : [...LEADERS, ...DEFAULT_LAGGERS];
  const laggers = DEFAULT_LAGGERS.filter((coin) => markets.includes(coin));

  const aggregate = new Map(PROFILES.map((profile) => [profile.name, { attempts: [] as Attempt[], trades: [] as Trade[] }]));
  const rawSignalCounts: Record<string, number> = {};
  for (const leader of LEADERS) {
    if (!markets.includes(leader)) continue;
    const leaderPoints = await readCoin(files, leader);
    console.warn(`cascade leader ${leader}: ${leaderPoints.length} points`);
    if (!leaderPoints.length) continue;
    for (const lagger of laggers) {
      if (lagger === leader) continue;
      const laggerPoints = await readCoin(files, lagger);
      console.warn(`cascade pair ${leader}->${lagger}: ${laggerPoints.length} lagger points`);
      if (!laggerPoints.length) continue;
      for (const profile of PROFILES) {
        const result = evaluatePair(leader, lagger, leaderPoints, laggerPoints, profile);
        aggregate.get(profile.name)!.attempts.push(...result.attempts);
        aggregate.get(profile.name)!.trades.push(...result.trades);
        if (profile.name === PROFILES[0]!.name) rawSignalCounts[`${leader}->${lagger}`] = result.rawSignals.length;
      }
    }
  }

  const profiles: Record<string, unknown> = {};
  for (const profile of PROFILES) {
    const rows = aggregate.get(profile.name)!;
    profiles[profile.name] = {
      config: profile,
      all: summarize(rows.attempts, rows.trades),
      inSample: summarize(withinDates(rows.attempts, inSampleDates), withinDates(rows.trades, inSampleDates)),
      outOfSample: summarize(withinDates(rows.attempts, outOfSampleDates), withinDates(rows.trades, outOfSampleDates)),
    };
  }
  const gate = (profiles['stress-500ms'] as { outOfSample: ReturnType<typeof summarize> }).outOfSample;
  const researchPass = gate.fills >= 30
    && gate.netBps > 0
    && gate.withoutBestBps > 0
    && gate.profitFactor >= 1.2
    && gate.maxDrawdownBps <= 250
    && gate.positivePairs >= 3
    && gate.positiveDates >= Math.ceil(Math.max(1, gate.dates) * 2 / 3);
  const liveEligible = researchPass && gate.fills >= 500 && gate.dates >= 30;
  const verdict = liveEligible ? 'LIVE_CANARY_REVIEW' : researchPass ? 'RESEARCH_PASS_NOT_LIVE' : 'REJECT';

  const result = {
    version: 'cascade-leadlag-v1',
    generatedAt: Date.now(),
    files: files.map((path) => basename(path)),
    leaders: LEADERS,
    laggers,
    dates,
    inSampleDates: [...inSampleDates],
    outOfSampleDates: [...outOfSampleDates],
    signalConfig: CASCADE_LEADLAG_V1,
    execution: CASCADE_EXECUTION_V1,
    gates: {
      research: 'stress-500ms OOS: >=30 fills, net and net-without-best >0, PF>=1.2, maxDD<=250bps, >=3 positive pairs, >=2/3 positive traded OOS dates',
      live: 'research pass plus >=500 OOS fills across >=30 OOS dates',
    },
    rawSignalCounts,
    verdict,
    researchPass,
    liveEligible,
    profiles,
  };
  const tmp = `${RESULT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, RESULT_PATH);
  console.warn(`cascade verdict=${verdict} OOS fills=${gate.fills} net=${gate.netBps} PF=${gate.profitFactor}`);
  console.warn(`cascade result -> ${RESULT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

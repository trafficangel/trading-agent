/**
 * Fail-closed research sweep over the prospectively recorded Lighter feed.
 *
 * The six rules are frozen in lighter-microstructure-research.ts. This script
 * cannot run exploratory research before seven ready days or candidate
 * selection before 21 ready days. It never writes trading state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  type LighterFundingPoint,
  type LighterFundingSeries,
} from '../src/lib/lighter-funding-history.js';
import {
  rollupLighterMicrostructureFiveMinute,
  type StoredMicrostructureMinute,
} from '../src/lib/lighter-microstructure.js';
import {
  buildCausalMicroFeatureBars,
  evaluateMicrostructureRule,
  PREREGISTERED_MICRO_RULES,
  simulateMicrostructureRule,
} from '../src/lib/lighter-microstructure-research.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3_600;
const FUNDING_CHUNK_SECONDS = 28 * 86_400;
const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai';
const TIMEFRAMES = [1, 5] as const;
const RULE_VARIANTS = TIMEFRAMES.flatMap((timeframeMinutes) =>
  PREREGISTERED_MICRO_RULES.map((rule) => `${timeframeMinutes}m:${rule.id}`));
type Mode = 'exploratory' | 'frozen';
type Audit = {
  generatedAt: string;
  gates: {
    exploratoryResearch: { passed: boolean; failures: string[] };
    frozenCandidateResearch: { passed: boolean; failures: string[] };
  };
};
type DbRow = {
  market_id: number;
  symbol: string;
  minute_ts_ms: number;
  samples: number;
  book_updates: number;
  nonce_gaps: number;
  stale_samples: number;
  mid_open: number | null;
  mid_high: number | null;
  mid_low: number | null;
  mid_close: number | null;
  spread_avg_pct: number | null;
  spread_max_pct: number | null;
  bid5_usd_avg: number | null;
  ask5_usd_avg: number | null;
  depth_imbalance_avg: number | null;
  depth_imbalance_close: number | null;
  book_age_avg_ms: number | null;
  book_age_p95_ms: number | null;
  exec_cost_100_samples: number;
  exec_cost_100_avg_pct: number | null;
  exec_cost_100_p95_pct: number | null;
  exec_cost_100_max_pct: number | null;
  buy_usd: number;
  sell_usd: number;
  cvd_usd: number;
  trade_count: number;
  liquidation_buy_usd: number;
  liquidation_sell_usd: number;
  index_price: number | null;
  mark_price: number | null;
  basis_pct: number | null;
  current_funding_rate: number | null;
  last_funding_rate: number | null;
  quality_ok: number;
};

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

function output(report: unknown): void {
  const serialized = JSON.stringify(report, null, 2);
  const target = flagValue('--output');
  if (target) writeAtomic(resolve(target), report);
  console.log(serialized);
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'robotclaude-native-microstructure-funding/1.0',
        },
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok || Number(body.code) !== 200) {
        throw new Error(`http_${response.status}:${String(body.message ?? body.code)}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('funding_api_retry_exhausted');
}

async function exactFundingForRows(rows: readonly DbRow[]): Promise<{
  byMarket: Map<number, LighterFundingSeries>;
  coverage: Record<string, ReturnType<typeof fundingSeriesCoverage>>;
}> {
  const ranges = new Map<number, { symbol: string; startMs: number; endMs: number }>();
  for (const row of rows) {
    const current = ranges.get(row.market_id);
    if (!current) {
      ranges.set(row.market_id, {
        symbol: row.symbol,
        startMs: row.minute_ts_ms,
        endMs: row.minute_ts_ms + 5 * 60_000,
      });
    } else {
      current.startMs = Math.min(current.startMs, row.minute_ts_ms);
      current.endMs = Math.max(current.endMs, row.minute_ts_ms + 5 * 60_000);
    }
  }

  const byMarket = new Map<number, LighterFundingSeries>();
  const coverage: Record<string, ReturnType<typeof fundingSeriesCoverage>> = {};
  for (const [marketId, range] of ranges) {
    const startSeconds = Math.floor(range.startMs / 1_000) - HOUR_SECONDS;
    const endSeconds = Math.ceil(range.endMs / 1_000) + HOUR_SECONDS;
    const points = new Map<number, LighterFundingPoint>();
    for (
      let chunkStart = startSeconds;
      chunkStart <= endSeconds;
      chunkStart += FUNDING_CHUNK_SECONDS
    ) {
      const chunkEnd = Math.min(endSeconds, chunkStart + FUNDING_CHUNK_SECONDS - 1);
      const url = new URL(`${LIGHTER_BASE_URL}/api/v1/fundings`);
      for (const [key, value] of Object.entries({
        market_id: marketId,
        resolution: '1h',
        start_timestamp: chunkStart,
        end_timestamp: chunkEnd,
        count_back: 0,
      })) url.searchParams.set(key, String(value));
      const body = await getJson(url.toString());
      const fundings = Array.isArray(body.fundings) ? body.fundings : [];
      for (const item of fundings) {
        const row = item as Record<string, unknown>;
        const timestampMs = Number(row.timestamp) * 1_000;
        const ratePctH = Math.abs(Number(row.rate));
        const direction = String(row.direction).toLowerCase();
        if (
          timestampMs > 0
          && Number.isFinite(ratePctH)
          && (direction === 'long' || direction === 'short')
        ) {
          points.set(timestampMs, {
            timestampMs,
            ratePctH,
            direction,
          });
        }
      }
    }
    const series = buildLighterFundingSeries([...points.values()]);
    const status = fundingSeriesCoverage(series, range.startMs, range.endMs);
    if (!status.covered) {
      throw new Error(
        `${range.symbol}: exact funding coverage ${(status.internalCoverage * 100).toFixed(2)}%`,
      );
    }
    byMarket.set(marketId, series);
    coverage[range.symbol] = status;
  }
  return { byMarket, coverage };
}

function stored(row: DbRow): StoredMicrostructureMinute {
  return {
    marketId: row.market_id,
    symbol: row.symbol,
    minuteTsMs: row.minute_ts_ms,
    samples: row.samples,
    bookUpdates: row.book_updates,
    nonceGaps: row.nonce_gaps,
    staleSamples: row.stale_samples,
    midOpen: row.mid_open,
    midHigh: row.mid_high,
    midLow: row.mid_low,
    midClose: row.mid_close,
    spreadAvgPct: row.spread_avg_pct,
    spreadMaxPct: row.spread_max_pct,
    bid5UsdAvg: row.bid5_usd_avg,
    ask5UsdAvg: row.ask5_usd_avg,
    depthImbalanceAvg: row.depth_imbalance_avg,
    depthImbalanceClose: row.depth_imbalance_close,
    bookAgeAvgMs: row.book_age_avg_ms,
    bookAgeP95Ms: row.book_age_p95_ms,
    execCost100Samples: row.exec_cost_100_samples,
    execCost100AvgPct: row.exec_cost_100_avg_pct,
    execCost100P95Pct: row.exec_cost_100_p95_pct,
    execCost100MaxPct: row.exec_cost_100_max_pct,
    buyUsd: row.buy_usd,
    sellUsd: row.sell_usd,
    cvdUsd: row.cvd_usd,
    tradeCount: row.trade_count,
    liquidationBuyUsd: row.liquidation_buy_usd,
    liquidationSellUsd: row.liquidation_sell_usd,
    indexPrice: row.index_price,
    markPrice: row.mark_price,
    basisPct: row.basis_pct,
    currentFundingRate: row.current_funding_rate,
    lastFundingRate: row.last_funding_rate,
    qualityOk: row.quality_ok === 1,
  };
}

const modeValue = flagValue('--mode') ?? 'frozen';
if (modeValue !== 'exploratory' && modeValue !== 'frozen') {
  throw new Error('--mode must be exploratory or frozen');
}
const mode = modeValue as Mode;
const databasePath = resolve(
  flagValue('--db') ?? process.env.LIGHTER_MICRO_DB ?? 'data/lighter-native-microstructure.sqlite',
);
const auditPath = resolve(
  flagValue('--audit')
    ?? process.env.LIGHTER_MICRO_AUDIT
    ?? 'data/lighter-native-microstructure-audit.json',
);
const generatedAt = new Date().toISOString();
if (!existsSync(auditPath)) {
  output({ version: 'lighter-microstructure-sweep-v3', generatedAt, mode, status: 'not_ready', failures: ['readiness audit missing'] });
  process.exit(0);
}
const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as Audit;
const auditAgeMs = Date.now() - Date.parse(audit.generatedAt);
const selectedGate = mode === 'frozen'
  ? audit.gates.frozenCandidateResearch
  : audit.gates.exploratoryResearch;
const readinessFailures = [
  ...(Number.isFinite(auditAgeMs) && auditAgeMs <= 2 * HOUR_MS
    ? []
    : [`readiness audit stale: ${Math.round(auditAgeMs / 60_000)}m`]),
  ...selectedGate.failures,
];
if (!selectedGate.passed || readinessFailures.length) {
  output({
    version: 'lighter-microstructure-sweep-v3',
    generatedAt,
    mode,
    status: 'not_ready',
    auditGeneratedAt: audit.generatedAt,
    failures: readinessFailures,
    rules: RULE_VARIANTS,
  });
  process.exit(0);
}
if (!existsSync(databasePath)) throw new Error(`microstructure database missing: ${databasePath}`);

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT * FROM lighter_microstructure_1m
  ORDER BY market_id, minute_ts_ms
`).all() as DbRow[];
db.close();

let exactFunding: Awaited<ReturnType<typeof exactFundingForRows>>;
try {
  exactFunding = await exactFundingForRows(rows);
} catch (error) {
  output({
    version: 'lighter-microstructure-sweep-v3',
    generatedAt,
    mode,
    status: 'not_ready',
    failures: [error instanceof Error ? error.message : String(error)],
    rules: RULE_VARIANTS,
  });
  process.exit(0);
}

const buckets = new Map<string, StoredMicrostructureMinute[]>();
for (const row of rows.map(stored)) {
  const bucket = Math.floor(row.minuteTsMs / (5 * 60_000)) * (5 * 60_000);
  const key = `${row.marketId}:${bucket}`;
  const source = buckets.get(key) ?? [];
  source.push(row);
  buckets.set(key, source);
}
const fiveMinute = [...buckets.values()]
  .map((source) => rollupLighterMicrostructureFiveMinute(source))
  .filter((row) => row != null);
const oneMinute = rows.map(stored).filter((row) => row.qualityOk);
const featureSets = [
  { timeframeMinutes: 1 as const, features: buildCausalMicroFeatureBars(oneMinute, 1) },
  { timeframeMinutes: 5 as const, features: buildCausalMicroFeatureBars(fiveMinute, 5) },
];
const firstMinuteByMarket = new Map<number, number>();
for (const row of rows) {
  firstMinuteByMarket.set(
    row.market_id,
    Math.min(firstMinuteByMarket.get(row.market_id) ?? Number.POSITIVE_INFINITY, row.minute_ts_ms),
  );
}
const commonDatasetStartMs = Math.max(...firstMinuteByMarket.values());
const discoveryCutoffMs = commonDatasetStartMs + 7 * DAY_MS;
const evaluations = featureSets.flatMap(({ timeframeMinutes, features }) =>
  PREREGISTERED_MICRO_RULES.map((rule) => ({
    timeframeMinutes,
    ...evaluateMicrostructureRule(
      rule.id,
      simulateMicrostructureRule(features, rule, exactFunding.byMarket),
      10,
      discoveryCutoffMs,
    ),
  })));
const featureSummary = Object.fromEntries(featureSets.map(({ timeframeMinutes, features }) => [
  `${timeframeMinutes}m`,
  {
    rows: features.length,
    rollingCostMarkets: new Set(
      features
        .filter((feature) => feature.executionCostPct != null)
        .map((feature) => feature.symbol),
    ).size,
  },
]));

output({
  version: 'lighter-microstructure-sweep-v3',
  generatedAt,
  mode,
  status: 'evaluated',
  selectionBiasWarning: mode === 'exploratory'
    ? 'Exploratory output cannot qualify a Shadow candidate.'
    : null,
  input: {
    databasePath,
    auditGeneratedAt: audit.generatedAt,
    oneMinuteRows: rows.length,
    validFiveMinuteRows: fiveMinute.length,
    featureSummary,
    commonDatasetStartAt: new Date(commonDatasetStartMs).toISOString(),
    discoveryCutoffAt: new Date(discoveryCutoffMs).toISOString(),
    executionCostSource: 'completed signal-bar $100 p95; native minute p95 at 1m and max of five causal minute p95 values at 5m',
    adverseExecutionCostSource: 'completed signal-bar worst actually observed $100 round trip; sensitivity only',
    fundingSource: 'exact public Lighter hourly settlements in (entry, exit]',
    fundingCoverage: exactFunding.coverage,
  },
  gates: {
    minimumTrades: 120,
    minimumProfitFactor: 1.2,
    adverseExecution: 'observed maximum; no fixed percentage or multiplier',
    maximumPortfolioDrawdownPct: 5,
    minimumDepthUsdPerSide: 500,
    bothSides: true,
    chronologicalThirds: 3,
    discoveryDays: 7,
    frozenOos: { minimumTrades: 60, minimumProfitFactor: 1.1, minimumTradesPerSide: 15 },
    causalTrendAndVolatilityRegimes: true,
    marketBreadthAndLeaveOneOut: true,
  },
  shadowEligibleRules: mode === 'frozen'
    ? evaluations
      .filter((row) => row.qualified)
      .map((row) => `${row.timeframeMinutes}m:${row.ruleId}`)
    : [],
  autoPromotion: false,
  evaluations,
});

/** Read-only readiness audit for the prospective Lighter microstructure dataset. */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const EXPECTED_MARKETS = 15;
const MIN_QUALITY_RATIO = 0.95;
const RECENT_HEALTH_MINUTES = 120;

type MinuteStatsRow = {
  market_id: number;
  symbol: string;
  first_minute: number;
  last_minute: number;
  rows: number;
  quality_rows: number;
  execution_cost_rows: number;
  nonce_gaps: number;
  stale_samples: number;
  avg_book_age_p95_ms: number | null;
  avg_execution_cost_pct: number | null;
  avg_execution_cost_p95_pct: number | null;
  max_execution_cost_p95_pct: number | null;
};

type FiveMinuteStatsRow = {
  market_id: number;
  valid_buckets: number;
};

type LatestExecutionCostRow = {
  market_id: number;
  minute_ts_ms: number;
  execution_cost_avg_pct: number | null;
  execution_cost_p95_pct: number | null;
};

type RecentHealthRow = {
  market_id: number;
  rows: number;
  quality_rows: number;
  execution_cost_rows: number;
  nonce_gaps: number;
};

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const databasePath = resolve(
  flagValue('--db') ?? process.env.LIGHTER_MICRO_DB ?? 'data/lighter-native-microstructure.sqlite',
);
const windowDays = Math.max(1, Number(flagValue('--days') ?? 60));
if (!existsSync(databasePath))
  throw new Error(`microstructure database not found: ${databasePath}`);

const now = Date.now();
const closedMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
const cutoff = closedMinute - windowDays * DAY_MS;
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const tableColumns = new Set(
  (db.pragma('table_info(lighter_microstructure_1m)') as Array<{ name: string }>)
    .map((column) => column.name),
);
const hasRollingExecutionCost = tableColumns.has('exec_cost_100_p95_pct')
  && tableColumns.has('exec_cost_100_samples');
const executionCostRowsSql = hasRollingExecutionCost
  ? `COALESCE(SUM(CASE WHEN quality_ok = 1
      AND exec_cost_100_p95_pct IS NOT NULL
      AND exec_cost_100_samples >= samples * 0.8
      THEN 1 ELSE 0 END), 0)`
  : '0';
const fiveMinuteExecutionCostCountSql = hasRollingExecutionCost
  ? `SUM(CASE WHEN exec_cost_100_p95_pct IS NOT NULL
      AND exec_cost_100_samples >= samples * 0.8
      THEN 1 ELSE 0 END)`
  : '0';
const executionCostStatsSql = hasRollingExecutionCost
  ? `AVG(CASE WHEN quality_ok = 1
      AND exec_cost_100_p95_pct IS NOT NULL
      AND exec_cost_100_samples >= samples * 0.8
      THEN exec_cost_100_avg_pct END) AS avg_execution_cost_pct,
    AVG(CASE WHEN quality_ok = 1
      AND exec_cost_100_p95_pct IS NOT NULL
      AND exec_cost_100_samples >= samples * 0.8
      THEN exec_cost_100_p95_pct END) AS avg_execution_cost_p95_pct,
    MAX(CASE WHEN quality_ok = 1
      AND exec_cost_100_p95_pct IS NOT NULL
      AND exec_cost_100_samples >= samples * 0.8
      THEN exec_cost_100_p95_pct END) AS max_execution_cost_p95_pct`
  : `NULL AS avg_execution_cost_pct,
    NULL AS avg_execution_cost_p95_pct,
    NULL AS max_execution_cost_p95_pct`;

const minuteRows = db
  .prepare(
    `
  SELECT
    market_id,
    symbol,
    MIN(minute_ts_ms) AS first_minute,
    MAX(minute_ts_ms) AS last_minute,
    COUNT(*) AS rows,
    COALESCE(SUM(quality_ok), 0) AS quality_rows,
    ${executionCostRowsSql} AS execution_cost_rows,
    COALESCE(SUM(nonce_gaps), 0) AS nonce_gaps,
    COALESCE(SUM(stale_samples), 0) AS stale_samples,
    AVG(book_age_p95_ms) AS avg_book_age_p95_ms,
    ${executionCostStatsSql}
  FROM lighter_microstructure_1m
  WHERE minute_ts_ms >= ? AND minute_ts_ms < ?
  GROUP BY market_id, symbol
  ORDER BY market_id
`,
  )
  .all(cutoff, closedMinute) as MinuteStatsRow[];

const latestExecutionCostRows = hasRollingExecutionCost
  ? db.prepare(
    `
      SELECT
        current.market_id,
        current.minute_ts_ms,
        current.exec_cost_100_avg_pct AS execution_cost_avg_pct,
        current.exec_cost_100_p95_pct AS execution_cost_p95_pct
      FROM lighter_microstructure_1m AS current
      WHERE current.minute_ts_ms < ?
        AND current.quality_ok = 1
        AND current.exec_cost_100_p95_pct IS NOT NULL
        AND current.exec_cost_100_samples >= current.samples * 0.8
        AND current.minute_ts_ms = (
          SELECT MAX(latest.minute_ts_ms)
          FROM lighter_microstructure_1m AS latest
          WHERE latest.market_id = current.market_id
            AND latest.minute_ts_ms < ?
            AND latest.quality_ok = 1
            AND latest.exec_cost_100_p95_pct IS NOT NULL
            AND latest.exec_cost_100_samples >= latest.samples * 0.8
        )
      ORDER BY current.market_id
    `,
  ).all(closedMinute, closedMinute) as LatestExecutionCostRow[]
  : [];

const recentHealthRows = db.prepare(
  `
    SELECT
      market_id,
      COUNT(*) AS rows,
      COALESCE(SUM(quality_ok), 0) AS quality_rows,
      ${executionCostRowsSql} AS execution_cost_rows,
      COALESCE(SUM(nonce_gaps), 0) AS nonce_gaps
    FROM lighter_microstructure_1m
    WHERE minute_ts_ms >= ? AND minute_ts_ms < ?
    GROUP BY market_id
    ORDER BY market_id
  `,
).all(
  closedMinute - RECENT_HEALTH_MINUTES * MINUTE_MS,
  closedMinute,
) as RecentHealthRow[];

const fiveMinuteRows = db
  .prepare(
    `
  WITH buckets AS (
    SELECT
      market_id,
      CAST(minute_ts_ms / 300000 AS INTEGER) * 300000 AS bucket,
      COUNT(*) AS source_minutes,
      SUM(quality_ok) AS quality_minutes,
      MIN(minute_ts_ms) AS first_minute,
      MAX(minute_ts_ms) AS last_minute,
      SUM(nonce_gaps) AS nonce_gaps,
      ${fiveMinuteExecutionCostCountSql} AS execution_cost_minutes
    FROM lighter_microstructure_1m
    WHERE minute_ts_ms >= ? AND minute_ts_ms < ?
    GROUP BY market_id, bucket
  )
  SELECT
    market_id,
    SUM(CASE WHEN
      source_minutes = 5
      AND quality_minutes = 5
      AND first_minute = bucket
      AND last_minute = bucket + 240000
      AND nonce_gaps = 0
      AND execution_cost_minutes = 5
      THEN 1 ELSE 0 END) AS valid_buckets
  FROM buckets
  GROUP BY market_id
`,
  )
  .all(cutoff, closedMinute) as FiveMinuteStatsRow[];
db.close();

const fiveByMarket = new Map(fiveMinuteRows.map((row) => [row.market_id, row.valid_buckets]));
const latestExecutionCostByMarket = new Map(
  latestExecutionCostRows.map((row) => [row.market_id, row]),
);
const perMarket = minuteRows.map((row) => {
  const expectedMinutes = Math.floor((row.last_minute - row.first_minute) / MINUTE_MS) + 1;
  const firstFullFiveMinute = Math.ceil(row.first_minute / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const lastFullFiveMinute =
    Math.floor(
      (Math.min(row.last_minute + MINUTE_MS, closedMinute) - FIVE_MINUTES_MS) / FIVE_MINUTES_MS,
    ) * FIVE_MINUTES_MS;
  const expectedFiveMinuteBuckets =
    lastFullFiveMinute >= firstFullFiveMinute
      ? Math.floor((lastFullFiveMinute - firstFullFiveMinute) / FIVE_MINUTES_MS) + 1
      : 0;
  const validFiveMinuteBuckets = fiveByMarket.get(row.market_id) ?? 0;
  const latestExecutionCost = latestExecutionCostByMarket.get(row.market_id);
  return {
    marketId: row.market_id,
    symbol: row.symbol,
    firstMinute: new Date(row.first_minute).toISOString(),
    lastMinute: new Date(row.last_minute).toISOString(),
    durationDays: (row.last_minute - row.first_minute + MINUTE_MS) / DAY_MS,
    expectedMinutes,
    observedMinutes: row.rows,
    qualityMinutes: row.quality_rows,
    executionCostMinutes: row.execution_cost_rows,
    coverageRatio: expectedMinutes ? row.rows / expectedMinutes : 0,
    qualityRatio: expectedMinutes ? row.quality_rows / expectedMinutes : 0,
    executionCostRatio: expectedMinutes ? row.execution_cost_rows / expectedMinutes : 0,
    validFiveMinuteBuckets,
    expectedFiveMinuteBuckets,
    fiveMinuteQualityRatio: expectedFiveMinuteBuckets
      ? validFiveMinuteBuckets / expectedFiveMinuteBuckets
      : 0,
    nonceGaps: row.nonce_gaps,
    staleSamples: row.stale_samples,
    avgBookAgeP95Ms: row.avg_book_age_p95_ms,
    avgExecutionCostPct: row.avg_execution_cost_pct,
    avgExecutionCostP95Pct: row.avg_execution_cost_p95_pct,
    maxExecutionCostP95Pct: row.max_execution_cost_p95_pct,
    latestExecutionCostMinute: latestExecutionCost
      ? new Date(latestExecutionCost.minute_ts_ms).toISOString()
      : null,
    latestExecutionCostAvgPct: latestExecutionCost?.execution_cost_avg_pct ?? null,
    latestExecutionCostP95Pct: latestExecutionCost?.execution_cost_p95_pct ?? null,
    freshnessMs: now - row.last_minute,
  };
});

const minimum = (values: number[]): number => (values.length ? Math.min(...values) : 0);
const maximum = (values: number[]): number =>
  values.length ? Math.max(...values) : Number.POSITIVE_INFINITY;
const allMarketsPresent = perMarket.length === EXPECTED_MARKETS;
const minDurationDays = minimum(perMarket.map((row) => row.durationDays));
const minCoverageRatio = minimum(perMarket.map((row) => row.coverageRatio));
const minQualityRatio = minimum(perMarket.map((row) => row.qualityRatio));
const minExecutionCostRatio = minimum(perMarket.map((row) => row.executionCostRatio));
const minFiveMinuteQualityRatio = minimum(perMarket.map((row) => row.fiveMinuteQualityRatio));
const maxFreshnessMs = maximum(perMarket.map((row) => row.freshnessMs));
const totalNonceGaps = perMarket.reduce((sum, row) => sum + row.nonceGaps, 0);
const latestExecutionCostP95Values = perMarket
  .map((row) => row.latestExecutionCostP95Pct)
  .filter((value): value is number => value != null && Number.isFinite(value));
const minLatestExecutionCostP95Pct = minimum(latestExecutionCostP95Values);
const maxLatestExecutionCostP95Pct = latestExecutionCostP95Values.length
  ? Math.max(...latestExecutionCostP95Values)
  : 0;
const recentMarkets = recentHealthRows.length;
const minRecentCoverageRatio = minimum(
  recentHealthRows.map((row) => row.rows / RECENT_HEALTH_MINUTES),
);
const minRecentQualityRatio = minimum(
  recentHealthRows.map((row) => row.quality_rows / RECENT_HEALTH_MINUTES),
);
const minRecentExecutionCostRatio = minimum(
  recentHealthRows.map((row) => row.execution_cost_rows / RECENT_HEALTH_MINUTES),
);
const recentNonceGaps = recentHealthRows.reduce((sum, row) => sum + row.nonce_gaps, 0);

function reasons(minDays: number, requireFiveMinute: boolean): string[] {
  const failures: string[] = [];
  if (!allMarketsPresent) failures.push(`markets ${perMarket.length}/${EXPECTED_MARKETS}`);
  if (minDurationDays < minDays)
    failures.push(`history ${minDurationDays.toFixed(3)}d < ${minDays}d`);
  if (minCoverageRatio < MIN_QUALITY_RATIO) {
    failures.push(`1m coverage ${(minCoverageRatio * 100).toFixed(2)}% < 95%`);
  }
  if (minQualityRatio < MIN_QUALITY_RATIO) {
    failures.push(`1m quality ${(minQualityRatio * 100).toFixed(2)}% < 95%`);
  }
  if (minExecutionCostRatio < MIN_QUALITY_RATIO) {
    failures.push(
      `$100 rolling execution cost ${(minExecutionCostRatio * 100).toFixed(2)}% < 95%`,
    );
  }
  if (requireFiveMinute && minFiveMinuteQualityRatio < MIN_QUALITY_RATIO) {
    failures.push(`5m quality ${(minFiveMinuteQualityRatio * 100).toFixed(2)}% < 95%`);
  }
  if (maxFreshnessMs > 3 * MINUTE_MS)
    failures.push(`freshness ${Math.round(maxFreshnessMs / 1000)}s > 180s`);
  return failures;
}

const healthFailures = reasons(1, false);
const exploratoryFailures = reasons(7, true);
const frozenResearchFailures = reasons(21, true);
const report = {
  version: 'lighter-microstructure-audit-v3',
  generatedAt: new Date(now).toISOString(),
  databasePath,
  windowDays,
  thresholds: {
    expectedMarkets: EXPECTED_MARKETS,
    minimumQualityRatio: MIN_QUALITY_RATIO,
    rollingExecutionNotionalUsd: 100,
    healthHistoryDays: 1,
    exploratoryHistoryDays: 7,
    frozenResearchHistoryDays: 21,
  },
  summary: {
    markets: perMarket.length,
    minDurationDays,
    minCoverageRatio,
    minQualityRatio,
    minExecutionCostRatio,
    minFiveMinuteQualityRatio,
    totalNonceGaps,
    maxFreshnessMs,
    latestExecutionCostMarkets: latestExecutionCostP95Values.length,
    minLatestExecutionCostP95Pct,
    maxLatestExecutionCostP95Pct,
    recentWindowMinutes: RECENT_HEALTH_MINUTES,
    recentMarkets,
    minRecentCoverageRatio,
    minRecentQualityRatio,
    minRecentExecutionCostRatio,
    recentNonceGaps,
  },
  gates: {
    collectionHealthy: { passed: healthFailures.length === 0, failures: healthFailures },
    exploratoryResearch: {
      passed: exploratoryFailures.length === 0,
      failures: exploratoryFailures,
    },
    frozenCandidateResearch: {
      passed: frozenResearchFailures.length === 0,
      failures: frozenResearchFailures,
    },
  },
  perMarket,
};

const serialized = JSON.stringify(report, null, 2);
const outputPath = flagValue('--output');
if (outputPath) {
  const absoluteOutputPath = resolve(outputPath);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });
  const temporaryPath = `${absoluteOutputPath}.tmp`;
  writeFileSync(temporaryPath, serialized);
  renameSync(temporaryPath, absoluteOutputPath);
}
console.log(serialized);

/**
 * Deterministic prospective Shadow accounting for the immutable 21d-selected
 * Lighter microstructure cohort. Read-only market data only; this file imports
 * no signer, account endpoint or order client.
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
import { buildCausalMicroFeatureBars } from '../src/lib/lighter-microstructure-research.js';
import {
  buildMicrostructureShadowReport,
  frozenMicrostructureReportSha256,
  prospectiveMicrostructureShadowTrades,
  validateMicrostructureShadowManifest,
} from '../src/lib/lighter-microstructure-shadow.js';
import { existingImmutableFrozenMicrostructureReport } from '../src/lib/lighter-microstructure-research.js';

const HOUR_MS = 3_600_000;
const WARMUP_MS = 5 * HOUR_MS;
const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai';

type DbRow = {
  market_id: number; symbol: string; minute_ts_ms: number; samples: number;
  book_updates: number; nonce_gaps: number; stale_samples: number;
  mid_open: number | null; mid_high: number | null; mid_low: number | null;
  mid_close: number | null; spread_avg_pct: number | null; spread_max_pct: number | null;
  bid5_usd_avg: number | null; ask5_usd_avg: number | null;
  depth_imbalance_avg: number | null; depth_imbalance_close: number | null;
  book_age_avg_ms: number | null; book_age_p95_ms: number | null;
  exec_cost_100_samples: number; exec_cost_100_avg_pct: number | null;
  exec_cost_100_p95_pct: number | null; exec_cost_100_max_pct: number | null;
  buy_usd: number; sell_usd: number; cvd_usd: number; trade_count: number;
  liquidation_buy_usd: number; liquidation_sell_usd: number;
  index_price: number | null; mark_price: number | null; basis_pct: number | null;
  current_funding_rate: number | null; last_funding_rate: number | null;
  quality_ok: number;
};

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

function stored(row: DbRow): StoredMicrostructureMinute {
  return {
    marketId: row.market_id, symbol: row.symbol, minuteTsMs: row.minute_ts_ms,
    samples: row.samples, bookUpdates: row.book_updates, nonceGaps: row.nonce_gaps,
    staleSamples: row.stale_samples, midOpen: row.mid_open, midHigh: row.mid_high,
    midLow: row.mid_low, midClose: row.mid_close, spreadAvgPct: row.spread_avg_pct,
    spreadMaxPct: row.spread_max_pct, bid5UsdAvg: row.bid5_usd_avg,
    ask5UsdAvg: row.ask5_usd_avg, depthImbalanceAvg: row.depth_imbalance_avg,
    depthImbalanceClose: row.depth_imbalance_close, bookAgeAvgMs: row.book_age_avg_ms,
    bookAgeP95Ms: row.book_age_p95_ms, execCost100Samples: row.exec_cost_100_samples,
    execCost100AvgPct: row.exec_cost_100_avg_pct,
    execCost100P95Pct: row.exec_cost_100_p95_pct,
    execCost100MaxPct: row.exec_cost_100_max_pct, buyUsd: row.buy_usd,
    sellUsd: row.sell_usd, cvdUsd: row.cvd_usd, tradeCount: row.trade_count,
    liquidationBuyUsd: row.liquidation_buy_usd,
    liquidationSellUsd: row.liquidation_sell_usd, indexPrice: row.index_price,
    markPrice: row.mark_price, basisPct: row.basis_pct,
    currentFundingRate: row.current_funding_rate, lastFundingRate: row.last_funding_rate,
    qualityOk: row.quality_ok === 1,
  };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'robotclaude-micro-shadow/1.0' },
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok || Number(body.code) !== 200) {
        throw new Error(`http_${response.status}:${String(body.message ?? body.code)}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('funding_api_retry_exhausted');
}

async function fundingForRows(rows: readonly DbRow[]): Promise<Map<number, LighterFundingSeries>> {
  const ranges = new Map<number, { symbol: string; startMs: number; endMs: number }>();
  for (const row of rows) {
    const range = ranges.get(row.market_id) ?? {
      symbol: row.symbol, startMs: row.minute_ts_ms, endMs: row.minute_ts_ms,
    };
    range.startMs = Math.min(range.startMs, row.minute_ts_ms);
    range.endMs = Math.max(range.endMs, row.minute_ts_ms + 30 * 60_000);
    ranges.set(row.market_id, range);
  }
  const result = new Map<number, LighterFundingSeries>();
  for (const [marketId, range] of ranges) {
    const start = Math.floor(range.startMs / 1_000) - 3_600;
    const end = Math.ceil(range.endMs / 1_000) + 3_600;
    const url = new URL(`${LIGHTER_BASE_URL}/api/v1/fundings`);
    for (const [key, value] of Object.entries({
      market_id: marketId, resolution: '1h', start_timestamp: start,
      end_timestamp: end, count_back: 0,
    })) url.searchParams.set(key, String(value));
    const body = await getJson(url.toString());
    const points: LighterFundingPoint[] = [];
    for (const item of Array.isArray(body.fundings) ? body.fundings : []) {
      const value = item as Record<string, unknown>;
      const timestampMs = Number(value.timestamp) * 1_000;
      const ratePctH = Math.abs(Number(value.rate));
      const direction = String(value.direction).toLowerCase();
      if (timestampMs > 0 && Number.isFinite(ratePctH)
        && (direction === 'long' || direction === 'short')) {
        points.push({ timestampMs, ratePctH, direction });
      }
    }
    const series = buildLighterFundingSeries(points);
    const coverage = fundingSeriesCoverage(series, range.startMs, range.endMs);
    if (!coverage.covered) {
      throw new Error(`${range.symbol}: exact funding coverage ${(coverage.internalCoverage * 100).toFixed(2)}%`);
    }
    result.set(marketId, series);
  }
  return result;
}

const databasePath = resolve(flagValue('--db') ?? 'data/lighter-native-microstructure.sqlite');
const frozenPath = resolve(flagValue('--frozen') ?? 'data/lighter-native-microstructure-sweep.json');
const manifestPath = resolve(flagValue('--manifest') ?? 'data/lighter-native-microstructure-shadow-manifest.json');
const outputPath = resolve(flagValue('--output') ?? 'data/lighter-native-microstructure-shadow-report.json');
if (!existsSync(frozenPath)) throw new Error(`frozen report missing: ${frozenPath}`);
if (!existsSync(manifestPath)) {
  console.log(JSON.stringify({ status: 'waiting_for_immutable_selection', realEnabled: false }));
  process.exit(0);
}
if (!existsSync(databasePath)) throw new Error(`microstructure database missing: ${databasePath}`);

const frozen = existingImmutableFrozenMicrostructureReport(readJson(frozenPath));
if (!frozen) throw new Error('immutable frozen report missing after Shadow activation');
const manifest = validateMicrostructureShadowManifest(
  readJson(manifestPath),
  frozenMicrostructureReportSha256(frozen),
);
if (manifest.status === 'no_candidates') {
  const report = buildMicrostructureShadowReport(manifest, [], Date.now());
  writeAtomic(outputPath, report);
  console.log(JSON.stringify(report));
  process.exit(0);
}

const activatedAtMs = Date.parse(manifest.activatedAt);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT * FROM lighter_microstructure_1m
  WHERE minute_ts_ms >= ?
  ORDER BY market_id, minute_ts_ms
`).all(activatedAtMs - WARMUP_MS) as DbRow[];
db.close();
const storedRows = rows.map(stored);
const oneMinute = storedRows.filter((row) => row.qualityOk);
const buckets = new Map<string, StoredMicrostructureMinute[]>();
for (const row of storedRows) {
  const bucket = Math.floor(row.minuteTsMs / 300_000) * 300_000;
  const key = `${row.marketId}:${bucket}`;
  const values = buckets.get(key) ?? [];
  values.push(row);
  buckets.set(key, values);
}
const fiveMinute = [...buckets.values()]
  .map((values) => rollupLighterMicrostructureFiveMinute(values))
  .filter((value) => value != null);
const features = new Map<1 | 5, ReturnType<typeof buildCausalMicroFeatureBars>>([
  [1, buildCausalMicroFeatureBars(oneMinute, 1)],
  [5, buildCausalMicroFeatureBars(fiveMinute, 5)],
]);
const funding = rows.length ? await fundingForRows(rows) : new Map<number, LighterFundingSeries>();
const nowMs = Date.now();
const trades = prospectiveMicrostructureShadowTrades(manifest, features, funding, nowMs);
const report = buildMicrostructureShadowReport(manifest, trades, nowMs);
writeAtomic(outputPath, report);
console.log(JSON.stringify(report));

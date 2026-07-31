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
const COST_FILES = [
  'data/lighter-execution-costs-majors-20260731.json',
  'data/lighter-execution-costs-zec-doge-near-jup.json',
  'data/lighter-execution-costs-lit-pump-gram-xmr.json',
  'data/lighter-execution-costs-popcat-ena-arb-tao.json',
  'data/lighter-execution-costs-hype-20260731.json',
  // The research portfolio is sized at $100. Keep this override last.
  'data/lighter-execution-costs-native-portfolio-100-20260731.json',
] as const;

type Mode = 'exploratory' | 'frozen';
type Audit = {
  generatedAt: string;
  gates: {
    exploratoryResearch: { passed: boolean; failures: string[] };
    frozenCandidateResearch: { passed: boolean; failures: string[] };
  };
};
type CostFile = {
  notionalUsd?: number;
  summaries?: Record<string, { p95Pct?: number }>;
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

function executionCosts(): Map<string, number> {
  const result = new Map<string, number>();
  for (const relative of COST_FILES) {
    const path = resolve(relative);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CostFile;
    for (const [symbol, summary] of Object.entries(parsed.summaries ?? {})) {
      if (Number.isFinite(summary.p95Pct) && Number(summary.p95Pct) >= 0) {
        result.set(symbol, Number(summary.p95Pct));
      }
    }
  }
  return result;
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
  output({ version: 'lighter-microstructure-sweep-v1', generatedAt, mode, status: 'not_ready', failures: ['readiness audit missing'] });
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
    version: 'lighter-microstructure-sweep-v1',
    generatedAt,
    mode,
    status: 'not_ready',
    auditGeneratedAt: audit.generatedAt,
    failures: readinessFailures,
    rules: PREREGISTERED_MICRO_RULES.map((rule) => rule.id),
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
const features = buildCausalMicroFeatureBars(fiveMinute);
const costs = executionCosts();
const evaluations = PREREGISTERED_MICRO_RULES.map((rule) =>
  evaluateMicrostructureRule(
    rule.id,
    simulateMicrostructureRule(features, rule, costs),
  ));

output({
  version: 'lighter-microstructure-sweep-v1',
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
    featureRows: features.length,
    measuredCostMarkets: costs.size,
  },
  gates: {
    minimumTrades: 120,
    minimumProfitFactor: 1.2,
    adverseCostMultiplier: 1.5,
    maximumPortfolioDrawdownPct: 5,
    minimumDepthUsdPerSide: 500,
    bothSides: true,
    chronologicalThirds: 3,
    causalTrendAndVolatilityRegimes: true,
    marketBreadthAndLeaveOneOut: true,
  },
  shadowEligibleRules: mode === 'frozen'
    ? evaluations.filter((row) => row.qualified).map((row) => row.ruleId)
    : [],
  autoPromotion: false,
  evaluations,
});

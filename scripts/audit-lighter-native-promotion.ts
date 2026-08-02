/**
 * Read-only, canonical Shadow -> Real promotion audit for Native Quant.
 * It writes evidence only; it never toggles a strategy or sends an order.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  evaluateNativeForwardRows,
  nativePromotionDecision,
  NATIVE_FORWARD_GATE,
  NATIVE_SHADOW_NOTIONAL_USD,
  type NativeForwardPnlRow,
  type NativeForwardSignalRow,
} from '../src/lib/lighter-luxalgo-math.js';
import { evaluateNativeHistoricalEvidence } from '../src/lib/lighter-native-historical.js';
import {
  NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS,
  NATIVE_P2_PORTFOLIO_STRATEGY_IDS,
  NATIVE_P3_PORTFOLIO_STRATEGY_IDS,
} from '../src/lib/lighter-native-strategy-lifecycle.js';
import {
  evaluateNativeRunnerLiveness,
  LIGHTER_NATIVE_RUNNER_STATUS_KEY,
  parseNativeRunnerStatus,
} from '../src/lib/lighter-native-runner-status.js';

const REAL_NATIVE_IDS: readonly string[] = [];
const LATENCY_EVIDENCE_VERSION = 'lighter-native-entry-delay-audit-v1';
const LATENCY_EVIDENCE_SHA256 =
  'a6d1cf2b5e8aa5625fe001eb87f6334e223a9f3879b6921ee336156c19ac2ded';
const XLM_CONFLUENCE_LATENCY_EVIDENCE_SHA256 =
  '89a0453021b9a9adcadead95b7a02c7da38a1facefd2f17a65206653566b4052';
const HYPE_CONFLUENCE_LATENCY_EVIDENCE_SHA256 =
  '93b9abca3696ea12aaeb61acac29c76aa91ac89def21a9dcb2955e57ad2360d9';
const HYPE_BB_WILLIAMS_LATENCY_EVIDENCE_SHA256 =
  'a0d083b41ab27f187c957ff6831b03a69cd32c8df6442a3df11e6306c2742646';
const P2_LATENCY_EVIDENCE_VERSION = 'lighter-p2-entry-delay-portfolio-audit-v1';
const P2_LATENCY_EVIDENCE_SHA256 =
  'ef7361a77d619d39b620c0422e5e1491f5f8b1f1063f36f41c2212fd4f7c4cd3';
const P2_MEMBER_LATENCY_EVIDENCE_SHA256 =
  '39c13fba1a766d931014b1be302fbaf98da52746ba3dbfa15327ab0fd96ce901';
const SHADOW_NATIVE_IDS = NATIVE_ACTIVE_STANDALONE_STRATEGY_IDS;
const P2_IDS = NATIVE_P2_PORTFOLIO_STRATEGY_IDS;
const P3_IDS = NATIVE_P3_PORTFOLIO_STRATEGY_IDS;
const P3_PARENT_IDS = P3_IDS.map((id) => id.replace('z60stack25p3-', 'z60stack25-'));
const RUNNER_REQUIRED_IDS = [...SHADOW_NATIVE_IDS, ...P2_IDS, ...P3_IDS];

type LatencyEvidenceRow = {
  strategyId: string;
  passed: boolean;
  observedProductionDataReadySeconds: number;
  conservativeDelayedScenarioSeconds: number;
  delayedOneMinute: {
    trades: number;
    netPctUnits: number;
    profitFactor: number | null;
    maxDrawdownPct: number;
    meanL95Pct: number | null;
    positiveFolds: number;
    longPctUnits: number;
    shortPctUnits: number;
  };
  delayedNetRetention: number;
};

type P2LatencyEvidence = {
  version: string;
  source: { sha256: string };
  assumptions: {
    positionNotionalUsd: number;
    maxOpen: number;
    delayedFill: string;
  };
  allMembers: {
    memberIds: string[];
    delayedNetRetention: number;
    passed: boolean;
    delayed: {
      trades: number;
      netUsd: number;
      profitFactor: number;
      maxDrawdownCapitalPct: number;
      meanL95Pct: number;
      positiveFolds: number;
      longPctUnits: number;
      shortPctUnits: number;
    };
  };
  positiveExecutionSubset: {
    status: string;
    memberIds: string[];
    excludedMemberIds: string[];
    passedHistoricalLatencyGate: boolean;
    delayed: {
      trades: number;
      netPctUnits: number;
      netUsd: number;
      profitFactor: number;
      maxDrawdownCapitalPct: number;
      meanL95Pct: number;
      positiveFolds: number;
      longPctUnits: number;
      shortPctUnits: number;
      positiveSymbols: number;
      activeSymbols: number;
    };
  };
  realPromotion: boolean;
};

function latencyEvidenceRows(value: unknown): Map<string, LatencyEvidenceRow> {
  if (!value || typeof value !== 'object') throw new Error('latency evidence is not an object');
  const report = value as { version?: unknown; strategies?: unknown };
  if (report.version !== LATENCY_EVIDENCE_VERSION) {
    throw new Error(`latency evidence version mismatch: ${String(report.version)}`);
  }
  if (!Array.isArray(report.strategies)) throw new Error('latency evidence strategies missing');
  const rows = new Map<string, LatencyEvidenceRow>();
  for (const valueRow of report.strategies) {
    if (!valueRow || typeof valueRow !== 'object') throw new Error('invalid latency evidence row');
    const row = valueRow as Partial<LatencyEvidenceRow>;
    if (typeof row.strategyId !== 'string' || typeof row.passed !== 'boolean') {
      throw new Error('invalid latency evidence strategy row');
    }
    if (rows.has(row.strategyId)) throw new Error(`duplicate latency evidence: ${row.strategyId}`);
    rows.set(row.strategyId, row as LatencyEvidenceRow);
  }
  return rows;
}

function readLatencyEvidence(
  path: string,
  expectedSha256: string,
  label: string,
): { sha256: string; rows: Map<string, LatencyEvidenceRow> } {
  if (!existsSync(path)) throw new Error(`${label} latency evidence missing: ${path}`);
  const raw = readFileSync(path);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== expectedSha256) {
    throw new Error(`${label} latency evidence hash mismatch: ${sha256}`);
  }
  return {
    sha256,
    rows: latencyEvidenceRows(JSON.parse(raw.toString('utf8'))),
  };
}

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function sqlMarks(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

const databasePath = resolve(flagValue('--db') ?? 'data/trading.sqlite');
if (!existsSync(databasePath)) throw new Error(`trading database missing: ${databasePath}`);
const historicalPath = resolve(
  flagValue('--historical') ?? 'data/lighter-native-current-z60-validation.json',
);
if (!existsSync(historicalPath)) throw new Error(`historical evidence missing: ${historicalPath}`);
const supplementalHistoricalPath = resolve(
  flagValue('--historical-supplement') ?? 'data/lighter-vwz60-holdout-validation.json',
);
if (!existsSync(supplementalHistoricalPath)) {
  throw new Error(`supplemental historical evidence missing: ${supplementalHistoricalPath}`);
}
const xlmSupplementalHistoricalPath = resolve(
  flagValue('--historical-xlm-supplement') ?? 'data/lighter-vwz60-transfer2-validation.json',
);
if (!existsSync(xlmSupplementalHistoricalPath)) {
  throw new Error(`XLM supplemental historical evidence missing: ${xlmSupplementalHistoricalPath}`);
}
const dataSupplementalHistoricalPath = resolve(
  flagValue('--historical-data-supplement')
    ?? 'data/lighter-data-vwz60-1m-rebuild-validation.json',
);
if (!existsSync(dataSupplementalHistoricalPath)) {
  throw new Error(`DATA supplemental historical evidence missing: ${dataSupplementalHistoricalPath}`);
}
const rsiSupplementalHistoricalPath = resolve(
  flagValue('--historical-rsi-supplement')
    ?? 'data/lighter-rsi14-trend-transfer-validation.json',
);
if (!existsSync(rsiSupplementalHistoricalPath)) {
  throw new Error(`RSI supplemental historical evidence missing: ${rsiSupplementalHistoricalPath}`);
}
const zecConfluenceHistoricalPath = resolve(
  flagValue('--historical-zec-confluence')
    ?? 'data/lighter-zec-confluence-regime-validation.json',
);
if (!existsSync(zecConfluenceHistoricalPath)) {
  throw new Error(`ZEC confluence historical evidence missing: ${zecConfluenceHistoricalPath}`);
}
const dataConfluenceHistoricalPath = resolve(
  flagValue('--historical-data-confluence')
    ?? 'data/lighter-data-confluence-regime-validation.json',
);
if (!existsSync(dataConfluenceHistoricalPath)) {
  throw new Error(`DATA confluence historical evidence missing: ${dataConfluenceHistoricalPath}`);
}
const latencyEvidencePath = resolve(
  flagValue('--latency') ?? 'data/lighter-native-active-entry-delay-audit-20260802.json',
);
const xlmConfluenceLatencyEvidencePath = resolve(
  flagValue('--latency-xlm-confluence')
    ?? 'data/lighter-xlm-vwz-williams-entry-delay-20260802.json',
);
const hypeConfluenceLatencyEvidencePath = resolve(
  flagValue('--latency-hype-confluence')
    ?? 'data/lighter-hype-vwz-stochastic-entry-delay-20260802.json',
);
const hypeBbWilliamsLatencyEvidencePath = resolve(
  flagValue('--latency-hype-bb-williams')
    ?? 'data/lighter-hype-bb-willr-entry-delay-audit-20260802.json',
);
const latencyEvidence = readLatencyEvidence(
  latencyEvidencePath,
  LATENCY_EVIDENCE_SHA256,
  'base',
);
const xlmConfluenceLatencyEvidence = readLatencyEvidence(
  xlmConfluenceLatencyEvidencePath,
  XLM_CONFLUENCE_LATENCY_EVIDENCE_SHA256,
  'XLM confluence',
);
const hypeConfluenceLatencyEvidence = readLatencyEvidence(
  hypeConfluenceLatencyEvidencePath,
  HYPE_CONFLUENCE_LATENCY_EVIDENCE_SHA256,
  'HYPE confluence',
);
const hypeBbWilliamsLatencyEvidence = readLatencyEvidence(
  hypeBbWilliamsLatencyEvidencePath,
  HYPE_BB_WILLIAMS_LATENCY_EVIDENCE_SHA256,
  'HYPE Bollinger Williams',
);
const latencyByStrategy = new Map<string, LatencyEvidenceRow>();
for (const source of [
  latencyEvidence,
  xlmConfluenceLatencyEvidence,
  hypeConfluenceLatencyEvidence,
  hypeBbWilliamsLatencyEvidence,
]) {
  for (const [strategyId, row] of source.rows) {
    if (latencyByStrategy.has(strategyId)) {
      throw new Error(`duplicate latency evidence across sources: ${strategyId}`);
    }
    latencyByStrategy.set(strategyId, row);
  }
}
const p2LatencyEvidencePath = resolve(
  flagValue('--p2-latency') ?? 'data/lighter-p2-entry-delay-portfolio-20260802.json',
);
if (!existsSync(p2LatencyEvidencePath)) {
  throw new Error(`P2 latency evidence missing: ${p2LatencyEvidencePath}`);
}
const p2LatencyEvidenceRaw = readFileSync(p2LatencyEvidencePath);
const p2LatencyEvidenceSha256 = createHash('sha256')
  .update(p2LatencyEvidenceRaw).digest('hex');
if (p2LatencyEvidenceSha256 !== P2_LATENCY_EVIDENCE_SHA256) {
  throw new Error(`P2 latency evidence hash mismatch: ${p2LatencyEvidenceSha256}`);
}
const p2LatencyEvidence = JSON.parse(
  p2LatencyEvidenceRaw.toString('utf8'),
) as P2LatencyEvidence;
if (p2LatencyEvidence.version !== P2_LATENCY_EVIDENCE_VERSION) {
  throw new Error(`P2 latency evidence version mismatch: ${p2LatencyEvidence.version}`);
}
if (p2LatencyEvidence.source.sha256 !== P2_MEMBER_LATENCY_EVIDENCE_SHA256) {
  throw new Error(`P2 member latency evidence hash mismatch: ${p2LatencyEvidence.source.sha256}`);
}
if (p2LatencyEvidence.assumptions.positionNotionalUsd !== NATIVE_SHADOW_NOTIONAL_USD
    || p2LatencyEvidence.assumptions.maxOpen !== 10) {
  throw new Error('P2 latency evidence assumptions mismatch');
}
if (p2LatencyEvidence.allMembers.memberIds.length !== P2_IDS.length
    || P2_IDS.some((id) => !p2LatencyEvidence.allMembers.memberIds.includes(id))) {
  throw new Error('P2 latency evidence members mismatch');
}
if (!p2LatencyEvidence.positiveExecutionSubset.passedHistoricalLatencyGate
    || p2LatencyEvidence.positiveExecutionSubset.memberIds.length !== P3_PARENT_IDS.length
    || P3_PARENT_IDS.some(
      (id) => !p2LatencyEvidence.positiveExecutionSubset.memberIds.includes(id),
    )) {
  throw new Error('P3 frozen parent evidence members/gate mismatch');
}
const historicalEvidence = evaluateNativeHistoricalEvidence(
  JSON.parse(readFileSync(historicalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(supplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(xlmSupplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(dataSupplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(rsiSupplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(zecConfluenceHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(dataConfluenceHistoricalPath, 'utf8')) as unknown,
);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const runnerStatusRaw = db.prepare<[string], { value: string }>(`
  SELECT value FROM runtime_config WHERE key = ?
`).get(LIGHTER_NATIVE_RUNNER_STATUS_KEY)?.value ?? null;
const runnerLiveness = evaluateNativeRunnerLiveness(
  parseNativeRunnerStatus(runnerStatusRaw),
  RUNNER_REQUIRED_IDS,
  Date.now(),
);
const pnlStatement = db.prepare<[string], NativeForwardPnlRow>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id = ? AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    AND funding_source = 'lighter_api_settlements'
  ORDER BY closed_at, id`);
const signalStatement = db.prepare<[string], NativeForwardSignalRow>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals WHERE strategy_id = ?
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);
const portfolioPnls = db.prepare<string[], NativeForwardPnlRow>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id IN (${sqlMarks(P2_IDS.length)})
    AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    AND funding_source = 'lighter_api_settlements'
  ORDER BY closed_at, id`);
const portfolioSignals = db.prepare<string[], NativeForwardSignalRow>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals
  WHERE strategy_id IN (${sqlMarks(P2_IDS.length)})
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);
const p3PortfolioPnls = db.prepare<string[], NativeForwardPnlRow>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id IN (${sqlMarks(P3_IDS.length)})
    AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    AND funding_source = 'lighter_api_settlements'
  ORDER BY closed_at, id`);
const p3PortfolioSignals = db.prepare<string[], NativeForwardSignalRow>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals
  WHERE strategy_id IN (${sqlMarks(P3_IDS.length)})
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);

const strategies = SHADOW_NATIVE_IDS.map((strategyId) => {
  const latency = latencyByStrategy.get(strategyId);
  if (!latency) throw new Error(`latency strategy evidence missing: ${strategyId}`);
  const historical = historicalEvidence.candidates.find((row) =>
    row.strategyId === strategyId) ?? {
    strategyId,
    symbol: latency.strategyId.split('-')[0]!.toUpperCase(),
    rule: 'frozen_native_latency_candidate',
    passed: latency.passed,
    reasons: latency.passed ? [] : ['frozen latency evidence not passed'],
    metrics: latency.delayedOneMinute,
  };
  return {
    strategyId,
    realExecutorRegistered: REAL_NATIVE_IDS.includes(strategyId),
    historicalEvidence: historical,
    latencyEvidence: latency,
    evaluation: evaluateNativeForwardRows(
      pnlStatement.all(strategyId),
      signalStatement.all(strategyId),
    ),
  };
});
const portfolio = evaluateNativeForwardRows(
  portfolioPnls.all(...P2_IDS),
  portfolioSignals.all(...P2_IDS),
  10,
  4,
);
const p3Portfolio = evaluateNativeForwardRows(
  p3PortfolioPnls.all(...P3_IDS),
  p3PortfolioSignals.all(...P3_IDS),
  6,
  4,
);

const evaluatedStrategies = strategies.map((row) => ({
  ...row,
  decision: nativePromotionDecision(
    row.evaluation,
    row.realExecutorRegistered,
    row.historicalEvidence.passed && row.latencyEvidence.passed,
  ),
}));
const p2Members = P2_IDS.map((strategyId) => {
  const evaluation = evaluateNativeForwardRows(
    pnlStatement.all(strategyId),
    signalStatement.all(strategyId),
  );
  return {
    strategyId,
    realExecutorRegistered: false,
    evaluation,
    decision: nativePromotionDecision(
      evaluation,
      false,
      historicalEvidence.portfolio.passed && p2LatencyEvidence.allMembers.passed,
    ),
  };
});
const p3Members = P3_IDS.map((strategyId) => {
  const evaluation = evaluateNativeForwardRows(
    pnlStatement.all(strategyId),
    signalStatement.all(strategyId),
  );
  return {
    strategyId,
    realExecutorRegistered: false,
    evaluation,
    decision: nativePromotionDecision(
      evaluation,
      false,
      p2LatencyEvidence.positiveExecutionSubset.passedHistoricalLatencyGate,
    ),
  };
});
db.close();
const pausedShadowStrategyIds = [...evaluatedStrategies, ...p2Members, ...p3Members]
  .filter((row) => row.decision.shadowAction === 'pause_new_entries')
  .map((row) => row.strategyId);
const eligibleStrategyIds = evaluatedStrategies
  .filter((row) =>
    runnerLiveness.passed
    && runnerLiveness.healthyStrategyIds.includes(row.strategyId)
    && row.realExecutorRegistered
    && row.historicalEvidence.passed
    && row.latencyEvidence.passed
    && row.evaluation.status === 'passed')
  .map((row) => row.strategyId);
const generatedAt = new Date().toISOString();
const report = {
  version: 'lighter-native-promotion-audit-v5',
  generatedAt,
  databasePath,
  gate: NATIVE_FORWARD_GATE,
  shadowNotionalUsd: NATIVE_SHADOW_NOTIONAL_USD,
  runnerLiveness,
  eligibleStrategyIds,
  historicalEvidence: {
    version: historicalEvidence.version,
    sourceGeneratedAt: historicalEvidence.sourceGeneratedAt,
    sourceSha256: historicalEvidence.sourceSha256,
    supplementalSourceSha256: historicalEvidence.supplementalSourceSha256,
    xlmSupplementalSourceSha256: historicalEvidence.xlmSupplementalSourceSha256,
    dataSupplementalSourceSha256: historicalEvidence.dataSupplementalSourceSha256,
    rsiSupplementalSourceSha256: historicalEvidence.rsiSupplementalSourceSha256,
    portfolio: historicalEvidence.portfolio,
  },
  latencyEvidence: {
    version: LATENCY_EVIDENCE_VERSION,
    sourceSha256: latencyEvidence.sha256,
    supplementalSources: [
      {
        strategyIds: [...xlmConfluenceLatencyEvidence.rows.keys()],
        sourceSha256: xlmConfluenceLatencyEvidence.sha256,
      },
      {
        strategyIds: [...hypeConfluenceLatencyEvidence.rows.keys()],
        sourceSha256: hypeConfluenceLatencyEvidence.sha256,
      },
      {
        strategyIds: [...hypeBbWilliamsLatencyEvidence.rows.keys()],
        sourceSha256: hypeBbWilliamsLatencyEvidence.sha256,
      },
    ],
    conservativeScenario: 'native 1m open one minute after the next 5m open',
  },
  p2LatencyEvidence: {
    version: P2_LATENCY_EVIDENCE_VERSION,
    sourceSha256: p2LatencyEvidenceSha256,
    memberSourceSha256: p2LatencyEvidence.source.sha256,
    conservativeScenario: p2LatencyEvidence.assumptions.delayedFill,
  },
  p2: {
    portfolioId: 'z60stack25-portfolio',
    realExecutorRegistered: false,
    latencyEvidence: p2LatencyEvidence,
    evaluation: portfolio,
    decision: nativePromotionDecision(
      portfolio,
      false,
      historicalEvidence.portfolio.passed && p2LatencyEvidence.allMembers.passed,
    ),
    members: p2Members,
  },
  p3: {
    portfolioId: 'z60stack25-positive-execution-portfolio',
    status: 'fresh_prospective_shadow_only',
    parentPortfolioId: 'z60stack25-portfolio',
    parentSelectionStatus: p2LatencyEvidence.positiveExecutionSubset.status,
    historicalRowsCountTowardForward: false,
    realExecutorRegistered: false,
    historicalLatencyEvidence: p2LatencyEvidence.positiveExecutionSubset,
    evaluation: p3Portfolio,
    decision: nativePromotionDecision(
      p3Portfolio,
      false,
      p2LatencyEvidence.positiveExecutionSubset.passedHistoricalLatencyGate,
    ),
    members: p3Members,
  },
  strategies: evaluatedStrategies,
  pausedShadowStrategyIds,
  autoPromotion: false,
};
const serialized = JSON.stringify(report, null, 2);
const outputPath = flagValue('--output');
if (outputPath) {
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp`;
  writeFileSync(temporary, serialized);
  renameSync(temporary, absolute);
}
console.log(serialized);

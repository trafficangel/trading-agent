export type LighterMicrostructureCostAudit = {
  generatedAt?: string;
  thresholds?: {
    expectedMarkets?: number;
    minimumQualityRatio?: number;
    rollingExecutionNotionalUsd?: number;
    frozenResearchHistoryDays?: number;
  };
  summary?: {
    markets?: number;
    minDurationDays?: number;
    minCoverageRatio?: number;
    minQualityRatio?: number;
    minExecutionCostRatio?: number;
    minFiveMinuteQualityRatio?: number;
  };
  gates?: {
    frozenCandidateResearch?: { passed?: boolean; failures?: string[] };
  };
  perMarket?: Array<{
    symbol?: string;
    executionCostMinutes?: number;
    avgExecutionCostP95Pct?: number | null;
    maxExecutionCostP95Pct?: number | null;
  }>;
};

export type LighterFrozenExecutionCosts = {
  version: 'lighter-native-frozen-execution-costs-v1';
  generatedAt: string;
  sourceAuditAt: string;
  sourceHistoryDays: number;
  notionalUsd: 100;
  method: string;
  summaries: Record<string, {
    n: number;
    p95Pct: number;
    maxPct: number;
  }>;
};

export type LighterExecutionCalibrationResult =
  | { status: 'ready'; calibration: LighterFrozenExecutionCosts }
  | { status: 'not_ready'; failures: string[] };

const EXPECTED_MARKETS = 15;
const REQUIRED_HISTORY_DAYS = 21;
const MIN_QUALITY_RATIO = 0.95;
const MAX_AUDIT_AGE_MS = 2 * 60 * 60_000;

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Converts only a mature, fresh, frozen-readiness audit into the cost-file
 * shape consumed by the Native candle scanner. It never guesses a missing
 * market or substitutes a common cost.
 */
export function buildLighterFrozenExecutionCosts(
  audit: LighterMicrostructureCostAudit,
  nowMs = Date.now(),
): LighterExecutionCalibrationResult {
  const failures = [...(audit.gates?.frozenCandidateResearch?.failures ?? [])];
  if (audit.gates?.frozenCandidateResearch?.passed !== true)
    failures.push('frozen candidate research gate has not passed');

  const auditAt = Date.parse(audit.generatedAt ?? '');
  if (!Number.isFinite(auditAt)) failures.push('audit timestamp is missing or invalid');
  else if (nowMs - auditAt > MAX_AUDIT_AGE_MS) failures.push('audit is older than 2 hours');
  else if (auditAt > nowMs + 60_000) failures.push('audit timestamp is in the future');

  const thresholds = audit.thresholds;
  if (thresholds?.rollingExecutionNotionalUsd !== 100)
    failures.push('execution notional is not $100');
  if ((thresholds?.expectedMarkets ?? 0) !== EXPECTED_MARKETS)
    failures.push(`expected market count is not ${EXPECTED_MARKETS}`);
  if ((thresholds?.frozenResearchHistoryDays ?? 0) < REQUIRED_HISTORY_DAYS)
    failures.push(`frozen history threshold is below ${REQUIRED_HISTORY_DAYS} days`);

  const summary = audit.summary;
  if ((summary?.markets ?? 0) !== EXPECTED_MARKETS)
    failures.push(`audit contains ${summary?.markets ?? 0}/${EXPECTED_MARKETS} markets`);
  if ((summary?.minDurationDays ?? 0) < REQUIRED_HISTORY_DAYS)
    failures.push(`history is shorter than ${REQUIRED_HISTORY_DAYS} days`);
  for (const [label, value] of [
    ['coverage', summary?.minCoverageRatio],
    ['1m quality', summary?.minQualityRatio],
    ['$100 execution cost', summary?.minExecutionCostRatio],
    ['5m quality', summary?.minFiveMinuteQualityRatio],
  ] as const) {
    if ((value ?? 0) < MIN_QUALITY_RATIO)
      failures.push(`${label} is below ${(MIN_QUALITY_RATIO * 100).toFixed(0)}%`);
  }

  const summaries: LighterFrozenExecutionCosts['summaries'] = {};
  for (const market of audit.perMarket ?? []) {
    const symbol = String(market.symbol ?? '').trim().toUpperCase();
    const n = finite(market.executionCostMinutes);
    const p95Pct = finite(market.avgExecutionCostP95Pct);
    const maxPct = finite(market.maxExecutionCostP95Pct);
    if (!symbol) {
      failures.push('market symbol is missing');
      continue;
    }
    if (summaries[symbol]) {
      failures.push(`duplicate market ${symbol}`);
      continue;
    }
    if (n == null || n < REQUIRED_HISTORY_DAYS * 24 * 60 * MIN_QUALITY_RATIO)
      failures.push(`${symbol} has insufficient execution-cost minutes`);
    if (p95Pct == null || p95Pct < 0) failures.push(`${symbol} p95 is missing or invalid`);
    if (maxPct == null || p95Pct == null || maxPct < p95Pct)
      failures.push(`${symbol} observed maximum is missing or below p95`);
    if (n != null && p95Pct != null && p95Pct >= 0 && maxPct != null && maxPct >= p95Pct) {
      summaries[symbol] = { n: Math.floor(n), p95Pct, maxPct };
    }
  }
  if (Object.keys(summaries).length !== EXPECTED_MARKETS)
    failures.push(`valid calibrated markets ${Object.keys(summaries).length}/${EXPECTED_MARKETS}`);

  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length) return { status: 'not_ready', failures: uniqueFailures };

  return {
    status: 'ready',
    calibration: {
      version: 'lighter-native-frozen-execution-costs-v1',
      generatedAt: new Date(nowMs).toISOString(),
      sourceAuditAt: new Date(auditAt).toISOString(),
      sourceHistoryDays: summary!.minDurationDays!,
      notionalUsd: 100,
      method: 'time-average of quality-approved 1m executable $100 round-trip p95; observed max is non-blocking sensitivity',
      summaries,
    },
  };
}

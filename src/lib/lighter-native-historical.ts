import { createHash } from 'node:crypto';

export const NATIVE_HISTORICAL_REPORT_VERSION = 'lighter-native-sweep-v2';
export const NATIVE_HISTORICAL_REPORT_SHA256 =
  '8327517f63cd44b508aa8824e5393ad46f48ab129223e2d4fbaeaa320d496f4e';
export const NATIVE_HISTORICAL_SUPPLEMENT_VERSION = 'lighter-native-sweep-v2';
export const NATIVE_HISTORICAL_SUPPLEMENT_SHA256 =
  'afa6e2b1de6b64fd7917eb033177db4d1654538f54262b0bcfca0b110ea0fed1';
export const NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256 =
  'cb507f67f7e34d005b1b5360dd6aede718d9f8a1d6cf6ebba037b84b9018f445';
export const NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256 =
  'ea089a8d09788ca652e6cc7ce4543dd8f65ef269375bcf3405329ec17239c74f';

const HISTORICAL_CANDIDATES = [
  { strategyId: 'sol-z60-reclaim', symbol: 'SOL', rule: 'Z60-3-reclaim' },
  { strategyId: 'sol-z60-touch', symbol: 'SOL', rule: 'Z60-3-touch' },
  { strategyId: 'bnb-z60-touch', symbol: 'BNB', rule: 'Z60-3-touch' },
  { strategyId: 'ltc-z60-touch', symbol: 'LTC', rule: 'Z60-2-touch' },
  { strategyId: 'btc-vwz60-touch', symbol: 'BTC', rule: 'VWZ60-3-touch' },
  { strategyId: 'hype-vwz60-touch', symbol: 'HYPE', rule: 'VWZ60-2.5-touch' },
] as const;

const SUPPLEMENTAL_HISTORICAL_CANDIDATES = [
  { strategyId: 'xrp-vwz60-touch', symbol: 'XRP', rule: 'VWZ60-3-touch' },
] as const;

const XLM_SUPPLEMENTAL_HISTORICAL_CANDIDATES = [
  {
    strategyId: 'xlm-vwz60-touch-er25',
    symbol: 'XLM',
    rule: 'VWZ60-3-touch+ER60<0.25',
  },
] as const;

const DATA_SUPPLEMENTAL_HISTORICAL_CANDIDATES = [
  {
    strategyId: 'data-vwz60-touch',
    symbol: 'DATA',
    rule: 'VWZ60-2.5-touch',
  },
] as const;

type HistoricalWindow = {
  days: number;
  n: number;
  net: number;
  profitFactor: number;
  long: number;
  short: number;
};

type HistoricalRow = {
  symbol: string;
  rule: string;
  trades: number;
  coverageDays: number;
  netPct: number;
  adverseNetPct: number;
  stressPf: number;
  robustPf: number;
  meanL95: number;
  maxDrawdownPct: number;
  folds: number;
  is: number;
  oos: number;
  long: number;
  short: number;
  recent: HistoricalWindow[];
};

type HistoricalReport = {
  version: string;
  generatedAt: string;
  input: Record<string, unknown>;
  qualified: string[];
  rows: HistoricalRow[];
  portfolioQualified: string[];
  portfolioRows: Array<Record<string, unknown>>;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'generatedAt')
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function nativeHistoricalReportSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function number(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`historical evidence ${label} invalid`);
  return parsed;
}

function rowReasons(row: HistoricalRow): string[] {
  const reasons: string[] = [];
  if (row.trades < 30) reasons.push(`trades ${row.trades} < 30`);
  if (row.coverageDays < 85.5) reasons.push(`coverage ${row.coverageDays.toFixed(1)}d < 85.5d`);
  if (!(row.netPct > 0)) reasons.push(`net ${row.netPct.toFixed(3)}% <= 0%`);
  if (!(row.adverseNetPct > 0)) reasons.push(`adverse net ${row.adverseNetPct.toFixed(3)}% <= 0%`);
  if (row.stressPf < 1.2) reasons.push(`PF ${row.stressPf.toFixed(2)} < 1.20`);
  if (row.robustPf < 1.1) reasons.push(`adverse PF ${row.robustPf.toFixed(2)} < 1.10`);
  if (!(row.meanL95 > 0)) reasons.push(`mean L95 ${row.meanL95.toFixed(4)}% <= 0%`);
  if (row.folds < 3) reasons.push(`positive folds ${row.folds}/4 < 3/4`);
  if (!(row.is > 0)) reasons.push(`IS ${row.is.toFixed(3)}% <= 0%`);
  if (!(row.oos > 0)) reasons.push(`OOS ${row.oos.toFixed(3)}% <= 0%`);
  if (!(row.long > 0)) reasons.push(`Long ${row.long.toFixed(3)}% <= 0%`);
  if (!(row.short > 0)) reasons.push(`Short ${row.short.toFixed(3)}% <= 0%`);
  if (row.maxDrawdownPct < -15) {
    reasons.push(`drawdown ${row.maxDrawdownPct.toFixed(3)}% < -15%`);
  }
  for (const window of row.recent) {
    if (window.n < 20) reasons.push(`${window.days}d trades ${window.n} < 20`);
    if (!(window.net > 0)) reasons.push(`${window.days}d net ${window.net.toFixed(3)}% <= 0%`);
    if (window.profitFactor < 1.1) {
      reasons.push(`${window.days}d PF ${window.profitFactor.toFixed(2)} < 1.10`);
    }
    if (!(window.long > 0)) reasons.push(`${window.days}d Long ${window.long.toFixed(3)}% <= 0%`);
    if (!(window.short > 0)) reasons.push(`${window.days}d Short ${window.short.toFixed(3)}% <= 0%`);
  }
  return reasons;
}

function validateSupplementalReport(
  value: unknown,
  expectedSha256: string,
  expectedRuleFilter: string,
  label: string,
): HistoricalReport {
  if (!value || typeof value !== 'object') throw new Error(`${label} historical evidence missing`);
  const report = value as HistoricalReport;
  const input = report.input;
  if (
    report.version !== NATIVE_HISTORICAL_SUPPLEMENT_VERSION
    || !Number.isFinite(Date.parse(report.generatedAt))
    || !input
    || input.barMinutes !== 5
    || input.ruleFilter !== expectedRuleFilter
    || input.positionNotionalUsd !== 100
    || input.executionCosts !== 'market-specific executable $100 full-round-trip p95'
    || input.adverseExecution !== 'market-specific observed maximum; non-blocking sensitivity'
    || input.funding !== 'exact Lighter hourly settlements in (entry, exit]'
    || input.qualificationInputsMeasured !== true
    || input.usedFallbackExecutionCost !== false
    || input.usedFallbackFunding !== false
    || !Array.isArray(report.qualified)
    || !Array.isArray(report.rows)
  ) throw new Error(`${label} historical evidence contract invalid`);
  if (nativeHistoricalReportSha256(report) !== expectedSha256) {
    throw new Error(`${label} historical evidence hash mismatch`);
  }
  return report;
}

function evaluateSupplementalCandidates(
  report: HistoricalReport | null,
  definitions: readonly { strategyId: string; symbol: string; rule: string }[],
  label: string,
) {
  if (report == null) return [];
  return definitions.map((candidate) => {
    const matches = report.rows.filter((row) =>
      row.symbol === candidate.symbol && row.rule === candidate.rule);
    if (matches.length !== 1) {
      throw new Error(`${label} historical evidence row missing or duplicated: ${candidate.strategyId}`);
    }
    const row = matches[0]!;
    for (const [metricLabel, metric] of Object.entries({
      trades: row.trades,
      coverageDays: row.coverageDays,
      netPct: row.netPct,
      adverseNetPct: row.adverseNetPct,
      stressPf: row.stressPf,
      robustPf: row.robustPf,
      meanL95: row.meanL95,
      maxDrawdownPct: row.maxDrawdownPct,
      folds: row.folds,
      is: row.is,
      oos: row.oos,
      long: row.long,
      short: row.short,
    })) number(metric, `${candidate.strategyId}.${metricLabel}`);
    if (!Array.isArray(row.recent) || row.recent.length !== 3) {
      throw new Error(`${label} historical evidence recent windows invalid: ${candidate.strategyId}`);
    }
    const reasons = rowReasons(row);
    const passed = report.qualified.includes(`${candidate.symbol}:${candidate.rule}`);
    if (passed !== (reasons.length === 0)) {
      throw new Error(`${label} historical evidence qualification mismatch: ${candidate.strategyId}`);
    }
    return { ...candidate, passed, reasons, metrics: row };
  });
}

export function evaluateNativeHistoricalEvidence(
  value: unknown,
  supplementalValue?: unknown,
  xlmSupplementalValue?: unknown,
  dataSupplementalValue?: unknown,
) {
  if (!value || typeof value !== 'object') throw new Error('historical evidence missing');
  const report = value as HistoricalReport;
  const input = report.input;
  if (
    report.version !== NATIVE_HISTORICAL_REPORT_VERSION
    || !Number.isFinite(Date.parse(report.generatedAt))
    || !input
    || input.barMinutes !== 5
    || input.ruleFilter !== 'Z60'
    || input.positionNotionalUsd !== 100
    || input.portfolioMaxOpen !== 10
    || input.executionCosts !== 'market-specific executable $100 full-round-trip p95'
    || input.adverseExecution !== 'market-specific observed maximum; non-blocking sensitivity'
    || input.funding !== 'exact Lighter hourly settlements in (entry, exit]'
    || input.qualificationInputsMeasured !== true
    || input.usedFallbackExecutionCost !== false
    || input.usedFallbackFunding !== false
    || !Array.isArray(report.qualified)
    || !Array.isArray(report.rows)
    || !Array.isArray(report.portfolioQualified)
    || !Array.isArray(report.portfolioRows)
  ) throw new Error('historical evidence contract invalid');
  const sourceSha256 = nativeHistoricalReportSha256(report);
  if (sourceSha256 !== NATIVE_HISTORICAL_REPORT_SHA256) {
    throw new Error('historical evidence hash mismatch');
  }

  const candidates = HISTORICAL_CANDIDATES.map((candidate) => {
    const matches = report.rows.filter((row) =>
      row.symbol === candidate.symbol && row.rule === candidate.rule);
    if (matches.length !== 1) {
      throw new Error(`historical evidence row missing or duplicated: ${candidate.strategyId}`);
    }
    const row = matches[0]!;
    // Force every metric consumed below through a finite-number check before
    // a frozen artifact can influence a Real eligibility decision.
    for (const [label, metric] of Object.entries({
      trades: row.trades,
      coverageDays: row.coverageDays,
      netPct: row.netPct,
      adverseNetPct: row.adverseNetPct,
      stressPf: row.stressPf,
      robustPf: row.robustPf,
      meanL95: row.meanL95,
      maxDrawdownPct: row.maxDrawdownPct,
      folds: row.folds,
      is: row.is,
      oos: row.oos,
      long: row.long,
      short: row.short,
    })) number(metric, `${candidate.strategyId}.${label}`);
    if (!Array.isArray(row.recent) || row.recent.length !== 3) {
      throw new Error(`historical evidence recent windows invalid: ${candidate.strategyId}`);
    }
    const reasons = rowReasons(row);
    const passed = report.qualified.includes(`${candidate.symbol}:${candidate.rule}`);
    if (passed !== (reasons.length === 0)) {
      throw new Error(`historical evidence qualification mismatch: ${candidate.strategyId}`);
    }
    return { ...candidate, passed, reasons, metrics: row };
  });

  const supplementalReport = supplementalValue == null
    ? null
    : validateSupplementalReport(
      supplementalValue,
      NATIVE_HISTORICAL_SUPPLEMENT_SHA256,
      'VWZ60',
      'supplemental',
    );
  const xlmSupplementalReport = xlmSupplementalValue == null
    ? null
    : validateSupplementalReport(
      xlmSupplementalValue,
      NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256,
      'VWZ60-3-touch',
      'XLM supplemental',
    );
  const dataSupplementalReport = dataSupplementalValue == null
    ? null
    : validateSupplementalReport(
      dataSupplementalValue,
      NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256,
      'VWZ60-2.5-touch',
      'DATA supplemental',
    );
  if (dataSupplementalReport != null) {
    const symbols = dataSupplementalReport.input.symbols;
    const sources = dataSupplementalReport.input.candleSources;
    if (
      !Array.isArray(symbols)
      || symbols.length !== 1
      || symbols[0] !== 'DATA'
      || !sources
      || typeof sources !== 'object'
      || (sources as Record<string, unknown>).DATA !== 'aggregated_from_1m'
    ) throw new Error('DATA supplemental historical evidence source contract invalid');
  }
  const supplementalCandidates = evaluateSupplementalCandidates(
    supplementalReport,
    SUPPLEMENTAL_HISTORICAL_CANDIDATES,
    'supplemental',
  );
  const xlmSupplementalCandidates = evaluateSupplementalCandidates(
    xlmSupplementalReport,
    XLM_SUPPLEMENTAL_HISTORICAL_CANDIDATES,
    'XLM supplemental',
  );
  const dataSupplementalCandidates = evaluateSupplementalCandidates(
    dataSupplementalReport,
    DATA_SUPPLEMENTAL_HISTORICAL_CANDIDATES,
    'DATA supplemental',
  );

  const portfolioRule = 'Z60STACK-2.5-touch';
  const portfolioRows = report.portfolioRows.filter((row) => row.rule === portfolioRule);
  if (portfolioRows.length !== 1) throw new Error('historical P2 evidence missing or duplicated');
  return {
    version: 'lighter-native-historical-evidence-v1',
    sourceGeneratedAt: report.generatedAt,
    sourceSha256,
    candidates: [
      ...candidates,
      ...supplementalCandidates,
      ...xlmSupplementalCandidates,
      ...dataSupplementalCandidates,
    ],
    supplementalSourceSha256: supplementalReport == null
      ? null
      : nativeHistoricalReportSha256(supplementalReport),
    xlmSupplementalSourceSha256: xlmSupplementalReport == null
      ? null
      : nativeHistoricalReportSha256(xlmSupplementalReport),
    dataSupplementalSourceSha256: dataSupplementalReport == null
      ? null
      : nativeHistoricalReportSha256(dataSupplementalReport),
    portfolio: {
      portfolioId: 'z60stack25-portfolio',
      rule: portfolioRule,
      passed: report.portfolioQualified.includes(portfolioRule),
      metrics: portfolioRows[0],
    },
  };
}

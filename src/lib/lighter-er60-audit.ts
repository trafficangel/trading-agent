export type Er60Trade = {
  side: 'long' | 'short';
  openedAt: number;
  closedAt: number;
  netPct: number;
  er60: number;
};

export type Er60Metrics = {
  trades: number;
  long: number;
  short: number;
  netPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
};

export type Er60ThresholdAudit = {
  threshold: number;
  retained: Er60Metrics;
  excluded: Er60Metrics;
  improvementPct: number;
  eligibleToReplace: boolean;
  failures: string[];
};

export type Er60StrategyAudit = {
  base: Er60Metrics;
  coverageDays: number;
  thresholds: Er60ThresholdAudit[];
};

const MIN_TRADES = 60;
const MIN_COVERAGE_DAYS = 30;
const MIN_SIDE_TRADES = 10;
const MIN_EXCLUDED_TRADES = 10;
const MIN_PF_IMPROVEMENT = 0.10;

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function er60Metrics(rows: readonly Er60Trade[]): Er60Metrics {
  let gains = 0;
  let losses = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const row of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    if (row.netPct >= 0) gains += row.netPct;
    else losses -= row.netPct;
    equity += row.netPct;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, equity - peak);
  }
  return {
    trades: rows.length,
    long: rows.filter((row) => row.side === 'long').length,
    short: rows.filter((row) => row.side === 'short').length,
    netPct: round(equity),
    profitFactor: losses > 0 ? round(gains / losses) : gains > 0 ? null : 0,
    maxDrawdownPct: round(maxDrawdownPct),
  };
}

export function auditEr60Strategy(
  rows: readonly Er60Trade[],
  thresholds: readonly number[] = [0.25, 0.35],
): Er60StrategyAudit {
  const ordered = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  const base = er60Metrics(ordered);
  const coverageDays = ordered.length
    ? Math.max(0, ordered.at(-1)!.closedAt - ordered[0]!.openedAt) / 86_400_000
    : 0;
  return {
    base,
    coverageDays: round(coverageDays),
    thresholds: thresholds.map((threshold) => {
      const retained = er60Metrics(ordered.filter((row) => row.er60 <= threshold));
      const excluded = er60Metrics(ordered.filter((row) => row.er60 > threshold));
      const failures: string[] = [];
      if (base.trades < MIN_TRADES) failures.push(`closed ${base.trades}/${MIN_TRADES}`);
      if (coverageDays < MIN_COVERAGE_DAYS)
        failures.push(`coverage ${coverageDays.toFixed(1)}/${MIN_COVERAGE_DAYS}d`);
      if (retained.long < MIN_SIDE_TRADES)
        failures.push(`retained long ${retained.long}/${MIN_SIDE_TRADES}`);
      if (retained.short < MIN_SIDE_TRADES)
        failures.push(`retained short ${retained.short}/${MIN_SIDE_TRADES}`);
      if (excluded.trades < MIN_EXCLUDED_TRADES)
        failures.push(`excluded ${excluded.trades}/${MIN_EXCLUDED_TRADES}`);
      if (retained.netPct <= base.netPct)
        failures.push(`retained net ${retained.netPct} <= base ${base.netPct}`);
      if (excluded.netPct >= 0)
        failures.push(`excluded net ${excluded.netPct} is not negative`);
      if (retained.netPct <= 0) failures.push(`retained net ${retained.netPct} <= 0`);
      const basePf = base.profitFactor ?? Number.POSITIVE_INFINITY;
      const retainedPf = retained.profitFactor ?? Number.POSITIVE_INFINITY;
      if (retainedPf < basePf + MIN_PF_IMPROVEMENT)
        failures.push(`retained PF did not improve by ${MIN_PF_IMPROVEMENT.toFixed(2)}`);
      return {
        threshold,
        retained,
        excluded,
        improvementPct: round(retained.netPct - base.netPct),
        eligibleToReplace: failures.length === 0,
        failures,
      };
    }),
  };
}

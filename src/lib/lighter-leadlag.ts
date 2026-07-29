export type LeadLagSide = 'long' | 'short';

export type LeadLagOutcome = {
  netBps: number;
  passed: boolean;
};

export type LeadLagSummary = {
  samples: number;
  wins: number;
  winRatePct: number | null;
  netBps: number;
  averageNetBps: number | null;
  medianNetBps: number | null;
  profitFactor: number | null;
  maxDrawdownBps: number;
};

export function leadLagResidualBps(
  leaderNow: number,
  leaderBefore: number,
  targetNow: number,
  targetBefore: number,
): number | null {
  if (
    !(leaderNow > 0)
    || !(leaderBefore > 0)
    || !(targetNow > 0)
    || !(targetBefore > 0)
  ) return null;
  return (
    leaderNow / leaderBefore
    - targetNow / targetBefore
  ) * 10_000;
}

export function leadLagReturnBps(now: number, before: number): number | null {
  if (!(now > 0) || !(before > 0)) return null;
  return (now / before - 1) * 10_000;
}

export function lighterRoundTripNetBps(
  side: LeadLagSide,
  entryPrice: number,
  exitPrice: number,
  executionBufferBps: number,
): number | null {
  if (
    !(entryPrice > 0)
    || !(exitPrice > 0)
    || !(executionBufferBps >= 0)
  ) return null;
  const grossBps = side === 'long'
    ? (exitPrice / entryPrice - 1) * 10_000
    : (entryPrice / exitPrice - 1) * 10_000;
  return grossBps - executionBufferBps;
}

export function topLevelDepthUsd(price: number, size: number): number {
  if (!(price > 0) || !(size > 0)) return 0;
  return price * size;
}

export function summarizeLeadLag(
  outcomes: readonly LeadLagOutcome[],
): LeadLagSummary {
  const values = outcomes
    .map((row) => row.netBps)
    .filter(Number.isFinite);
  if (!values.length) {
    return {
      samples: 0,
      wins: 0,
      winRatePct: null,
      netBps: 0,
      averageNetBps: null,
      medianNetBps: null,
      profitFactor: null,
      maxDrawdownBps: 0,
    };
  }
  const wins = values.filter((value) => value > 0).length;
  const positive = values
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(
    values
      .filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0),
  );
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const netBps = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    wins,
    winRatePct: wins / values.length * 100,
    netBps,
    averageNetBps: netBps / values.length,
    medianNetBps: median,
    profitFactor: negative > 0 ? positive / negative : positive > 0 ? Infinity : null,
    maxDrawdownBps: maxDrawdown,
  };
}

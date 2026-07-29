export type ShadowNetInput = {
  notionalUsd: number;
  quantity: number;
  entryExtended: number;
  entryLighter: number;
  exitExtended: number;
  exitLighter: number;
  extendedTakerBps: number;
  lighterTakerBps: number;
  executionBufferBps: number;
  fundingBps: number;
};

export type ShadowOutcome = {
  entryEdgeConfirmed?: boolean;
  realizedNetBps?: number | null;
  reachedExitGuard?: boolean;
  reason?: string;
};

export type ShadowReadiness = {
  attempts: number;
  samples: number;
  entryEdgeConfirmed: number;
  reachedExitGuard: number;
  positiveAfterLatency: number;
  passed: number;
  passedPct: number | null;
  requiredSamples: number;
  requiredPassPct: number;
  ready: boolean;
  reasons: Record<string, number>;
};

export function shadowLossGuardReached(input: {
  projectedNetBps: number;
  maxLossBps: number;
  holdingMs: number;
  minHoldMs: number;
}): boolean {
  return (
    Number.isFinite(input.projectedNetBps)
    && input.maxLossBps > 0
    && input.holdingMs >= input.minHoldMs
    && input.projectedNetBps <= -input.maxLossBps
  );
}

export function shadowNetAfterCosts(input: ShadowNetInput): {
  grossUsd: number;
  feesUsd: number;
  executionBufferUsd: number;
  fundingUsd: number;
  netUsd: number;
  netBps: number;
} {
  const grossUsd = (
    (input.exitExtended - input.entryExtended)
    + (input.entryLighter - input.exitLighter)
  ) * input.quantity;
  const feesUsd = (
    input.entryExtended
    + input.exitExtended
  ) * input.quantity * input.extendedTakerBps / 10_000
    + (
      input.entryLighter
      + input.exitLighter
    ) * input.quantity * input.lighterTakerBps / 10_000;
  const executionBufferUsd = input.notionalUsd * input.executionBufferBps / 10_000;
  const fundingUsd = input.notionalUsd * input.fundingBps / 10_000;
  const netUsd = grossUsd - feesUsd - executionBufferUsd - fundingUsd;
  return {
    grossUsd,
    feesUsd,
    executionBufferUsd,
    fundingUsd,
    netUsd,
    netBps: netUsd / input.notionalUsd * 10_000,
  };
}

export function shadowReadiness(
  rows: readonly ShadowOutcome[],
  requiredSamples = 20,
  requiredPassPct = 90,
): ShadowReadiness {
  const entryEdgeConfirmed = rows.filter((row) => row.entryEdgeConfirmed).length;
  const reachedExitGuard = rows.filter((row) => row.reachedExitGuard).length;
  const positiveAfterLatency = rows.filter(
    (row) => Number(row.realizedNetBps) > 0,
  ).length;
  const passed = rows.filter(
    (row) => row.entryEdgeConfirmed
      && row.reachedExitGuard
      && Number(row.realizedNetBps) > 0,
  ).length;
  const passedPct = entryEdgeConfirmed
    ? passed / entryEdgeConfirmed * 100
    : null;
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    const reason = row.reason || 'unknown';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    attempts: rows.length,
    samples: entryEdgeConfirmed,
    entryEdgeConfirmed,
    reachedExitGuard,
    positiveAfterLatency,
    passed,
    passedPct,
    requiredSamples,
    requiredPassPct,
    ready: entryEdgeConfirmed >= requiredSamples
      && passedPct != null
      && passedPct >= requiredPassPct,
    reasons,
  };
}

export function conservativeLatencyMs(
  samples: readonly number[],
  floorMs: number,
): number {
  const valid = samples
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!valid.length) return floorMs;
  const p90Index = Math.min(
    valid.length - 1,
    Math.ceil(valid.length * 0.9) - 1,
  );
  return Math.max(floorMs, valid[p90Index] ?? floorMs);
}

export function independentSignalRows<T>(
  rows: readonly T[],
  minSeparationMs: number,
  keyOf: (row: T) => string,
  atOf: (row: T) => number,
): T[] {
  const accepted: T[] = [];
  const lastAt = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => atOf(a) - atOf(b))) {
    const key = keyOf(row);
    const at = atOf(row);
    const previous = lastAt.get(key) ?? -Infinity;
    if (at - previous < minSeparationMs) continue;
    accepted.push(row);
    lastAt.set(key, at);
  }
  return accepted;
}

export function wilsonLowerBound(
  successes: number,
  trials: number,
  z = 1.96,
): number {
  if (!(trials > 0) || successes < 0 || successes > trials) return 0;
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const centre = proportion + zSquared / (2 * trials);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * trials)) / trials,
  );
  return (centre - margin) / denominator;
}

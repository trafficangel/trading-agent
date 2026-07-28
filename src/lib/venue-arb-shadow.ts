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
  requiredSamples = 50,
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
  const passedPct = rows.length ? passed / rows.length * 100 : null;
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    const reason = row.reason || 'unknown';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    samples: rows.length,
    entryEdgeConfirmed,
    reachedExitGuard,
    positiveAfterLatency,
    passed,
    passedPct,
    requiredSamples,
    requiredPassPct,
    ready: rows.length >= requiredSamples
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

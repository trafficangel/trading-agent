export type VenueArbBasisSample = {
  at: number;
  bps: number;
};

export type VenueArbBasisMetrics = {
  baselineBps: number;
  deviationBps: number;
  samples: number;
  spanMs: number;
};

export type VenueArbBasisConfig = {
  windowMs: number;
  excludeMs: number;
  minSamples: number;
  minSpanMs: number;
};

export function pairedVenueArbExpectedNetBps(
  entryBasisBps: number,
  exitBaselineBps: number,
  roundTripCostBps: number,
): number {
  if (
    !Number.isFinite(entryBasisBps)
    || !Number.isFinite(exitBaselineBps)
    || !Number.isFinite(roundTripCostBps)
  ) return Number.NEGATIVE_INFINITY;
  return entryBasisBps + exitBaselineBps - roundTripCostBps;
}

export function calibratedVenueArbBasis(
  samples: readonly VenueArbBasisSample[],
  now: number,
  currentBps: number,
  config: VenueArbBasisConfig,
): VenueArbBasisMetrics | null {
  const eligible = samples.filter((sample) => (
    Number.isFinite(sample.bps)
    && sample.at >= now - config.windowMs
    && sample.at <= now - config.excludeMs
  ));
  if (eligible.length < config.minSamples) return null;
  const spanMs = eligible.at(-1)!.at - eligible[0]!.at;
  if (spanMs < config.minSpanMs) return null;
  const values = eligible.map((sample) => sample.bps)
    .sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const baselineBps = values.length % 2
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
  return {
    baselineBps,
    deviationBps: currentBps - baselineBps,
    samples: eligible.length,
    spanMs,
  };
}

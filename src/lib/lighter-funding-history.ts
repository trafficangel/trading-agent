export type LighterFundingSide = 'long' | 'short';

export type LighterFundingPoint = {
  timestampMs: number;
  ratePctH: number;
  direction: LighterFundingSide;
};

export type LighterFundingSeries = {
  timestampsMs: number[];
  longPayerPrefixPct: number[];
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Lighter's hourly funding `rate` is expressed in percentage points. The
 * `direction` identifies the paying side. Positive values in this normalized
 * series therefore mean longs pay shorts; negative values mean shorts pay
 * longs.
 */
export function longPayerRatePct(point: LighterFundingPoint): number {
  const rate = Math.abs(point.ratePctH);
  return point.direction === 'long' ? rate : -rate;
}

export function buildLighterFundingSeries(
  points: readonly LighterFundingPoint[],
): LighterFundingSeries {
  const normalized = points
    .map((point) => ({
      timestampMs: finite(point.timestampMs),
      ratePctH: finite(point.ratePctH),
      direction: point.direction,
    }))
    .filter((point): point is LighterFundingPoint =>
      point.timestampMs != null
      && point.timestampMs > 0
      && point.ratePctH != null
      && point.ratePctH >= 0
      && (point.direction === 'long' || point.direction === 'short'))
    .sort((left, right) => left.timestampMs - right.timestampMs);

  const deduplicated: LighterFundingPoint[] = [];
  for (const point of normalized) {
    if (deduplicated.at(-1)?.timestampMs === point.timestampMs) {
      deduplicated[deduplicated.length - 1] = point;
    } else {
      deduplicated.push(point);
    }
  }

  const timestampsMs: number[] = [];
  const longPayerPrefixPct = [0];
  for (const point of deduplicated) {
    timestampsMs.push(point.timestampMs);
    longPayerPrefixPct.push(
      longPayerPrefixPct.at(-1)! + longPayerRatePct(point),
    );
  }
  return { timestampsMs, longPayerPrefixPct };
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Exact settled funding over (entry, exit]. A position opened exactly on an
 * hourly boundary is not credited/debited for the settlement that happened at
 * that same timestamp; a position still open at exit receives the settlement.
 */
export function lighterFundingPnlPct(
  series: LighterFundingSeries,
  side: LighterFundingSide,
  entryAtMs: number,
  exitAtMs: number,
): number {
  if (!(exitAtMs > entryAtMs) || !series.timestampsMs.length) return 0;
  const afterEntry = upperBound(series.timestampsMs, entryAtMs);
  const throughExit = upperBound(series.timestampsMs, exitAtMs);
  const longPayerPct =
    series.longPayerPrefixPct[throughExit]!
    - series.longPayerPrefixPct[afterEntry]!;
  return side === 'long' ? -longPayerPct : longPayerPct;
}

export function fundingSeriesCoverage(
  series: LighterFundingSeries,
  requiredStartMs: number,
  requiredEndMs: number,
): {
  covered: boolean;
  points: number;
  internalCoverage: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
} {
  const firstTimestampMs = series.timestampsMs[0] ?? null;
  const lastTimestampMs = series.timestampsMs.at(-1) ?? null;
  if (firstTimestampMs == null || lastTimestampMs == null) {
    return {
      covered: false,
      points: 0,
      internalCoverage: 0,
      firstTimestampMs,
      lastTimestampMs,
    };
  }
  const hourMs = 3_600_000;
  const expectedInternal = Math.max(
    1,
    Math.floor((lastTimestampMs - firstTimestampMs) / hourMs) + 1,
  );
  const internalCoverage = series.timestampsMs.length / expectedInternal;
  return {
    covered:
      firstTimestampMs <= requiredStartMs + hourMs
      && lastTimestampMs >= requiredEndMs - hourMs
      && internalCoverage >= 0.99,
    points: series.timestampsMs.length,
    internalCoverage,
    firstTimestampMs,
    lastTimestampMs,
  };
}

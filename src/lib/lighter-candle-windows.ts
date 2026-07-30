export type CandleWindow = readonly [startMs: number, endExclusiveMs: number];

/**
 * Build gap-fill windows for Lighter's candles endpoint.
 *
 * The API treats end_timestamp as exclusive. Every returned window therefore
 * spans at most pageSize bars and the next window starts exactly at the prior
 * exclusive end. Existing cached bars are skipped, including when a missing
 * bar sits inside the cached range rather than before/after it.
 */
export function missingCandleWindows(
  existingTimes: Iterable<number>,
  fromMs: number,
  toMs: number,
  stepMs: number,
  pageSize = 500,
): CandleWindow[] {
  if (!(stepMs > 0) || !Number.isInteger(pageSize) || pageSize < 1 || toMs < fromMs) {
    return [];
  }

  const existing = new Set(existingTimes);
  const firstBar = Math.floor(fromMs / stepMs) * stepMs;
  const endExclusive = Math.floor(toMs / stepMs) * stepMs + stepMs;
  const windows: CandleWindow[] = [];
  let missingStart: number | null = null;
  let missingCount = 0;

  const flush = (): void => {
    if (missingStart === null || missingCount === 0) return;
    let start = missingStart;
    let remaining = missingCount;
    while (remaining > 0) {
      const count = Math.min(pageSize, remaining);
      windows.push([start, start + count * stepMs]);
      start += count * stepMs;
      remaining -= count;
    }
    missingStart = null;
    missingCount = 0;
  };

  for (let timestamp = firstBar; timestamp < endExclusive; timestamp += stepMs) {
    if (existing.has(timestamp)) {
      flush();
      continue;
    }
    if (missingStart === null) missingStart = timestamp;
    missingCount += 1;
  }
  flush();
  return windows;
}

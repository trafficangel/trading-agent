import type { Vwz60Bar } from './lighter-z60.js';

export const NATIVE_MINUTE_MS = 60_000;
export type NativeTimeframeMinutes = 1 | 5;

export type NativeRawCandle = {
  t?: unknown;
  h?: unknown;
  l?: unknown;
  c?: unknown;
  v?: unknown;
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function nativeTimeframeMs(timeframeMinutes: NativeTimeframeMinutes): number {
  return timeframeMinutes * NATIVE_MINUTE_MS;
}

/**
 * Latest fully closed decision bar whose underlying native minute candles had
 * the configured publication grace. The same function works for future 1m
 * candidates and the current 5m book without ever reading an open candle.
 */
export function targetCompletedNativeBar(
  now: number,
  timeframeMinutes: NativeTimeframeMinutes,
  publicationGraceMs: number,
): number {
  const barMs = nativeTimeframeMs(timeframeMinutes);
  return Math.floor((now - publicationGraceMs) / barMs) * barMs - barMs;
}

export function nativeEntryDecisionDelayMs(
  targetBarTime: number,
  timeframeMinutes: NativeTimeframeMinutes,
  dataReadyAt: number,
): number {
  return Math.max(0, dataReadyAt - (
    targetBarTime + nativeTimeframeMs(timeframeMinutes)
  ));
}

export function nativeTimeExitReached(
  openedAt: number,
  targetBarTime: number,
  timeframeMinutes: NativeTimeframeMinutes,
  maxBars: number,
): boolean {
  const barMs = nativeTimeframeMs(timeframeMinutes);
  return targetBarTime + barMs - openedAt >= Math.max(1, maxBars) * barMs;
}

export function isSameNativeDecisionBar(
  timestamp: number,
  targetBarTime: number,
  timeframeMinutes: NativeTimeframeMinutes,
): boolean {
  const barMs = nativeTimeframeMs(timeframeMinutes);
  return Math.floor(timestamp / barMs) * barMs === targetBarTime;
}

/**
 * Build a decision series exclusively from complete, consecutive native 1m
 * candles. Incomplete buckets are omitted rather than silently manufacturing
 * a higher-timeframe candle. High/low are retained for Williams/Stochastic
 * rules; close and volume alone are insufficient for runtime parity.
 */
export function aggregateCompleteNativeBars(
  raw: readonly NativeRawCandle[],
  timeframeMinutes: NativeTimeframeMinutes,
  latestBarTime: number,
): Vwz60Bar[] {
  const barMs = nativeTimeframeMs(timeframeMinutes);
  const buckets = new Map<number, Map<number, {
    high: number;
    low: number;
    close: number;
    volume: number;
  }>>();

  for (const candle of raw) {
    const time = finite(candle.t);
    const high = finite(candle.h);
    const low = finite(candle.l);
    const close = finite(candle.c);
    // Lighter omits zero-valued fields. Missing volume therefore means zero,
    // while missing price fields invalidate the minute.
    const volume = finite(candle.v) ?? 0;
    if (
      time == null
      || high == null
      || low == null
      || close == null
      || high < low
      || low <= 0
      || close <= 0
      || volume < 0
      || time % NATIVE_MINUTE_MS !== 0
    ) continue;
    const bucket = Math.floor(time / barMs) * barMs;
    if (bucket > latestBarTime) continue;
    const minutes = buckets.get(bucket) ?? new Map();
    minutes.set(time, { high, low, close, volume });
    buckets.set(bucket, minutes);
  }

  return [...buckets.entries()]
    .filter(([bucket, minutes]) => {
      if (minutes.size !== timeframeMinutes) return false;
      for (let offset = 0; offset < timeframeMinutes; offset += 1) {
        if (!minutes.has(bucket + offset * NATIVE_MINUTE_MS)) return false;
      }
      return true;
    })
    .sort(([left], [right]) => left - right)
    .map(([time, minutes]) => {
      const ordered = Array.from(
        { length: timeframeMinutes },
        (_, offset) => minutes.get(time + offset * NATIVE_MINUTE_MS)!,
      );
      return {
        time,
        high: Math.max(...ordered.map((candle) => candle.high)),
        low: Math.min(...ordered.map((candle) => candle.low)),
        close: ordered.at(-1)!.close,
        volume: ordered.reduce((total, candle) => total + candle.volume, 0),
      };
    });
}

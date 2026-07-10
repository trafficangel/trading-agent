/** Hyperliquid gives ordinary info requests weight 20 plus extra weight for
 * candleSnapshot response items. Keep archival traffic below 800 of the
 * shared 1200 weight/minute IP budget, leaving room for trading and telemetry. */
const CANDLE_BASE_WEIGHT = 20;
const CANDLE_ITEMS_PER_EXTRA_WEIGHT = 60;
const ARCHIVE_WEIGHT_PER_MINUTE = 800;
const ONE_MINUTE_MS = 60_000;

export function hlCandleSnapshotWeight(itemCount: number): number {
  const items = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  return CANDLE_BASE_WEIGHT + Math.ceil(items / CANDLE_ITEMS_PER_EXTRA_WEIGHT);
}

export function hlCandleArchiveDelayMs(itemCount: number): number {
  return Math.ceil(
    (hlCandleSnapshotWeight(itemCount) * ONE_MINUTE_MS) / ARCHIVE_WEIGHT_PER_MINUTE,
  );
}

import type { PriceLevel } from './venue-arb.js';

export type LighterRestBook = {
  bids: PriceLevel[];
  asks: PriceLevel[];
};

type LighterRestLevel = {
  price?: unknown;
  remaining_base_amount?: unknown;
};

function parseSide(rows: unknown, descending: boolean): PriceLevel[] {
  if (!Array.isArray(rows)) return [];
  const levels = new Map<number, number>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as LighterRestLevel;
    const price = Number(row.price);
    const size = Number(row.remaining_base_amount);
    if (!(price > 0) || !(size > 0) || !Number.isFinite(size)) continue;
    levels.set(price, (levels.get(price) ?? 0) + size);
  }
  return [...levels.entries()].sort((left, right) => (
    descending ? right[0] - left[0] : left[0] - right[0]
  ));
}

/**
 * Parses Lighter's public orderBookOrders response into aggregated price
 * levels. The endpoint has no exchange timestamp, so callers must preserve the
 * request/receive times separately and use the result for shadow calibration.
 */
export function parseLighterRestBook(payload: unknown): LighterRestBook {
  if (!payload || typeof payload !== 'object') {
    throw new Error('invalid Lighter REST order book payload');
  }
  const response = payload as {
    code?: unknown;
    bids?: unknown;
    asks?: unknown;
  };
  if (Number(response.code) !== 200) {
    throw new Error(`Lighter REST order book code ${String(response.code)}`);
  }
  const bids = parseSide(response.bids, true);
  const asks = parseSide(response.asks, false);
  if (!bids.length || !asks.length) {
    throw new Error('Lighter REST order book is missing one side');
  }
  if ((bids[0]?.[0] ?? 0) >= (asks[0]?.[0] ?? 0)) {
    throw new Error('Lighter REST order book is crossed');
  }
  return { bids, asks };
}

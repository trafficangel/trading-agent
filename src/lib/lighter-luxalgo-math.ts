export type PriceLevel = readonly [price: number, size: number];

/** VWAP for a fixed quote-currency notional. Returns null if depth is short. */
export function quoteNotionalVwap(
  levels: readonly PriceLevel[],
  notionalUsd: number,
): number | null {
  if (!(notionalUsd > 0)) return null;
  let remaining = notionalUsd;
  let quantity = 0;
  let cost = 0;
  for (const [price, available] of levels) {
    if (!(price > 0) || !(available > 0)) continue;
    const take = Math.min(available, remaining / price);
    quantity += take;
    cost += take * price;
    remaining -= take * price;
    if (remaining <= 1e-8) return quantity > 0 ? cost / quantity : null;
  }
  return null;
}

export function pricePnlPct(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
): number {
  if (!(entryPrice > 0) || !(exitPrice > 0)) return 0;
  return side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
}

/**
 * Lighter reports funding in percentage points per hour (for example 0.0012
 * means 0.0012%). Positive funding is paid by longs to shorts.
 *
 * This is deliberately an estimate: without a real position there is no
 * account funding ledger, so the shadow uses the mean observed entry/exit
 * rate over the holding interval.
 */
export function estimatedFundingPnlPct(
  side: 'long' | 'short',
  entryRatePctH: number,
  exitRatePctH: number,
  heldMs: number,
): number {
  if (!(heldMs > 0)) return 0;
  const meanRate = (entryRatePctH + exitRatePctH) / 2;
  const signedRate = side === 'long' ? -meanRate : meanRate;
  return signedRate * (heldMs / 3_600_000);
}


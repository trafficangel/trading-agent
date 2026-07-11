export type MakerPrintPoint = { hlPrints: number[] };

/**
 * Return the first sample index where a resting order conservatively fills.
 * Same-price prints must consume all displayed queue ahead. A print through
 * the quote proves that queue was cleared and fills immediately. Signed size
 * is positive for aggressive buys and negative for aggressive sells.
 */
export function makerFillIndex(
  points: MakerPrintPoint[],
  from: number,
  to: number,
  orderSide: 1 | -1,
  quote: number,
  initialQueue: number,
): number {
  let queueAhead = initialQueue;
  for (let j = from; j <= to; j++) {
    const p = points[j]!;
    for (let k = 0; k < p.hlPrints.length; k += 2) {
      const price = p.hlPrints[k]!; const signedSize = p.hlPrints[k + 1]!;
      const relevant = orderSide === 1 ? signedSize < 0 && price <= quote : signedSize > 0 && price >= quote;
      if (!relevant) continue;
      const tradedThrough = orderSide === 1 ? price < quote : price > quote;
      if (tradedThrough) return j;
      queueAhead -= Math.abs(signedSize);
      if (queueAhead <= 0) return j;
    }
  }
  return -1;
}

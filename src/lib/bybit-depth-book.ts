export type BybitDepthBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
};

export type BybitDepthTop = {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bid5: number;
  ask5: number;
};

export function createBybitDepthBook(): BybitDepthBook {
  return { bids: new Map(), asks: new Map() };
}

function applyLevels(side: Map<number, number>, levels: string[][]): void {
  for (const level of levels) {
    const price = Number(level[0]);
    const size = Number(level[1]);
    if (!(price > 0) || !Number.isFinite(size) || size < 0) continue;
    if (size === 0) side.delete(price);
    else side.set(price, size);
  }
}

function topLevels(side: Map<number, number>, descending: boolean): Array<[number, number]> {
  return [...side.entries()]
    .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
    .slice(0, 5);
}

/** Apply a Bybit orderbook.50 snapshot/delta and return the reconstructed L1/L5 view. */
export function applyBybitDepthUpdate(
  book: BybitDepthBook,
  type: 'snapshot' | 'delta',
  bids: string[][],
  asks: string[][],
): BybitDepthTop | null {
  if (type === 'snapshot') {
    book.bids.clear();
    book.asks.clear();
  } else if (!book.bids.size || !book.asks.size) {
    return null;
  }
  applyLevels(book.bids, bids);
  applyLevels(book.asks, asks);
  const topBids = topLevels(book.bids, true);
  const topAsks = topLevels(book.asks, false);
  const bid = topBids[0];
  const ask = topAsks[0];
  if (!bid || !ask || ask[0] <= bid[0]) return null;
  return {
    bid: bid[0],
    ask: ask[0],
    bidSize: bid[1],
    askSize: ask[1],
    bid5: topBids.reduce((sum, level) => sum + level[1], 0),
    ask5: topAsks.reduce((sum, level) => sum + level[1], 0),
  };
}

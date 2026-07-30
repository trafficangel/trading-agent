export type BitfinexDepthBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  initialized: boolean;
};

export type BitfinexBookMessage =
  | readonly [number, readonly (readonly [number, number, number])[]]
  | readonly [number, readonly [number, number, number]];

export function createBitfinexDepthBook(): BitfinexDepthBook {
  return { bids: new Map(), asks: new Map(), initialized: false };
}

function validLevel(
  raw: readonly unknown[],
): readonly [price: number, count: number, amount: number] | null {
  const price = Number(raw[0]);
  const count = Number(raw[1]);
  const amount = Number(raw[2]);
  return price > 0
    && Number.isInteger(count)
    && count >= 0
    && Number.isFinite(amount)
    && amount !== 0
    ? [price, count, amount]
    : null;
}

function applyLevel(
  book: BitfinexDepthBook,
  raw: readonly unknown[],
): boolean {
  const level = validLevel(raw);
  if (!level) return false;
  const [price, count, amount] = level;
  const side = amount > 0 ? book.bids : book.asks;
  if (count === 0) side.delete(price);
  else side.set(price, Math.abs(amount));
  return true;
}

/**
 * Apply a Bitfinex v2 P0 book snapshot/update.
 *
 * Snapshot payload: [chanId, [[price, count, amount], ...]]
 * Update payload:   [chanId, [price, count, amount]]
 * Positive amount is a bid; negative amount is an ask.
 */
export function applyBitfinexBookMessage(
  book: BitfinexDepthBook,
  payload: unknown,
): boolean {
  if (!Array.isArray(payload) || payload.length < 2) return false;
  const body = payload[1];
  if (!Array.isArray(body)) return false;
  const isSnapshot = Array.isArray(body[0]);
  if (isSnapshot) {
    book.bids.clear();
    book.asks.clear();
    let applied = false;
    for (const raw of body) {
      if (Array.isArray(raw)) applied = applyLevel(book, raw) || applied;
    }
    book.initialized = applied && book.bids.size > 0 && book.asks.size > 0;
    return book.initialized;
  }
  if (!book.initialized) return false;
  return applyLevel(book, body);
}

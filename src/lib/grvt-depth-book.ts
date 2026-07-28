export type GrvtDepthLevel = {
  price?: unknown;
  size?: unknown;
};

export type GrvtDepthBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  lastSequence: bigint | null;
  initialized: boolean;
};

export type GrvtDepthUpdateResult =
  | 'snapshot'
  | 'delta'
  | 'duplicate'
  | 'gap'
  | 'invalid';

export function createGrvtDepthBook(): GrvtDepthBook {
  return {
    bids: new Map(),
    asks: new Map(),
    lastSequence: null,
    initialized: false,
  };
}

function sequence(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function updateLevels(
  target: Map<number, number>,
  rows: unknown,
): boolean {
  if (!Array.isArray(rows)) return false;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') return false;
    const row = raw as GrvtDepthLevel;
    const price = Number(row.price);
    const size = Number(row.size);
    if (!(price > 0) || !Number.isFinite(size) || size < 0) return false;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
  return true;
}

export function applyGrvtDepthUpdate(
  book: GrvtDepthBook,
  sequenceValue: unknown,
  previousSequenceValue: unknown,
  bids: unknown,
  asks: unknown,
): GrvtDepthUpdateResult {
  const current = sequence(sequenceValue);
  const previous = sequence(previousSequenceValue);
  if (current == null || previous == null) return 'invalid';

  if (current === 0n) {
    const nextBids = new Map<number, number>();
    const nextAsks = new Map<number, number>();
    if (!updateLevels(nextBids, bids) || !updateLevels(nextAsks, asks)) return 'invalid';
    if (!nextBids.size || !nextAsks.size) return 'invalid';
    book.bids = nextBids;
    book.asks = nextAsks;
    book.lastSequence = null;
    book.initialized = true;
    return 'snapshot';
  }

  if (!book.initialized) return 'gap';
  if (book.lastSequence != null) {
    if (current === book.lastSequence) return 'duplicate';
    if (previous !== book.lastSequence || current !== book.lastSequence + 1n) return 'gap';
  }
  if (!updateLevels(book.bids, bids) || !updateLevels(book.asks, asks)) return 'invalid';
  if (!book.bids.size || !book.asks.size) return 'gap';
  book.lastSequence = current;
  return 'delta';
}

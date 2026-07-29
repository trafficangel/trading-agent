export type HibachiDepthLevel = {
  price?: unknown;
  quantity?: unknown;
};

export type HibachiDepthSide = {
  startPrice?: unknown;
  endPrice?: unknown;
  levels?: unknown;
};

export type HibachiDepthBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  initialized: boolean;
};

export type HibachiDepthApplyResult =
  | 'snapshot'
  | 'update'
  | 'gap'
  | 'invalid';

export function createHibachiDepthBook(): HibachiDepthBook {
  return {
    bids: new Map(),
    asks: new Map(),
    initialized: false,
  };
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function updateLevels(
  target: Map<number, number>,
  rows: unknown,
): boolean {
  if (!Array.isArray(rows)) return false;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') return false;
    const row = raw as HibachiDepthLevel;
    const price = positive(row.price);
    const quantity = nonNegative(row.quantity);
    if (price == null || quantity == null) return false;
    if (quantity === 0) target.delete(price);
    else target.set(price, quantity);
  }
  return true;
}

function updateSide(
  target: Map<number, number>,
  side: HibachiDepthSide | undefined,
): boolean {
  if (!side) return false;
  const start = positive(side.startPrice);
  const end = positive(side.endPrice);
  if (start == null || end == null) return false;
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  for (const price of target.keys()) {
    if (price < lower || price > upper) target.delete(price);
  }
  return updateLevels(target, side.levels);
}

export function applyHibachiDepthUpdate(
  book: HibachiDepthBook,
  messageType: unknown,
  bid: HibachiDepthSide | undefined,
  ask: HibachiDepthSide | undefined,
): HibachiDepthApplyResult {
  const type = String(messageType ?? '').toUpperCase();
  if (type === 'SNAPSHOT') {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    if (!updateLevels(bids, bid?.levels) || !updateLevels(asks, ask?.levels)) {
      return 'invalid';
    }
    if (!bids.size || !asks.size) return 'invalid';
    book.bids = bids;
    book.asks = asks;
    book.initialized = true;
    return 'snapshot';
  }

  if (type !== 'UPDATE') return 'invalid';
  if (!book.initialized) return 'gap';
  if (!updateSide(book.bids, bid) || !updateSide(book.asks, ask)) {
    return 'invalid';
  }
  if (!book.bids.size || !book.asks.size) {
    book.initialized = false;
    return 'gap';
  }
  return 'update';
}

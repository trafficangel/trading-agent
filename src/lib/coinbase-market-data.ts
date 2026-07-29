import type { PriceLevel } from './venue-arb.js';
import type { TakerSide } from './venue-arb-maker.js';

export type CoinbaseDepthBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
};

export type CoinbaseL2Event = {
  type?: unknown;
  product_id?: unknown;
  updates?: unknown;
};

export type CoinbaseMakerTrade = {
  id: string;
  coin: string;
  side: TakerSide;
  price: number;
  size: number;
  tradeAt: number;
};

export function createCoinbaseDepthBook(): CoinbaseDepthBook {
  return { bids: new Map(), asks: new Map() };
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseEventTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function applyCoinbaseL2Event(
  book: CoinbaseDepthBook,
  event: CoinbaseL2Event,
): { applied: boolean; exchangeAt: number | null } {
  if (event.type !== 'snapshot' && event.type !== 'update') {
    return { applied: false, exchangeAt: null };
  }
  if (!Array.isArray(event.updates)) {
    return { applied: false, exchangeAt: null };
  }
  if (event.type === 'snapshot') {
    book.bids.clear();
    book.asks.clear();
  }
  let applied = false;
  let exchangeAt: number | null = null;
  for (const raw of event.updates) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as {
      side?: unknown;
      price_level?: unknown;
      new_quantity?: unknown;
      event_time?: unknown;
    };
    const target = row.side === 'bid'
      ? book.bids
      : row.side === 'offer'
        ? book.asks
        : null;
    const price = finitePositive(row.price_level);
    const quantity = Number(row.new_quantity);
    if (!target || price == null || !Number.isFinite(quantity) || quantity < 0) {
      continue;
    }
    if (quantity === 0) target.delete(price);
    else target.set(price, quantity);
    applied = true;
    const at = parseEventTime(row.event_time);
    if (at != null) exchangeAt = Math.max(exchangeAt ?? at, at);
  }
  return { applied, exchangeAt };
}

export function coinbaseBookLevels(
  book: CoinbaseDepthBook,
): { bids: PriceLevel[]; asks: PriceLevel[] } {
  return {
    bids: [...book.bids].sort((left, right) => right[0] - left[0]),
    asks: [...book.asks].sort((left, right) => left[0] - right[0]),
  };
}

export function parseCoinbaseMakerTrades(
  payload: unknown,
): CoinbaseMakerTrade[] {
  if (!payload || typeof payload !== 'object') return [];
  const message = payload as {
    channel?: unknown;
    events?: unknown;
  };
  if (message.channel !== 'market_trades' || !Array.isArray(message.events)) {
    return [];
  }
  const parsed: CoinbaseMakerTrade[] = [];
  for (const rawEvent of message.events) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const event = rawEvent as { trades?: unknown };
    if (!Array.isArray(event.trades)) continue;
    for (const rawTrade of event.trades) {
      if (!rawTrade || typeof rawTrade !== 'object') continue;
      const trade = rawTrade as {
        product_id?: unknown;
        trade_id?: unknown;
        price?: unknown;
        size?: unknown;
        time?: unknown;
        side?: unknown;
      };
      if (
        typeof trade.product_id !== 'string'
        || !trade.product_id.endsWith('-PERP-INTX')
      ) continue;
      const coin = trade.product_id.slice(0, -'-PERP-INTX'.length);
      const price = finitePositive(trade.price);
      const size = finitePositive(trade.size);
      const tradeAt = parseEventTime(trade.time);
      // Coinbase reports the maker side. The queue model consumes the
      // aggressor/taker side, so it must be inverted.
      const side: TakerSide | null = trade.side === 'BUY'
        ? 'SELL'
        : trade.side === 'SELL'
          ? 'BUY'
          : null;
      if (
        !coin
        || price == null
        || size == null
        || tradeAt == null
        || side == null
      ) continue;
      parsed.push({
        id: `${coin}:${String(trade.trade_id ?? `${trade.time}:${price}:${size}:${trade.side}`)}`,
        coin,
        side,
        price,
        size,
        tradeAt,
      });
    }
  }
  return parsed;
}

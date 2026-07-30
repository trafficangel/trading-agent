import type { PriceLevel } from './venue-arb.js';
import type { TakerSide } from './venue-arb-maker.js';

export type OrderlyBookMessage = {
  coin: string;
  exchangeAt: number;
  previousAt: number | null;
  snapshot: boolean;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

export type OrderlyMakerTrade = {
  id: string;
  coin: string;
  side: TakerSide;
  price: number;
  size: number;
  tradeAt: number;
};

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function orderlyCoin(symbol: unknown): string | null {
  if (
    typeof symbol !== 'string'
    || !symbol.startsWith('PERP_')
    || !symbol.endsWith('_USDC')
  ) return null;
  const coin = symbol.slice('PERP_'.length, -'_USDC'.length);
  return coin || null;
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): PriceLevel[] => {
    if (!Array.isArray(raw)) return [];
    const price = finitePositive(raw[0]);
    const size = Number(raw[1]);
    if (price == null || !Number.isFinite(size) || size < 0) return [];
    return [[price, size]];
  });
}

export function parseOrderlyBookMessage(
  payload: unknown,
): OrderlyBookMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const message = payload as {
    topic?: unknown;
    ts?: unknown;
    data?: {
      symbol?: unknown;
      prevTs?: unknown;
      bids?: unknown;
      asks?: unknown;
    };
  };
  const snapshot = typeof message.topic === 'string'
    && message.topic.endsWith('@orderbook');
  const update = typeof message.topic === 'string'
    && message.topic.endsWith('@orderbookupdate');
  const coin = orderlyCoin(message.data?.symbol);
  const exchangeAt = finitePositive(message.ts);
  if ((!snapshot && !update) || coin == null || exchangeAt == null) return null;
  const previousAt = update ? finitePositive(message.data?.prevTs) : null;
  if (update && previousAt == null) return null;
  const bids = parseLevels(message.data?.bids);
  const asks = parseLevels(message.data?.asks);
  if (snapshot && (!bids.length || !asks.length)) return null;
  return {
    coin,
    exchangeAt,
    previousAt,
    snapshot,
    bids,
    asks,
  };
}

export function parseOrderlyMakerTrades(
  payload: unknown,
): OrderlyMakerTrade[] {
  if (!payload || typeof payload !== 'object') return [];
  const message = payload as {
    topic?: unknown;
    ts?: unknown;
    data?: unknown;
  };
  if (
    typeof message.topic !== 'string'
    || !message.topic.endsWith('@trade')
  ) return [];
  const rows = Array.isArray(message.data) ? message.data : [message.data];
  return rows.flatMap((raw): OrderlyMakerTrade[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as {
      symbol?: unknown;
      price?: unknown;
      size?: unknown;
      side?: unknown;
      ts?: unknown;
      id?: unknown;
    };
    const coin = orderlyCoin(row.symbol);
    const price = finitePositive(row.price);
    const size = finitePositive(row.size);
    const tradeAt = finitePositive(row.ts) ?? finitePositive(message.ts);
    const normalizedSide = typeof row.side === 'string'
      ? row.side.toUpperCase()
      : '';
    const side: TakerSide | null = normalizedSide === 'BUY'
      ? 'BUY'
      : normalizedSide === 'SELL'
        ? 'SELL'
        : null;
    if (
      coin == null
      || price == null
      || size == null
      || tradeAt == null
      || side == null
    ) return [];
    return [{
      id: `orderly:${coin}:${String(
        row.id ?? `${tradeAt}:${price}:${size}:${side}`,
      )}`,
      coin,
      side,
      price,
      size,
      tradeAt,
    }];
  });
}

import { normalizeExchangeTimestampMs, type PriceLevel } from './venue-arb.js';

export type HotstuffBookUpdate = {
  coin: string;
  snapshot: boolean;
  sequence: number;
  exchangeAt: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

export type HotstuffMakerTrade = {
  id: string;
  coin: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  tradeAt: number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function levels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const row = object(raw);
    if (!row) return [];
    const price = positive(row.price);
    const size = Number(row.size);
    return price != null && Number.isFinite(size) && size >= 0
      ? [[price, size] as PriceLevel]
      : [];
  });
}

function eventData(payload: unknown): Record<string, unknown> | null {
  const root = object(payload);
  const params = object(root?.params);
  return object(params?.data);
}

function coinFromInstrument(value: unknown): string | null {
  if (typeof value !== 'string' || !value.endsWith('-PERP')) return null;
  const coin = value.slice(0, -'-PERP'.length).toUpperCase();
  return coin || null;
}

export function parseHotstuffBook(
  payload: unknown,
  receivedAt: number,
): HotstuffBookUpdate | null {
  const root = object(payload);
  const params = object(root?.params);
  if (
    typeof params?.channel !== 'string'
    || !params.channel.startsWith('orderbook:')
  ) return null;
  const data = eventData(payload);
  const books = object(data?.books);
  const coin = coinFromInstrument(books?.instrument_name);
  const sequence = Number(books?.sequence_number);
  if (!coin || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  const updateType = data?.update_type;
  if (updateType !== 'snapshot' && updateType !== 'delta') return null;
  return {
    coin,
    snapshot: updateType === 'snapshot',
    sequence,
    exchangeAt: normalizeExchangeTimestampMs(
      Number(books?.timestamp),
      receivedAt,
    ),
    bids: levels(books?.bids),
    asks: levels(books?.asks),
  };
}

export function parseHotstuffTrade(
  payload: unknown,
  receivedAt: number,
): HotstuffMakerTrade | null {
  const root = object(payload);
  const params = object(root?.params);
  if (
    typeof params?.channel !== 'string'
    || !params.channel.startsWith('trades:')
  ) return null;
  const data = eventData(payload);
  const coin = coinFromInstrument(data?.instrument);
  const price = positive(data?.price);
  const size = positive(data?.size);
  const side = data?.side === 'b'
    ? 'BUY'
    : data?.side === 's'
      ? 'SELL'
      : null;
  if (!coin || price == null || size == null || !side) return null;
  const tradeId = data?.trade_id;
  if (
    typeof tradeId !== 'string'
    && typeof tradeId !== 'number'
    && typeof tradeId !== 'bigint'
  ) return null;
  return {
    id: String(tradeId),
    coin,
    side,
    price,
    size,
    tradeAt: normalizeExchangeTimestampMs(
      typeof data?.timestamp === 'string'
        ? Date.parse(data.timestamp)
        : Number(data?.timestamp),
      receivedAt,
    ),
  };
}

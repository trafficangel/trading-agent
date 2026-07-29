import type { PriceLevel } from './venue-arb.js';
import type { TakerSide } from './venue-arb-maker.js';

export type EtherealProduct = {
  coin: string;
  productId: string;
  makerFeeBps: number;
  takerFeeBps: number;
};

export type EtherealBook = {
  productId: string;
  exchangeAt: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

export type EtherealWsBook = {
  symbol: string;
  exchangeAt: number;
  previousAt: number | null;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

export type EtherealMakerTrade = {
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

function feeBps(value: number): number {
  return Math.round(value * 10_000 * 1e9) / 1e9;
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): PriceLevel[] => {
    if (!Array.isArray(raw)) return [];
    const price = finitePositive(raw[0]);
    const size = finitePositive(raw[1]);
    return price == null || size == null ? [] : [[price, size]];
  });
}

function parseAbsoluteLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): PriceLevel[] => {
    if (!Array.isArray(raw)) return [];
    const price = finitePositive(raw[0]);
    const size = Number(raw[1]);
    return price == null || !Number.isFinite(size) || size < 0
      ? []
      : [[price, size]];
  });
}

export function parseEtherealProducts(payload: unknown): EtherealProduct[] {
  if (!payload || typeof payload !== 'object') return [];
  const rows = (payload as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw): EtherealProduct[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as {
      id?: unknown;
      ticker?: unknown;
      makerFee?: unknown;
      takerFee?: unknown;
    };
    if (
      typeof row.id !== 'string'
      || typeof row.ticker !== 'string'
      || !row.ticker.endsWith('USD')
    ) return [];
    const makerFee = Number(row.makerFee);
    const takerFee = Number(row.takerFee);
    if (!Number.isFinite(makerFee) || !Number.isFinite(takerFee)) return [];
    return [{
      coin: row.ticker.slice(0, -'USD'.length),
      productId: row.id,
      makerFeeBps: feeBps(makerFee),
      takerFeeBps: feeBps(takerFee),
    }];
  });
}

export function parseEtherealBook(payload: unknown): EtherealBook | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as {
    productId?: unknown;
    timestamp?: unknown;
    bids?: unknown;
    asks?: unknown;
  };
  const exchangeAt = finitePositive(row.timestamp);
  if (typeof row.productId !== 'string' || exchangeAt == null) return null;
  const bids = parseLevels(row.bids);
  const asks = parseLevels(row.asks);
  if (!bids.length || !asks.length) return null;
  return {
    productId: row.productId,
    exchangeAt,
    bids,
    asks,
  };
}

export function parseEtherealWsBook(payload: unknown): EtherealWsBook | null {
  if (!payload || typeof payload !== 'object') return null;
  const message = payload as {
    e?: unknown;
    data?: {
      s?: unknown;
      t?: unknown;
      pt?: unknown;
      b?: unknown;
      a?: unknown;
    };
  };
  const exchangeAt = finitePositive(message.data?.t);
  if (
    message.e !== 'L2Book'
    || typeof message.data?.s !== 'string'
    || exchangeAt == null
  ) return null;
  const previousAt = message.data.pt == null
    ? null
    : finitePositive(message.data.pt);
  if (message.data.pt != null && previousAt == null) return null;
  return {
    symbol: message.data.s,
    exchangeAt,
    previousAt,
    bids: parseAbsoluteLevels(message.data.b),
    asks: parseAbsoluteLevels(message.data.a),
  };
}

export function parseEtherealMakerTrades(
  payload: unknown,
  productCoins: ReadonlyMap<string, string>,
): EtherealMakerTrade[] {
  if (!payload || typeof payload !== 'object') return [];
  const rows = (payload as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw): EtherealMakerTrade[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as {
      id?: unknown;
      productId?: unknown;
      makerSide?: unknown;
      price?: unknown;
      filled?: unknown;
      createdAt?: unknown;
    };
    if (typeof row.productId !== 'string') return [];
    const coin = productCoins.get(row.productId);
    const price = finitePositive(row.price);
    const size = finitePositive(row.filled);
    const tradeAt = finitePositive(row.createdAt);
    // Ethereal exposes the maker side (0=BUY, 1=SELL). The queue model
    // consumes the aggressor side, which is the opposite side.
    const side: TakerSide | null = Number(row.makerSide) === 0
      ? 'SELL'
      : Number(row.makerSide) === 1
        ? 'BUY'
        : null;
    if (!coin || price == null || size == null || tradeAt == null || !side) {
      return [];
    }
    return [{
      id: `${coin}:${String(
        row.id ?? `${tradeAt}:${price}:${size}:${row.makerSide}`,
      )}`,
      coin,
      side,
      price,
      size,
      tradeAt,
    }];
  });
}

export function parseEtherealWsTrades(
  payload: unknown,
): EtherealMakerTrade[] {
  if (!payload || typeof payload !== 'object') return [];
  const message = payload as {
    e?: unknown;
    data?: {
      s?: unknown;
      t?: unknown;
      d?: unknown;
    };
  };
  if (
    message.e !== 'TradeFill'
    || typeof message.data?.s !== 'string'
    || !message.data.s.endsWith('USD')
    || !Array.isArray(message.data.d)
  ) return [];
  const coin = message.data.s.slice(0, -'USD'.length);
  const tradeAt = finitePositive(message.data.t);
  if (tradeAt == null) return [];
  return message.data.d.flatMap((raw): EtherealMakerTrade[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as {
      id?: unknown;
      px?: unknown;
      sz?: unknown;
      sd?: unknown;
    };
    const price = finitePositive(row.px);
    const size = finitePositive(row.sz);
    const side: TakerSide | null = Number(row.sd) === 0
      ? 'BUY'
      : Number(row.sd) === 1
        ? 'SELL'
        : null;
    if (price == null || size == null || !side) return [];
    return [{
      id: `${coin}:${String(row.id ?? `${tradeAt}:${price}:${size}:${side}`)}`,
      coin,
      side,
      price,
      size,
      tradeAt,
    }];
  });
}

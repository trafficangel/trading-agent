import type { TakerSide } from './venue-arb-maker.js';

export type LighterPublicTrade = {
  id: string;
  marketId: number;
  side: TakerSide;
  price: number;
  size: number;
  exchangeAt: number;
};

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function marketIdFromChannel(channel: unknown): number {
  if (typeof channel !== 'string') return -1;
  const match = channel.match(/[:/](\d+)$/);
  return match ? finite(match[1]) : -1;
}

/**
 * Lighter exposes the maker side rather than the aggressive side. A maker ask
 * is consumed by a BUY; a maker bid is consumed by a SELL.
 */
export function parseLighterPublicTrades(payload: unknown): LighterPublicTrade[] {
  if (!payload || typeof payload !== 'object') return [];
  const message = payload as {
    channel?: unknown;
    trades?: unknown;
  };
  if (!Array.isArray(message.trades)) return [];
  const channelMarketId = marketIdFromChannel(message.channel);
  return message.trades.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as {
      trade_id?: unknown;
      trade_id_str?: unknown;
      market_id?: unknown;
      price?: unknown;
      size?: unknown;
      is_maker_ask?: unknown;
      timestamp?: unknown;
    };
    const marketId = row.market_id == null
      ? channelMarketId
      : finite(row.market_id);
    const price = finite(row.price);
    const size = finite(row.size);
    const exchangeAt = finite(row.timestamp);
    if (
      marketId < 0
      || !(price > 0)
      || !(size > 0)
      || (row.is_maker_ask !== true && row.is_maker_ask !== false)
    ) return [];
    const side: TakerSide = row.is_maker_ask ? 'BUY' : 'SELL';
    const rawId = row.trade_id_str ?? row.trade_id;
    const id = rawId == null
      ? `${marketId}:${exchangeAt}:${price}:${size}:${side}:${index}`
      : `${marketId}:${String(rawId)}`;
    return [{
      id,
      marketId,
      side,
      price,
      size,
      exchangeAt,
    }];
  });
}

import { describe, expect, it } from 'vitest';
import {
  parseOrderlyBookMessage,
  parseOrderlyMakerTrades,
} from './orderly-market-data.js';

describe('parseOrderlyBookMessage', () => {
  it('parses a full snapshot', () => {
    expect(parseOrderlyBookMessage({
      topic: 'PERP_BTC_USDC@orderbook',
      ts: 1_785_390_123_381,
      data: {
        symbol: 'PERP_BTC_USDC',
        asks: [[64_000.7, 0.05786]],
        bids: [[63_999.4, 0.33159]],
      },
    })).toEqual({
      coin: 'BTC',
      exchangeAt: 1_785_390_123_381,
      previousAt: null,
      snapshot: true,
      asks: [[64_000.7, 0.05786]],
      bids: [[63_999.4, 0.33159]],
    });
  });

  it('keeps zero-sized incremental deletes', () => {
    expect(parseOrderlyBookMessage({
      topic: 'PERP_SOL_USDC@orderbookupdate',
      ts: 1_785_390_124_381,
      data: {
        symbol: 'PERP_SOL_USDC',
        prevTs: 1_785_390_124_181,
        asks: [[150.1, 0]],
        bids: [[150, 12.5]],
      },
    })).toEqual({
      coin: 'SOL',
      exchangeAt: 1_785_390_124_381,
      previousAt: 1_785_390_124_181,
      snapshot: false,
      asks: [[150.1, 0]],
      bids: [[150, 12.5]],
    });
  });

  it('rejects malformed snapshots', () => {
    expect(parseOrderlyBookMessage({
      topic: 'PERP_BTC_USDC@orderbook',
      ts: 123,
      data: { symbol: 'PERP_BTC_USDC', asks: [], bids: [] },
    })).toBeNull();
  });
});

describe('parseOrderlyMakerTrades', () => {
  it('parses aggressor side and stable identity', () => {
    expect(parseOrderlyMakerTrades({
      topic: 'PERP_XRP_USDC@trade',
      ts: 1_785_390_125_000,
      data: {
        symbol: 'PERP_XRP_USDC',
        price: 2.01,
        size: 500,
        side: 'BUY',
        id: 'trade-1',
      },
    })).toEqual([{
      id: 'orderly:XRP:trade-1',
      coin: 'XRP',
      side: 'BUY',
      price: 2.01,
      size: 500,
      tradeAt: 1_785_390_125_000,
    }]);
  });

  it('rejects a trade without a valid side', () => {
    expect(parseOrderlyMakerTrades({
      topic: 'PERP_BTC_USDC@trade',
      ts: 1,
      data: {
        symbol: 'PERP_BTC_USDC',
        price: 1,
        size: 1,
        side: 'UNKNOWN',
      },
    })).toEqual([]);
  });
});

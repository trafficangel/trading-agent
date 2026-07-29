import { describe, expect, it } from 'vitest';
import {
  parseEtherealBook,
  parseEtherealMakerTrades,
  parseEtherealProducts,
  parseEtherealWsBook,
  parseEtherealWsTrades,
} from '../../src/lib/ethereal-market-data.js';

describe('Ethereal market data', () => {
  it('parses product fees in basis points', () => {
    expect(parseEtherealProducts({
      data: [{
        id: 'product-1',
        ticker: 'ETHUSD',
        makerFee: '0',
        takerFee: '0.0003',
      }],
    })).toEqual([{
      coin: 'ETH',
      productId: 'product-1',
      makerFeeBps: 0,
      takerFeeBps: 3,
    }]);
  });

  it('parses an executable liquidity snapshot', () => {
    expect(parseEtherealBook({
      productId: 'product-1',
      timestamp: 1_785_366_529_318,
      bids: [['1903.5', '5.2'], ['bad', '1']],
      asks: [['1903.6', '4.8']],
    })).toEqual({
      productId: 'product-1',
      exchangeAt: 1_785_366_529_318,
      bids: [[1903.5, 5.2]],
      asks: [[1903.6, 4.8]],
    });
  });

  it('inverts maker side into aggressor side and keeps exchange time', () => {
    const coins = new Map([['product-1', 'ETH']]);
    expect(parseEtherealMakerTrades({
      data: [{
        id: 'trade-1',
        productId: 'product-1',
        makerSide: 1,
        price: '1903.6',
        filled: '0.0078',
        createdAt: 1_785_366_529_318,
      }],
    }, coins)).toEqual([{
      id: 'ETH:trade-1',
      coin: 'ETH',
      side: 'BUY',
      price: 1903.6,
      size: 0.0078,
      tradeAt: 1_785_366_529_318,
    }]);
  });

  it('parses websocket L2 snapshots and zero-quantity diffs', () => {
    expect(parseEtherealWsBook({
      e: 'L2Book',
      data: {
        s: 'ETHUSD',
        t: 1_785_366_529_318,
        pt: 1_785_366_529_118,
        b: [['1903.5', '0']],
        a: [['1903.6', '4.8']],
      },
    })).toEqual({
      symbol: 'ETHUSD',
      exchangeAt: 1_785_366_529_318,
      previousAt: 1_785_366_529_118,
      bids: [[1903.5, 0]],
      asks: [[1903.6, 4.8]],
    });
  });

  it('parses websocket trades from the taker perspective', () => {
    expect(parseEtherealWsTrades({
      e: 'TradeFill',
      data: {
        s: 'HYPEUSD',
        t: 1_785_366_529_318,
        d: [{
          id: 'trade-2',
          px: '54.25',
          sz: '3.1',
          sd: 0,
        }],
      },
    })).toEqual([{
      id: 'HYPE:trade-2',
      coin: 'HYPE',
      side: 'BUY',
      price: 54.25,
      size: 3.1,
      tradeAt: 1_785_366_529_318,
    }]);
  });
});

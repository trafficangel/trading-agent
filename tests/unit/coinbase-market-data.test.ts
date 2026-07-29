import { describe, expect, it } from 'vitest';
import {
  applyCoinbaseL2Event,
  coinbaseBookLevels,
  createCoinbaseDepthBook,
  parseCoinbaseMakerTrades,
} from '../../src/lib/coinbase-market-data.js';

describe('Coinbase market data', () => {
  it('applies snapshots and absolute-quantity updates', () => {
    const book = createCoinbaseDepthBook();
    const snapshot = applyCoinbaseL2Event(book, {
      type: 'snapshot',
      updates: [
        {
          side: 'bid',
          price_level: '73.58',
          new_quantity: '20',
          event_time: '2026-07-29T22:25:25.389Z',
        },
        {
          side: 'offer',
          price_level: '73.59',
          new_quantity: '10',
          event_time: '2026-07-29T22:25:25.390Z',
        },
      ],
    });
    expect(snapshot.applied).toBe(true);
    expect(snapshot.exchangeAt).toBe(Date.parse('2026-07-29T22:25:25.390Z'));

    applyCoinbaseL2Event(book, {
      type: 'update',
      updates: [
        {
          side: 'bid',
          price_level: '73.58',
          new_quantity: '0',
          event_time: '2026-07-29T22:25:25.400Z',
        },
        {
          side: 'bid',
          price_level: '73.57',
          new_quantity: '30',
          event_time: '2026-07-29T22:25:25.400Z',
        },
      ],
    });
    expect(coinbaseBookLevels(book)).toEqual({
      bids: [[73.57, 30]],
      asks: [[73.59, 10]],
    });
  });

  it('inverts Coinbase maker side into the aggressor side', () => {
    expect(parseCoinbaseMakerTrades({
      channel: 'market_trades',
      events: [{
        trades: [{
          product_id: 'SOL-PERP-INTX',
          trade_id: '123',
          price: '73.582',
          size: '20',
          time: '2026-07-29T22:25:23.829Z',
          side: 'SELL',
        }],
      }],
    })).toEqual([{
      id: 'SOL:123',
      coin: 'SOL',
      side: 'BUY',
      price: 73.582,
      size: 20,
      tradeAt: Date.parse('2026-07-29T22:25:23.829Z'),
    }]);
  });
});

import { describe, expect, it } from 'vitest';
import { parseLighterPublicTrades } from '../../src/lib/lighter-public-trades.js';

describe('parseLighterPublicTrades', () => {
  it('maps maker asks to aggressive buys and maker bids to aggressive sells', () => {
    expect(parseLighterPublicTrades({
      channel: 'trade/24',
      trades: [
        {
          trade_id: 41,
          market_id: 24,
          price: '42.10',
          size: '2.5',
          is_maker_ask: true,
          timestamp: 1_785_294_000_000,
        },
        {
          trade_id_str: '42',
          market_id: 24,
          price: '42.09',
          size: '1.5',
          is_maker_ask: false,
          timestamp: 1_785_294_000_050,
        },
      ],
    })).toEqual([
      {
        id: '24:41',
        marketId: 24,
        side: 'BUY',
        price: 42.1,
        size: 2.5,
        exchangeAt: 1_785_294_000_000,
      },
      {
        id: '24:42',
        marketId: 24,
        side: 'SELL',
        price: 42.09,
        size: 1.5,
        exchangeAt: 1_785_294_000_050,
      },
    ]);
  });

  it('uses the channel market and rejects malformed rows', () => {
    expect(parseLighterPublicTrades({
      channel: 'trade:7',
      trades: [
        {
          price: '0.52',
          size: '100',
          is_maker_ask: false,
          timestamp: 1_785_294_000,
        },
        {
          price: 0,
          size: 1,
          is_maker_ask: true,
        },
      ],
    })).toHaveLength(1);
    expect(parseLighterPublicTrades({ channel: 'trade/7' })).toEqual([]);
  });

  it('counts liquidation prints because they also consume public queue', () => {
    expect(parseLighterPublicTrades({
      channel: 'trade:24',
      liquidation_trades: [{
        trade_id: 99,
        market_id: 24,
        price: '54.30',
        size: '30',
        is_maker_ask: false,
        timestamp: 1_785_294_000_100,
      }],
    })[0]).toMatchObject({
      id: '24:99',
      marketId: 24,
      side: 'SELL',
      price: 54.3,
      size: 30,
    });
  });
});

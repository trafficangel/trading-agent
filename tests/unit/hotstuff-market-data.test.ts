import { describe, expect, it } from 'vitest';
import {
  parseHotstuffBook,
  parseHotstuffTrade,
} from '../../src/lib/hotstuff-market-data.js';

describe('Hotstuff market data', () => {
  it('parses snapshots and zero-sized delta removals', () => {
    const parsed = parseHotstuffBook({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        channel: 'orderbook:BTC-PERP',
        data: {
          update_type: 'delta',
          books: {
            instrument_name: 'BTC-PERP',
            bids: [{ price: 63_971, size: 0 }],
            asks: [{ price: 63_972, size: 0.05 }],
            sequence_number: 89_860_052,
            timestamp: 1_785_368_660_517,
          },
        },
      },
    }, 1_785_368_660_600);
    expect(parsed).toEqual({
      coin: 'BTC',
      snapshot: false,
      sequence: 89_860_052,
      exchangeAt: 1_785_368_660_517,
      bids: [[63_971, 0]],
      asks: [[63_972, 0.05]],
    });
  });

  it('maps the documented aggressor side into maker-fill input', () => {
    const parsed = parseHotstuffTrade({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        channel: 'trades:ETH-PERP',
        data: {
          instrument: 'ETH-PERP',
          trade_id: '1977789105883768779',
          side: 'b',
          price: '1907.50',
          size: '0.25',
          timestamp: '2026-07-29T23:33:28.855Z',
        },
      },
    }, Date.parse('2026-07-29T23:33:29.000Z'));
    expect(parsed).toEqual({
      id: '1977789105883768779',
      coin: 'ETH',
      side: 'BUY',
      price: 1907.5,
      size: 0.25,
      tradeAt: Date.parse('2026-07-29T23:33:28.855Z'),
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyBitfinexBookMessage,
  createBitfinexDepthBook,
  parseBitfinexTradeMessage,
} from '../../src/lib/bitfinex-depth-book.js';

describe('Bitfinex depth book', () => {
  it('builds a snapshot and uses absolute ask sizes', () => {
    const book = createBitfinexDepthBook();
    expect(applyBitfinexBookMessage(book, [
      17,
      [
        [100, 2, 1.5],
        [99, 1, 2],
        [101, 3, -1.25],
        [102, 1, -4],
      ],
    ])).toBe(true);
    expect([...book.bids.entries()]).toEqual([[100, 1.5], [99, 2]]);
    expect([...book.asks.entries()]).toEqual([[101, 1.25], [102, 4]]);
  });

  it('updates and removes the side selected by amount sign', () => {
    const book = createBitfinexDepthBook();
    applyBitfinexBookMessage(book, [
      17,
      [[100, 1, 2], [101, 1, -3]],
    ]);
    expect(applyBitfinexBookMessage(book, [17, [100, 0, 1]])).toBe(true);
    expect(applyBitfinexBookMessage(book, [17, [101, 2, -5]])).toBe(true);
    expect(book.bids.has(100)).toBe(false);
    expect(book.asks.get(101)).toBe(5);
  });

  it('rejects heartbeats and deltas before a snapshot', () => {
    const book = createBitfinexDepthBook();
    expect(applyBitfinexBookMessage(book, [17, 'hb'])).toBe(false);
    expect(applyBitfinexBookMessage(book, [17, [100, 1, 2]])).toBe(false);
  });

  it('parses each execution once and maps amount sign to taker side', () => {
    expect(parseBitfinexTradeMessage(
      [22, 'te', [1234, 1_785_000_000_000, -0.25, 64_000]],
      'BTC',
    )).toEqual({
      id: 'BTC:1234',
      coin: 'BTC',
      side: 'SELL',
      price: 64_000,
      size: 0.25,
      tradeAt: 1_785_000_000_000,
    });
    expect(parseBitfinexTradeMessage(
      [22, 'tu', [1234, 1_785_000_000_000, -0.25, 64_000]],
      'BTC',
    )).toBeNull();
    expect(parseBitfinexTradeMessage(
      [22, [[1234, 1_785_000_000_000, -0.25, 64_000]]],
      'BTC',
    )).toBeNull();
  });
});

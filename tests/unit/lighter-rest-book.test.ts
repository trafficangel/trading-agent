import { describe, expect, it } from 'vitest';
import { parseLighterRestBook } from '../../src/lib/lighter-rest-book.js';

describe('parseLighterRestBook', () => {
  it('filters invalid rows, aggregates prices, and sorts both sides', () => {
    const book = parseLighterRestBook({
      code: 200,
      bids: [
        { price: '99', remaining_base_amount: '2' },
        { price: '100', remaining_base_amount: '1' },
        { price: '100', remaining_base_amount: '0.5' },
        { price: '98', remaining_base_amount: '0' },
      ],
      asks: [
        { price: '102', remaining_base_amount: '2' },
        { price: '101', remaining_base_amount: '1' },
        { price: '101', remaining_base_amount: '0.25' },
        { price: 'bad', remaining_base_amount: '3' },
      ],
    });

    expect(book).toEqual({
      bids: [[100, 1.5], [99, 2]],
      asks: [[101, 1.25], [102, 2]],
    });
  });

  it('rejects failed, incomplete, and crossed snapshots', () => {
    expect(() => parseLighterRestBook({ code: 500 })).toThrow(/code 500/);
    expect(() => parseLighterRestBook({
      code: 200,
      bids: [],
      asks: [{ price: '101', remaining_base_amount: '1' }],
    })).toThrow(/missing one side/);
    expect(() => parseLighterRestBook({
      code: 200,
      bids: [{ price: '101', remaining_base_amount: '1' }],
      asks: [{ price: '100', remaining_base_amount: '1' }],
    })).toThrow(/crossed/);
  });
});

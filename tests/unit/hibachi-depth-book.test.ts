import { describe, expect, it } from 'vitest';
import {
  applyHibachiDepthUpdate,
  createHibachiDepthBook,
} from '../../src/lib/hibachi-depth-book.js';

describe('applyHibachiDepthUpdate', () => {
  it('loads a snapshot and applies bounded delta updates', () => {
    const book = createHibachiDepthBook();
    expect(applyHibachiDepthUpdate(
      book,
      'Snapshot',
      {
        startPrice: '100',
        endPrice: '98',
        levels: [
          { price: '100', quantity: '2' },
          { price: '99', quantity: '3' },
          { price: '98', quantity: '4' },
        ],
      },
      {
        startPrice: '101',
        endPrice: '103',
        levels: [
          { price: '101', quantity: '2' },
          { price: '102', quantity: '3' },
          { price: '103', quantity: '4' },
        ],
      },
    )).toBe('snapshot');

    expect(applyHibachiDepthUpdate(
      book,
      'Update',
      {
        startPrice: '100',
        endPrice: '99',
        levels: [
          { price: '100', quantity: '1' },
          { price: '99', quantity: '0' },
        ],
      },
      {
        startPrice: '101',
        endPrice: '102',
        levels: [
          { price: '101', quantity: '5' },
        ],
      },
    )).toBe('update');
    expect([...book.bids]).toEqual([[100, 1]]);
    expect([...book.asks]).toEqual([[101, 5], [102, 3]]);
  });

  it('requires a snapshot before updates', () => {
    const book = createHibachiDepthBook();
    expect(applyHibachiDepthUpdate(
      book,
      'Update',
      { startPrice: 100, endPrice: 99, levels: [] },
      { startPrice: 101, endPrice: 102, levels: [] },
    )).toBe('gap');
  });

  it('rejects malformed snapshots without corrupting the book', () => {
    const book = createHibachiDepthBook();
    expect(applyHibachiDepthUpdate(
      book,
      'Snapshot',
      { levels: [{ price: '100', quantity: '-1' }] },
      { levels: [{ price: '101', quantity: '1' }] },
    )).toBe('invalid');
    expect(book.initialized).toBe(false);
  });
});

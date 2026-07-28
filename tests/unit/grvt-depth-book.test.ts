import { describe, expect, it } from 'vitest';
import {
  applyGrvtDepthUpdate,
  createGrvtDepthBook,
} from '../../src/lib/grvt-depth-book.js';

describe('GRVT depth book', () => {
  it('loads the sequence-zero snapshot and applies ordered deltas', () => {
    const book = createGrvtDepthBook();
    expect(applyGrvtDepthUpdate(
      book,
      '0',
      '0',
      [{ price: '100', size: '2' }],
      [{ price: '101', size: '3' }],
    )).toBe('snapshot');
    expect(applyGrvtDepthUpdate(
      book,
      '18',
      '17',
      [{ price: '100', size: '0' }, { price: '99', size: '4' }],
      [{ price: '101', size: '5' }],
    )).toBe('delta');
    expect(book.bids).toEqual(new Map([[99, 4]]));
    expect(book.asks).toEqual(new Map([[101, 5]]));
    expect(book.lastSequence).toBe(18n);
  });

  it('rejects a sequence gap without mutating the book', () => {
    const book = createGrvtDepthBook();
    applyGrvtDepthUpdate(
      book,
      '0',
      '0',
      [{ price: '100', size: '2' }],
      [{ price: '101', size: '3' }],
    );
    applyGrvtDepthUpdate(book, '8', '7', [], []);
    expect(applyGrvtDepthUpdate(
      book,
      '10',
      '9',
      [{ price: '100', size: '99' }],
      [],
    )).toBe('gap');
    expect(book.bids.get(100)).toBe(2);
  });

  it('ignores duplicate deltas and rejects deltas before a snapshot', () => {
    const book = createGrvtDepthBook();
    expect(applyGrvtDepthUpdate(book, '2', '1', [], [])).toBe('gap');
    applyGrvtDepthUpdate(
      book,
      '0',
      '0',
      [{ price: '100', size: '2' }],
      [{ price: '101', size: '3' }],
    );
    applyGrvtDepthUpdate(book, '2', '1', [], []);
    expect(applyGrvtDepthUpdate(
      book,
      '2',
      '1',
      [{ price: '100', size: '9' }],
      [],
    )).toBe('duplicate');
    expect(book.bids.get(100)).toBe(2);
  });
});

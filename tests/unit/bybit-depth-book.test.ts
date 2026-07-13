import { describe, expect, it } from 'vitest';
import { applyBybitDepthUpdate, createBybitDepthBook } from '../../src/lib/bybit-depth-book.js';

describe('Bybit L50 reconstruction', () => {
  it('sorts a snapshot and aggregates the best five levels', () => {
    const book = createBybitDepthBook();
    const top = applyBybitDepthUpdate(book, 'snapshot',
      [['99', '2'], ['100', '1'], ['98', '3']],
      [['102', '4'], ['101', '2'], ['103', '1']],
    );
    expect(top).toEqual({ bid: 100, ask: 101, bidSize: 1, askSize: 2, bid5: 6, ask5: 7 });
  });

  it('applies delta deletions and insertions without losing untouched levels', () => {
    const book = createBybitDepthBook();
    applyBybitDepthUpdate(book, 'snapshot', [['100', '2'], ['99', '3']], [['101', '4'], ['102', '5']]);
    const top = applyBybitDepthUpdate(book, 'delta', [['100', '0'], ['99.5', '1']], [['101', '6']]);
    expect(top).toEqual({ bid: 99.5, ask: 101, bidSize: 1, askSize: 6, bid5: 4, ask5: 11 });
  });

  it('refuses a delta before the first snapshot', () => {
    expect(applyBybitDepthUpdate(createBybitDepthBook(), 'delta', [['100', '1']], [['101', '1']])).toBeNull();
  });
});

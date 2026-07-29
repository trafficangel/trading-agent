import { describe, expect, it } from 'vitest';
import {
  applyEdgexDepthUpdate,
  type EdgexDepthState,
} from '../../src/lib/edgex-depth-book.js';

function state(): EdgexDepthState {
  return { bids: new Map(), asks: new Map(), version: null };
}

describe('applyEdgexDepthUpdate', () => {
  it('replaces the book from a snapshot', () => {
    const book = state();
    expect(applyEdgexDepthUpdate(book, {
      dataType: 'Snapshot',
      startVersion: '10',
      endVersion: '12',
      bids: [{ price: '100', size: '2' }],
      asks: [{ price: '101', size: '3' }],
    })).toBe('snapshot');
    expect(book.version).toBe(12n);
    expect([...book.bids]).toEqual([[100, 2]]);
    expect([...book.asks]).toEqual([[101, 3]]);
  });

  it('applies an overlapping changed event and deletes zero sizes', () => {
    const book = state();
    applyEdgexDepthUpdate(book, {
      depthType: 'SNAPSHOT',
      startVersion: '10',
      endVersion: '12',
      bids: [{ price: '100', size: '2' }],
      asks: [{ price: '101', size: '3' }],
    });
    expect(applyEdgexDepthUpdate(book, {
      depthType: 'CHANGED',
      startVersion: '12',
      endVersion: '15',
      bids: [{ price: '100', size: '0' }, { price: '99', size: '4' }],
      asks: [{ price: '101', size: '5' }],
    })).toBe('changed');
    expect(book.version).toBe(15n);
    expect([...book.bids]).toEqual([[99, 4]]);
    expect([...book.asks]).toEqual([[101, 5]]);
  });

  it('rejects a sequence gap without mutating the book', () => {
    const book = state();
    applyEdgexDepthUpdate(book, {
      depthType: 'SNAPSHOT',
      startVersion: '10',
      endVersion: '12',
      bids: [{ price: '100', size: '2' }],
      asks: [{ price: '101', size: '3' }],
    });
    expect(applyEdgexDepthUpdate(book, {
      depthType: 'CHANGED',
      startVersion: '14',
      endVersion: '15',
      bids: [{ price: '99', size: '4' }],
    })).toBe('gap');
    expect(book.version).toBe(12n);
    expect([...book.bids]).toEqual([[100, 2]]);
  });

  it('ignores an already applied update', () => {
    const book = state();
    applyEdgexDepthUpdate(book, {
      depthType: 'SNAPSHOT',
      startVersion: '10',
      endVersion: '12',
      bids: [{ price: '100', size: '2' }],
      asks: [{ price: '101', size: '3' }],
    });
    expect(applyEdgexDepthUpdate(book, {
      depthType: 'CHANGED',
      startVersion: '10',
      endVersion: '12',
      bids: [{ price: '99', size: '4' }],
    })).toBe('duplicate');
    expect([...book.bids]).toEqual([[100, 2]]);
  });
});

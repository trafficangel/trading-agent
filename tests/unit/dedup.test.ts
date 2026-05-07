import { describe, it, expect } from 'vitest';
import { makeDedupKey } from '../../src/signals/dedup.js';
import type { LuxAlgoPayload } from '../../src/webhooks/luxalgo.schema.js';

const base: LuxAlgoPayload = {
  symbol: 'BTCUSDT',
  timeframe: '5',
  source: 'signals_overlays',
  event: 'bullish_plus',
  direction: 'up',
  price: 67000,
  bar_time: 1714867200000,
};

describe('dedup key', () => {
  it('same payload yields same key', () => {
    expect(makeDedupKey(base)).toBe(makeDedupKey({ ...base }));
  });
  it('different bar_time yields different key', () => {
    expect(makeDedupKey(base)).not.toBe(makeDedupKey({ ...base, bar_time: base.bar_time + 1 }));
  });
  it('price not part of dedup key', () => {
    expect(makeDedupKey(base)).toBe(makeDedupKey({ ...base, price: 99999 }));
  });
  it('different event yields different key', () => {
    expect(makeDedupKey(base)).not.toBe(makeDedupKey({ ...base, event: 'bearish_plus' }));
  });
});

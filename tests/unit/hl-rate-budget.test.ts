import { describe, expect, it } from 'vitest';
import { activePerpCoinNames } from '../../src/exchange/hyperliquid.js';
import {
  hlCandleArchiveDelayMs,
  hlCandleSnapshotWeight,
} from '../../src/lib/hl-rate-budget.js';

describe('Hyperliquid archival rate budget', () => {
  it.each([
    [0, 20, 1500],
    [1, 21, 1575],
    [60, 21, 1575],
    [61, 22, 1650],
    [4896, 102, 7650],
  ])('paces %i returned candles at weight %i', (items, weight, delayMs) => {
    expect(hlCandleSnapshotWeight(items)).toBe(weight);
    expect(hlCandleArchiveDelayMs(items)).toBe(delayMs);
  });

  it('keeps only active primary-perp symbols', () => {
    expect(activePerpCoinNames([
      { name: 'BTC' },
      { name: 'OLD', isDelisted: true },
      { name: 'xyz:XYZ100' },
      { name: 'kPEPE', isDelisted: false },
    ])).toEqual(['BTC', 'kPEPE']);
  });
});

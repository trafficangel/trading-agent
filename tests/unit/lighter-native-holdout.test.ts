import { describe, expect, it } from 'vitest';
import {
  normalizeHoldoutSymbol,
  performanceSymbols,
  reservedHoldoutLeaks,
} from '../../src/lib/lighter-native-holdout.js';

describe('Native Quant sealed holdout', () => {
  it('normalizes symbols without treating non-performance metadata as exposure', () => {
    expect(normalizeHoldoutSymbol(' spxUSDT ')).toBe('SPX');
    expect(performanceSymbols({ symbols: ['SPX'], summaries: { SPX: {} } })).toEqual([]);
    expect(performanceSymbols({ input: { symbols: ['spxUSDT', 'BERA', 'BERA'] } }))
      .toEqual(['SPX', 'BERA']);
  });

  it('reports every performance file that leaks a reserved market', () => {
    expect(reservedHoldoutLeaks([
      { file: 'cost.json', content: { summaries: { SPX: {} } } },
      { file: 'discovery.json', content: { input: { symbols: ['BTC', 'SPXUSDT'] } } },
      { file: 'holdout.json', content: { input: { symbols: ['BERA'] } } },
    ], ['SPX', 'BERA'])).toEqual({
      BERA: ['holdout.json'],
      SPX: ['discovery.json'],
    });
  });
});

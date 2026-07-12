import { describe, expect, it } from 'vitest';
import {
  parseTardisBookSnapshot,
  parseTardisLiquidation,
  parseTardisTrade,
} from '../../src/lib/tardis-hft.js';

describe('Tardis HFT CSV parsing', () => {
  it('parses a five-level book and aggregates depth', () => {
    const event = parseTardisBookSnapshot(
      'hyperliquid,BTC,1780272000996000,1780272003565242,101,1,100,2,102,3,99,4,103,5,98,6,104,7,97,8,105,9,96,10',
    );
    expect(event).toEqual({
      kind: 'book',
      exchangeAtUs: 1780272000996000,
      receivedAtUs: 1780272003565242,
      ask: 101,
      bid: 100,
      askSize: 1,
      bidSize: 2,
      ask5: 25,
      bid5: 30,
    });
  });

  it('parses normalized aggressor-side trades', () => {
    expect(
      parseTardisTrade('hyperliquid,BTC,1780272002081000,1780272004033472,42,sell,73660,0.01'),
    ).toMatchObject({ kind: 'trade', side: 'sell', price: 73660, size: 0.01 });
  });

  it('keeps normalized liquidation pressure direction', () => {
    expect(
      parseTardisLiquidation('bybit,BTCUSDT,1780272522599000,1780272522737896,,sell,73466.3,0.001'),
    ).toMatchObject({ kind: 'liquidation', side: 'sell', price: 73466.3, size: 0.001 });
  });

  it('rejects crossed books', () => {
    expect(() =>
      parseTardisBookSnapshot(
        'x,BTC,1,2,100,1,101,2,102,3,99,4,103,5,98,6,104,7,97,8,105,9,96,10',
      ),
    ).toThrow('crossed Tardis book');
  });
});

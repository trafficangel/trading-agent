import { describe, it, expect } from 'vitest';
import { normalizeSymbol, splitSymbol } from '../../src/exchange/symbols.js';

describe('splitSymbol', () => {
  it('splits TONUSDT → [TON, USDT]', () => {
    expect(splitSymbol('TONUSDT')).toEqual(['TON', 'USDT']);
  });
  it('splits BTCUSDT → [BTC, USDT]', () => {
    expect(splitSymbol('BTCUSDT')).toEqual(['BTC', 'USDT']);
  });
  it('splits ETHUSDC → [ETH, USDC]', () => {
    expect(splitSymbol('ETHUSDC')).toEqual(['ETH', 'USDC']);
  });
  it('throws on unknown quote', () => {
    expect(() => splitSymbol('FOOBAR')).toThrow();
  });
  it('throws on empty base (just quote)', () => {
    expect(() => splitSymbol('USDT')).toThrow();
  });
});

describe('normalizeSymbol', () => {
  it('Bybit passthrough', () => {
    expect(normalizeSymbol('TONUSDT', 'bybit')).toBe('TONUSDT');
  });
  it('Binance passthrough', () => {
    expect(normalizeSymbol('TONUSDT', 'binance')).toBe('TONUSDT');
  });
  it('OKX adds dashes and -SWAP', () => {
    expect(normalizeSymbol('TONUSDT', 'okx')).toBe('TON-USDT-SWAP');
    expect(normalizeSymbol('BTCUSDT', 'okx')).toBe('BTC-USDT-SWAP');
    expect(normalizeSymbol('ETHUSDC', 'okx')).toBe('ETH-USDC-SWAP');
  });
});

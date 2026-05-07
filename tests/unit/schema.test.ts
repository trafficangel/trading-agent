import { describe, it, expect } from 'vitest';
import { LuxAlgoPayload } from '../../src/webhooks/luxalgo.schema.js';

describe('LuxAlgoPayload', () => {
  it('accepts unix ms bar_time', () => {
    const r = LuxAlgoPayload.parse({
      symbol: 'BTCUSDT',
      timeframe: '5',
      source: 'signals_overlays',
      event: 'bullish_plus',
      bar_time: 1714867200000,
    });
    expect(r.bar_time).toBe(1714867200000);
  });

  it('accepts ISO 8601 bar_time and converts to ms', () => {
    const r = LuxAlgoPayload.parse({
      symbol: 'BTCUSDT',
      timeframe: '5',
      source: 'signals_overlays',
      event: 'bullish_plus',
      bar_time: '2024-05-05T00:00:00Z',
    });
    expect(r.bar_time).toBe(Date.parse('2024-05-05T00:00:00Z'));
  });

  it('strips Bybit perpetual .P suffix from symbol', () => {
    const r = LuxAlgoPayload.parse({
      symbol: 'tonusdt.p',
      timeframe: '15',
      source: 'pac',
      event: 'bos_up',
      bar_time: 0,
    });
    expect(r.symbol).toBe('TONUSDT');
  });

  it('rejects invalid bar_time string', () => {
    expect(() =>
      LuxAlgoPayload.parse({
        symbol: 'BTCUSDT',
        timeframe: '5',
        source: 'signals_overlays',
        event: 'bullish_plus',
        bar_time: 'not-a-date',
      }),
    ).toThrow();
  });

  it('rejects invalid source', () => {
    expect(() =>
      LuxAlgoPayload.parse({
        symbol: 'BTCUSDT',
        timeframe: '5',
        source: 'unknown',
        event: 'bullish_plus',
        bar_time: 0,
      }),
    ).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import {
  LuxAlgoPayload,
  deriveActionSide,
  parseLuxAlgoWebhook,
} from '../../src/webhooks/luxalgo.schema.js';

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

describe('LuxAlgo custom strategy payload', () => {
  it('accepts the explicit SOL Z60 entry alert', () => {
    const result = parseLuxAlgoWebhook({
      kind: 'strategy',
      strategy_id: 'sol-z60-reclaim',
      action: 'entry',
      side: 'long',
      symbol: 'SOLUSDT',
      timeframe: '5',
      price: 180.25,
      bar_time: 1785409200000,
      reason: 'z60_reclaim',
    });

    expect(result.success).toBe(true);
    if (!result.success || result.data.kind !== 'strategy') return;
    expect(deriveActionSide(result.data)).toEqual({ action: 'entry', side: 'long' });
    expect(result.data.symbol).toBe('SOLUSDT');
  });

  it('accepts the explicit SOL Z60 exit alert', () => {
    const result = parseLuxAlgoWebhook({
      kind: 'strategy',
      strategy_id: 'sol-z60-reclaim',
      action: 'exit',
      side: 'short',
      symbol: 'SOLUSDT',
      timeframe: '5',
      price: 178.5,
      bar_time: 1785409500000,
      reason: 'sma60_cross',
    });

    expect(result.success).toBe(true);
    if (!result.success || result.data.kind !== 'strategy') return;
    expect(deriveActionSide(result.data)).toEqual({ action: 'exit', side: 'short' });
  });
});

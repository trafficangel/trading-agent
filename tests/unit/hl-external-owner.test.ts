import { describe, expect, it } from 'vitest';
import { parseHlExternalOwner } from '../../src/lib/hl-external-owner.js';

const NOW = 1_700_000_000_000;

function lease(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'open',
    coin: 'BTC',
    hlSide: 'long',
    intentId: 'arb-1',
    updatedAt: NOW - 1_000,
    leaseExpiresAt: NOW + 20_000,
    ...overrides,
  });
}

describe('Hyperliquid external owner lease', () => {
  it('accepts a fresh active executor lease', () => {
    expect(parseHlExternalOwner(lease(), NOW)).toMatchObject({
      coin: 'BTC', side: 'long', phase: 'open', intentId: 'arb-1',
    });
  });

  it('rejects stale heartbeats and expired leases', () => {
    expect(parseHlExternalOwner(lease({ updatedAt: NOW - 31_000 }), NOW)).toBeNull();
    expect(parseHlExternalOwner(lease({ leaseExpiresAt: NOW - 1 }), NOW)).toBeNull();
  });

  it('rejects idle, malformed, and implausibly long leases', () => {
    expect(parseHlExternalOwner(lease({ phase: 'idle' }), NOW)).toBeNull();
    expect(parseHlExternalOwner(lease({ hlSide: 'flat' }), NOW)).toBeNull();
    expect(parseHlExternalOwner(lease({ leaseExpiresAt: NOW + 6 * 60_000 }), NOW)).toBeNull();
    expect(parseHlExternalOwner('{bad json', NOW)).toBeNull();
  });
});

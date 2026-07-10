import { describe, expect, it } from 'vitest';
import { auditHlPositionOwnership } from '../../src/lib/hl-position-ownership.js';

describe('Hyperliquid position ownership audit', () => {
  it('accepts one matching DB owner per exchange position', () => {
    expect(auditHlPositionOwnership(
      [{ coin: 'BTC', side: 'long' }, { coin: 'DOGE', side: 'short' }],
      [
        { coin: 'BTC', side: 'long', owner: 'hl-momentum' },
        { coin: 'DOGE', side: 'short', owner: 'wick-fade' },
      ],
    )).toEqual({ ok: true, issues: [] });
  });

  it('detects duplicate ownership and unowned exchange positions', () => {
    const result = auditHlPositionOwnership(
      [{ coin: 'BTC', side: 'long' }, { coin: 'ETH', side: 'short' }],
      [
        { coin: 'BTC', side: 'long', owner: 'hl-momentum' },
        { coin: 'BTC', side: 'long', owner: 'wick-fade' },
      ],
    );
    expect(result.issues.map((i) => i.kind)).toEqual(['duplicate-owner', 'unowned-exchange']);
  });

  it('detects missing exchange positions and side mismatches', () => {
    const result = auditHlPositionOwnership(
      [{ coin: 'BTC', side: 'short' }],
      [
        { coin: 'BTC', side: 'long', owner: 'hl-momentum' },
        { coin: 'DOGE', side: 'short', owner: 'wick-fade' },
      ],
    );
    expect(result.issues.map((i) => i.kind)).toEqual(['side-mismatch', 'missing-exchange']);
  });
});

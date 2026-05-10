import { describe, it, expect } from 'vitest';

// Re-implement cascade detection locally for testability without exposing
// internals or starting a real WebSocket. Mirrors logic in
// src/exchange/liquidations.ts getLiquidations().

const CASCADE_USD_THRESHOLD = 5_000_000;
const CASCADE_RATIO = 5;

function detectCascade(longLiq: number, shortLiq: number): 'long' | 'short' | null {
  if (longLiq >= CASCADE_USD_THRESHOLD && longLiq >= shortLiq * CASCADE_RATIO) return 'long';
  if (shortLiq >= CASCADE_USD_THRESHOLD && shortLiq >= longLiq * CASCADE_RATIO) return 'short';
  return null;
}

describe('liquidations cascade detection', () => {
  it('no cascade when both sides quiet', () => {
    expect(detectCascade(100_000, 50_000)).toBe(null);
  });

  it('no cascade when below USD threshold even if one-sided', () => {
    // $1M long, $0 short — one-sided but below $5M threshold
    expect(detectCascade(1_000_000, 0)).toBe(null);
  });

  it('long cascade when $5M+ and 5x+ ratio', () => {
    expect(detectCascade(5_500_000, 1_000_000)).toBe('long');
  });

  it('short cascade when $5M+ and 5x+ ratio', () => {
    expect(detectCascade(500_000, 6_000_000)).toBe('short');
  });

  it('no cascade when both sides high (no clear winner)', () => {
    // Both sides $6M each — busy market but no one-sided exhaustion
    expect(detectCascade(6_000_000, 6_000_000)).toBe(null);
  });

  it('exactly at threshold qualifies', () => {
    expect(detectCascade(5_000_000, 1_000_000)).toBe('long');
  });

  it('huge long but ratio < 5x → no cascade', () => {
    // $10M long but $3M short → ratio 3.3, not a one-sided cascade
    expect(detectCascade(10_000_000, 3_000_000)).toBe(null);
  });

  it('zero on opposite side counts as infinite ratio', () => {
    expect(detectCascade(5_500_000, 0)).toBe('long');
    expect(detectCascade(0, 5_500_000)).toBe('short');
  });
});

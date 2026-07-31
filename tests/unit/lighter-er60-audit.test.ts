import { describe, expect, it } from 'vitest';
import { auditEr60Strategy, type Er60Trade } from '../../src/lib/lighter-er60-audit.js';

function trade(index: number, side: 'long' | 'short', netPct: number, er60: number): Er60Trade {
  return {
    side,
    openedAt: index * 86_400_000,
    closedAt: index * 86_400_000 + 60_000,
    netPct,
    er60,
  };
}

describe('auditEr60Strategy', () => {
  it('keeps an immature prospective cohort ineligible', () => {
    const result = auditEr60Strategy([trade(0, 'long', 1, 0.2)]);
    expect(result.thresholds[0]?.eligibleToReplace).toBe(false);
    expect(result.thresholds[0]?.failures).toContain('closed 1/60');
  });

  it('allows replacement only when enough excluded high-ER trades lose money', () => {
    const rows = Array.from({ length: 70 }, (_, index) => index < 20
      ? trade(index, index % 2 ? 'long' : 'short', -0.2, 0.5)
      : trade(index, index % 2 ? 'long' : 'short', 0.1, 0.2));
    const result = auditEr60Strategy(rows, [0.35]);
    expect(result.thresholds[0]?.eligibleToReplace).toBe(true);
    expect(result.thresholds[0]?.excluded.netPct).toBe(-4);
    expect(result.thresholds[0]?.improvementPct).toBe(4);
  });

  it('rejects a filter that removes profitable trades', () => {
    const rows = Array.from({ length: 70 }, (_, index) =>
      trade(index, index % 2 ? 'long' : 'short', 0.1, index < 20 ? 0.5 : 0.2));
    const result = auditEr60Strategy(rows, [0.35]);
    expect(result.thresholds[0]?.eligibleToReplace).toBe(false);
    expect(result.thresholds[0]?.failures.some((failure) => failure.includes('not negative')))
      .toBe(true);
  });
});

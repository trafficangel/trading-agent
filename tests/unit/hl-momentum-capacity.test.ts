import { describe, expect, it } from 'vitest';
import { isConfidentMomentumSignal } from '../../src/lib/hl-momentum-capacity.js';

describe('HL momentum confidence capacity', () => {
  const strong = {
    layer: 'confirm' as const,
    score: 96,
    prob: 0.62,
    expectedPnl: 0.25,
  };

  it('accepts a confirm signal at every confidence boundary', () => {
    expect(isConfidentMomentumSignal(strong)).toBe(true);
  });

  it.each([
    [{ ...strong, layer: 'fast' as const }, 'fast layer'],
    [{ ...strong, score: 95 }, 'low score'],
    [{ ...strong, prob: 0.619 }, 'low probability'],
    [{ ...strong, expectedPnl: 0.249 }, 'low expected pnl'],
  ])('rejects %s (%s)', (signal, _reason) => {
    expect(isConfidentMomentumSignal(signal)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { missingCandleWindows } from '../../src/lib/lighter-candle-windows.js';

describe('missingCandleWindows', () => {
  const step = 300_000;

  it('uses exclusive page ends without skipping the 500th boundary bar', () => {
    const windows = missingCandleWindows([], 0, 999 * step, step);
    expect(windows).toEqual([
      [0, 500 * step],
      [500 * step, 1_000 * step],
    ]);
  });

  it('fills internal cache gaps as well as missing edges', () => {
    const existing = [step, 2 * step, 4 * step];
    expect(missingCandleWindows(existing, 0, 5 * step, step)).toEqual([
      [0, step],
      [3 * step, 4 * step],
      [5 * step, 6 * step],
    ]);
  });

  it('returns no windows when the requested cache is complete', () => {
    expect(missingCandleWindows([0, step, 2 * step], 0, 2 * step, step)).toEqual([]);
  });
});

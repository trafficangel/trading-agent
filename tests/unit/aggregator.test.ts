import { describe, it, expect } from 'vitest';
import { scoreEvent, SCORE_THRESHOLD } from '../../src/signals/weights.js';

describe('scoreEvent', () => {
  it('bullish_plus on 15m gives 4 to bullish', () => {
    const s = scoreEvent('bullish_plus', '15', 'up');
    expect(s.bullish).toBe(4);
    expect(s.bearish).toBe(0);
  });

  it('bullish_plus on 5m is reduced (timing only)', () => {
    const s = scoreEvent('bullish_plus', '5', 'up');
    expect(s.bullish).toBeLessThan(4);
    expect(s.bullish).toBeCloseTo(2.8); // 4 * 0.7
  });

  it('bos_swing_up on 1H is amplified (context)', () => {
    const s = scoreEvent('bos_swing_up', '60', 'up');
    expect(s.bullish).toBe(4.5); // 3 * 1.5
  });

  it('bearish_plus contributes only to bearish', () => {
    const s = scoreEvent('bearish_plus', '15', 'down');
    expect(s.bearish).toBe(4);
    expect(s.bullish).toBe(0);
  });

  it('unknown event returns zeros', () => {
    const s = scoreEvent('unknown_event', '15', 'up');
    expect(s.bullish).toBe(0);
    expect(s.bearish).toBe(0);
  });

  it('SCORE_THRESHOLD is reasonable', () => {
    // 1× bullish_plus on 15m (4) + 1× S-BOS on 15m (3) = 7 → triggers
    // 1× bullish_plus on 5m (2.8) alone → does not trigger
    expect(SCORE_THRESHOLD).toBeGreaterThanOrEqual(5);
    expect(SCORE_THRESHOLD).toBeLessThanOrEqual(8);
  });
});

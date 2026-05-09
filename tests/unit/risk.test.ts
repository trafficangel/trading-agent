import { describe, it, expect } from 'vitest';
import { checkDecision } from '../../src/risk/manager.js';
import type { Decision } from '../../src/llm/decision.schema.js';

const baseOpenLong: Decision = {
  decision: 'OPEN',
  side: 'long',
  entry: 100,
  sl: 98,
  tp: [104, 108],
  size_pct: 1,
  confidence: 0.6,
  reasoning_short: 'test',
  reasoning_full: 'test',
};

describe('checkDecision', () => {
  it('SKIP always passes', () => {
    const d: Decision = { ...baseOpenLong, decision: 'SKIP' };
    expect(checkDecision(d).ok).toBe(true);
  });

  it('valid long passes', () => {
    expect(checkDecision(baseOpenLong).ok).toBe(true);
  });

  it('long with SL above entry fails', () => {
    const r = checkDecision({ ...baseOpenLong, sl: 102 });
    expect(r.ok).toBe(false);
  });

  it('SL too tight fails', () => {
    const r = checkDecision({ ...baseOpenLong, entry: 100, sl: 99.95 });
    expect(r.ok).toBe(false);
  });

  it('SL too wide fails', () => {
    const r = checkDecision({ ...baseOpenLong, entry: 100, sl: 90 });
    expect(r.ok).toBe(false);
  });

  it('TP1 R:R < 1 fails', () => {
    const r = checkDecision({ ...baseOpenLong, entry: 100, sl: 98, tp: [101] });
    expect(r.ok).toBe(false);
  });

  it('size_pct > cap fails', () => {
    const r = checkDecision({ ...baseOpenLong, size_pct: 2.5 });
    expect(r.ok).toBe(false);
  });

  it('short with TP1 above entry fails', () => {
    const r = checkDecision({ ...baseOpenLong, side: 'short', sl: 102, tp: [104] });
    expect(r.ok).toBe(false);
  });
});

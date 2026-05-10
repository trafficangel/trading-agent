import { describe, it, expect } from 'vitest';
import { checkDecision } from '../../src/risk/manager.js';
import type { Decision } from '../../src/llm/decision.schema.js';

const baseOpenLong: Decision = {
  decision: 'OPEN',
  side: 'long',
  entry: 100,
  sl: 98,
  tp: [104], // 4 / 2 = 2 R:R, passes minRR=1.5
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

  it('TP1 R:R < 1.5 fails', () => {
    const r = checkDecision({ ...baseOpenLong, entry: 100, sl: 98, tp: [102] });
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

  it('SL within sane ATR multiple passes', () => {
    // entry 100, sl 98 → SL distance 2. ATR 1 → 2×ATR, well within [0.7, 4.0]
    expect(checkDecision(baseOpenLong, undefined, 1).ok).toBe(true);
  });

  it('SL too tight in ATR multiple fails', () => {
    // SL distance 2, ATR 5 → 0.4×ATR, below 0.7 floor → fails
    const r = checkDecision(baseOpenLong, undefined, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('×ATR');
  });

  it('SL too wide in ATR multiple fails', () => {
    // SL distance 2, ATR 0.4 → 5×ATR, above 4.0 ceiling → fails
    const r = checkDecision(baseOpenLong, undefined, 0.4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('×ATR');
  });

  it('null/undefined ATR skips ATR check', () => {
    expect(checkDecision(baseOpenLong, undefined, null).ok).toBe(true);
    expect(checkDecision(baseOpenLong, undefined, undefined).ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { Decision } from '../../src/llm/decision.schema.js';

describe('Decision schema', () => {
  it('parses a clean OPEN', () => {
    const r = Decision.parse({
      decision: 'OPEN',
      side: 'long',
      entry: 2.45,
      sl: 2.42,
      tp: [2.51],
      size_pct: 1.0,
      confidence: 0.62,
      reasoning_short: 'test short',
      reasoning_full: 'test full',
      sl_reason: 'за свинг-лоу',
      tp_reason: 'до стенки',
      invalidation: 'закрытие выше 2.45',
    });
    expect(r.decision).toBe('OPEN');
    expect(r.entry).toBe(2.45);
    expect(r.tp).toEqual([2.51]);
  });

  it('SKIP with zeroed numeric fields is accepted (real Claude behavior)', () => {
    // Previously rejected by .positive() — broke 2 real SKIP responses.
    const r = Decision.parse({
      decision: 'SKIP',
      side: 'long',
      entry: 0,
      sl: 0,
      tp: [],
      size_pct: 0,
      confidence: 0,
      reasoning_short: 'skip — chop',
      reasoning_full: 'no setup',
      sl_reason: '',
      tp_reason: '',
      invalidation: '',
    });
    expect(r.decision).toBe('SKIP');
    expect(r.entry).toBeUndefined();
    expect(r.sl).toBeUndefined();
    expect(r.size_pct).toBeUndefined();
    expect(r.sl_reason).toBeUndefined();
  });

  it('SKIP with null fields is accepted', () => {
    const r = Decision.parse({
      decision: 'SKIP',
      side: null,
      entry: null,
      sl: null,
      tp: null,
      size_pct: null,
      confidence: null,
      reasoning_short: 'skip',
      reasoning_full: 'skip full',
      sl_reason: null,
      tp_reason: null,
      invalidation: null,
    });
    expect(r.decision).toBe('SKIP');
    expect(r.tp).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it('zero tp values are filtered out', () => {
    const r = Decision.parse({
      decision: 'SKIP',
      tp: [0],
      reasoning_short: 'a',
      reasoning_full: 'b',
    });
    expect(r.tp).toEqual([]);
  });

  it('size_pct > 2 gets clamped to 2', () => {
    const r = Decision.parse({
      decision: 'OPEN',
      side: 'long',
      entry: 100,
      sl: 98,
      tp: [104],
      size_pct: 5,
      confidence: 0.7,
      reasoning_short: 'a',
      reasoning_full: 'b',
    });
    expect(r.size_pct).toBe(2);
  });

  it('entry_type accepted when set, undefined when omitted', () => {
    const withLimit = Decision.parse({
      decision: 'OPEN',
      side: 'long',
      entry: 100,
      sl: 98,
      tp: [104],
      size_pct: 1,
      confidence: 0.6,
      reasoning_short: 'a',
      reasoning_full: 'b',
      entry_type: 'limit',
    });
    expect(withLimit.entry_type).toBe('limit');

    const without = Decision.parse({
      decision: 'OPEN',
      side: 'long',
      entry: 100,
      sl: 98,
      tp: [104],
      size_pct: 1,
      confidence: 0.6,
      reasoning_short: 'a',
      reasoning_full: 'b',
    });
    expect(without.entry_type).toBeUndefined();
  });

  it('invalid entry_type values get rejected silently to undefined', () => {
    // Old model behavior: returning {} or unknown string for entry_type
    // shouldn't crash the parse.
    const r = Decision.parse({
      decision: 'OPEN',
      side: 'long',
      entry: 100,
      sl: 98,
      tp: [104],
      size_pct: 1,
      confidence: 0.6,
      reasoning_short: 'a',
      reasoning_full: 'b',
      entry_type: '',
    });
    expect(r.entry_type).toBeUndefined();
  });
});

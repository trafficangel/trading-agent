import { describe, it, expect } from 'vitest';
import { sizeFromConfidence, SIZING_FLOOR_CONFIDENCE } from '../../src/risk/sizing.js';

describe('sizeFromConfidence', () => {
  it('confidence below floor → SKIP', () => {
    const r = sizeFromConfidence(SIZING_FLOOR_CONFIDENCE - 0.01);
    expect(r.action).toBe('SKIP');
  });

  it('exactly at floor → smallest size tier', () => {
    const r = sizeFromConfidence(SIZING_FLOOR_CONFIDENCE);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(0.5);
  });

  it('mid 0.55 → 0.5% (lowest swing tier after 2026-05-12 floor raise)', () => {
    const r = sizeFromConfidence(0.55);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(0.5);
  });

  it('mid 0.65 → 1.0%', () => {
    const r = sizeFromConfidence(0.65);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.0);
  });

  it('high 0.75 → 1.5%', () => {
    const r = sizeFromConfidence(0.75);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.5);
  });

  it('very high 0.85+ → 2.0%', () => {
    const r = sizeFromConfidence(0.85);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(2.0);
  });

  it('NaN confidence → SKIP', () => {
    expect(sizeFromConfidence(NaN).action).toBe('SKIP');
  });

  it('1.0 confidence → max tier (2%)', () => {
    const r = sizeFromConfidence(1);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(2.0);
  });

  it('borderline 0.45 swing → SKIP (post-2026-05-12 floor 0.50)', () => {
    // This was previously SIZE 0.5% but 4-day backtest showed these
    // borderline trades lost. Floor raised 0.40 → 0.50.
    const r = sizeFromConfidence(0.45);
    expect(r.action).toBe('SKIP');
  });

  it('scalp tier: confidence 0.49 → SKIP (below 0.5 floor)', () => {
    const r = sizeFromConfidence(0.49, 'scalp');
    expect(r.action).toBe('SKIP');
  });

  it('scalp tier: confidence 0.50 → 0.5% (at floor)', () => {
    const r = sizeFromConfidence(0.5, 'scalp');
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(0.5);
  });

  it('scalp tier: confidence 0.65 → 1.0%', () => {
    const r = sizeFromConfidence(0.65, 'scalp');
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.0);
  });

  it('scalp tier: confidence 0.80 → 1.5% (scalp never gets full 2%)', () => {
    const r = sizeFromConfidence(0.8, 'scalp');
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.5);
  });

  it('post-2026-05-12: swing and scalp share 0.50 floor', () => {
    // Both strategies now require ≥0.50 confidence. We unified the floor
    // after the 2026-05-12 backtest review.
    expect(sizeFromConfidence(0.45, 'swing').action).toBe('SKIP');
    expect(sizeFromConfidence(0.45, 'scalp').action).toBe('SKIP');
    expect(sizeFromConfidence(0.50, 'swing').action).toBe('SIZE');
    expect(sizeFromConfidence(0.50, 'scalp').action).toBe('SIZE');
  });
});

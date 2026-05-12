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

  it('mid 0.55 → 1.0%', () => {
    const r = sizeFromConfidence(0.55);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.0);
  });

  it('mid 0.65 → 1.5%', () => {
    const r = sizeFromConfidence(0.65);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.5);
  });

  it('high 0.75+ → 2.0%', () => {
    const r = sizeFromConfidence(0.8);
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

  it('scalp tier: confidence 0.45 = swing-OK but scalp-SKIP', () => {
    // Same confidence, different verdicts depending on strategy.
    expect(sizeFromConfidence(0.45, 'swing').action).toBe('SIZE');
    expect(sizeFromConfidence(0.45, 'scalp').action).toBe('SKIP');
  });
});

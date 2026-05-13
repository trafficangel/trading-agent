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

  it('low-mid 0.50 → 0.5% (lowest tradable swing tier after 2026-05-13 floor)', () => {
    const r = sizeFromConfidence(0.50);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(0.5);
  });

  it('mid 0.60 → 1.0%', () => {
    const r = sizeFromConfidence(0.60);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.0);
  });

  it('high 0.70 → 1.5%', () => {
    const r = sizeFromConfidence(0.70);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(1.5);
  });

  it('very high 0.80+ → 2.0%', () => {
    const r = sizeFromConfidence(0.80);
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

  it('borderline 0.44 swing → SKIP (just below 0.45 floor)', () => {
    const r = sizeFromConfidence(0.44);
    expect(r.action).toBe('SKIP');
  });

  it('borderline 0.45 swing → SIZE 0.5% (exactly at floor)', () => {
    const r = sizeFromConfidence(0.45);
    expect(r.action).toBe('SIZE');
    if (r.action === 'SIZE') expect(r.sizePct).toBe(0.5);
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

  it('post-2026-05-13: swing 0.45 floor, scalp 0.50 floor', () => {
    // After all-SKIP storm we split floors again: swing at 0.45 lets
    // borderline-but-tradable setups through; scalp stays at 0.50
    // because tight R:R = errors hurt more.
    expect(sizeFromConfidence(0.45, 'swing').action).toBe('SIZE');
    expect(sizeFromConfidence(0.45, 'scalp').action).toBe('SKIP');
    expect(sizeFromConfidence(0.50, 'swing').action).toBe('SIZE');
    expect(sizeFromConfidence(0.50, 'scalp').action).toBe('SIZE');
  });
});

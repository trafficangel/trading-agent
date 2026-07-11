import { describe, expect, it } from 'vitest';
import { makerFillIndex, type MakerPrintPoint } from '../../src/lib/hft-maker-fill.js';

const points = (...prints: number[][]): MakerPrintPoint[] => prints.map((hlPrints) => ({ hlPrints }));

describe('conservative maker queue fills', () => {
  it('waits until sells at the bid consume all visible queue ahead', () => {
    const p = points([], [100, -2], [100, -2.9], [100, -0.2]);
    expect(makerFillIndex(p, 1, 3, 1, 100, 5)).toBe(3);
  });

  it('fills a bid immediately when an aggressive sell trades through it', () => {
    const p = points([], [99.9, -0.1]);
    expect(makerFillIndex(p, 1, 1, 1, 100, 50)).toBe(1);
  });

  it('does not fill a bid from aggressive buys or sells above the quote', () => {
    const p = points([], [100, 20, 100.1, -20]);
    expect(makerFillIndex(p, 1, 1, 1, 100, 1)).toBe(-1);
  });

  it('mirrors queue consumption for a resting ask', () => {
    const p = points([], [101, 1.5], [101, 1.6]);
    expect(makerFillIndex(p, 1, 2, -1, 101, 3)).toBe(2);
  });
});

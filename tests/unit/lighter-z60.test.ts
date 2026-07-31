import { describe, expect, it } from 'vitest';
import {
  evaluateVwz60,
  evaluateZ60Reclaim,
  evaluateZ60Touch,
  type Vwz60Bar,
  type Z60Bar,
} from '../../src/lib/lighter-z60.js';

function bars(closes: number[]): Z60Bar[] {
  return closes.map((close, index) => ({ time: index * 300_000, close }));
}

function volumeBars(closes: number[], volumes?: number[]): Vwz60Bar[] {
  return closes.map((close, index) => ({
    time: index * 300_000,
    close,
    volume: volumes?.[index] ?? 1,
  }));
}

describe('evaluateZ60Reclaim', () => {
  it('detects a symmetric long reclaim', () => {
    const baseline = Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Reclaim(bars([...baseline, 90, 99]), 60, 3);
    expect(result?.previousZ).toBeLessThan(-3);
    expect(result?.currentZ).toBeGreaterThanOrEqual(-3);
    expect(result?.signal).toBe('long');
  });

  it('detects a symmetric short reclaim', () => {
    const baseline = Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Reclaim(bars([...baseline, 110, 101]), 60, 3);
    expect(result?.previousZ).toBeGreaterThan(3);
    expect(result?.currentZ).toBeLessThanOrEqual(3);
    expect(result?.signal).toBe('short');
  });

  it('does not turn a continuing excursion into a signal', () => {
    const baseline = Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Reclaim(bars([...baseline, 90, 89]), 60, 3);
    expect(result?.signal).toBeNull();
  });
});

describe('evaluateZ60Touch', () => {
  it('enters long while the completed candle is below the lower band', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Touch(bars([...baseline, 90]), 60, 3);
    expect(result?.currentZ).toBeLessThan(-3);
    expect(result?.signal).toBe('long');
  });

  it('enters short while the completed candle is above the upper band', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Touch(bars([...baseline, 110]), 60, 3);
    expect(result?.currentZ).toBeGreaterThan(3);
    expect(result?.signal).toBe('short');
  });

  it('stays flat inside the three-sigma band', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const result = evaluateZ60Touch(bars([...baseline, 100]), 60, 3);
    expect(result?.signal).toBeNull();
  });

  it('honors a lower two-sigma threshold without changing direction symmetry', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const long = evaluateZ60Touch(bars([...baseline, 94]), 60, 2);
    const short = evaluateZ60Touch(bars([...baseline, 106]), 60, 2);
    expect(long?.currentZ).toBeLessThan(-2);
    expect(long?.signal).toBe('long');
    expect(short?.currentZ).toBeGreaterThan(2);
    expect(short?.signal).toBe('short');
  });
});

describe('evaluateVwz60', () => {
  it('detects symmetric touch signals with completed-bar volume weighting', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const long = evaluateVwz60(volumeBars([...baseline, 90]), 60, 3, 'touch');
    const short = evaluateVwz60(volumeBars([...baseline, 110]), 60, 3, 'touch');
    expect(long?.currentZ).toBeLessThan(-3);
    expect(long?.signal).toBe('long');
    expect(short?.currentZ).toBeGreaterThan(3);
    expect(short?.signal).toBe('short');
  });

  it('uses volume rather than treating every completed bar equally', () => {
    const closes = Array.from({ length: 61 }, (_, index) => index === 59 ? 90 : 100);
    const equal = evaluateVwz60(volumeBars(closes), 60, 3, 'touch');
    const volumes = closes.map((_, index) => index === 59 ? 100 : 1);
    const weighted = evaluateVwz60(volumeBars(closes, volumes), 60, 3, 'touch');
    expect(equal?.mean).not.toBe(weighted?.mean);
    expect(weighted?.mean).toBeLessThan(equal?.mean ?? 0);
  });

  it('rejects a window without usable native volume', () => {
    const closes = Array.from({ length: 61 }, () => 100);
    expect(evaluateVwz60(volumeBars(closes, closes.map(() => 0)), 60, 3, 'touch')).toBeNull();
  });
});

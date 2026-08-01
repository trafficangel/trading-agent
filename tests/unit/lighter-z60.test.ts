import { describe, expect, it } from 'vitest';
import {
  allowsEntryByEfficiency,
  efficiencyRatio,
  evaluateTrendFilteredZ60,
  evaluateTrendStackZ60,
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

describe('efficiencyRatio', () => {
  it('returns one for a fully directional completed-bar path', () => {
    expect(efficiencyRatio(bars([1, 2, 3, 4, 5]), 4)).toBe(1);
  });

  it('returns zero when a noisy path finishes where it started', () => {
    expect(efficiencyRatio(bars([1, 2, 1, 2, 1]), 4)).toBe(0);
  });

  it('refuses an incomplete lookback', () => {
    expect(efficiencyRatio(bars([1, 2, 3]), 3)).toBeNull();
  });
});

describe('allowsEntryByEfficiency', () => {
  it('leaves strategies without a frozen gate unchanged', () => {
    expect(allowsEntryByEfficiency(null)).toBe(true);
    expect(allowsEntryByEfficiency(0.9)).toBe(true);
  });

  it('admits the frozen boundary and rejects directional or missing paths', () => {
    expect(allowsEntryByEfficiency(0.25, 0.25)).toBe(true);
    expect(allowsEntryByEfficiency(0.250001, 0.25)).toBe(false);
    expect(allowsEntryByEfficiency(null, 0.25)).toBe(false);
  });
});

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
    expect(evaluateVwz60(volumeBars(closes, closes.map(() => 0)), 60, 3, 'touch'))
      .toMatchObject({ currentZ: 0, signal: null });
  });

  it('treats a positive-volume flat window as a valid zero-Z no-signal state', () => {
    const closes = Array.from({ length: 61 }, () => 0.17402);
    const result = evaluateVwz60(volumeBars(closes), 60, 3, 'touch');
    expect(result?.currentZ).toBe(0);
    expect(result?.signal).toBeNull();
  });

  it('honors the two-and-a-half-sigma HYPE threshold symmetrically', () => {
    const baseline = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1));
    const long = evaluateVwz60(volumeBars([...baseline, 95]), 60, 2.5, 'touch');
    const short = evaluateVwz60(volumeBars([...baseline, 105]), 60, 2.5, 'touch');
    expect(long?.currentZ).toBeLessThan(-2.5);
    expect(long?.signal).toBe('long');
    expect(short?.currentZ).toBeGreaterThan(2.5);
    expect(short?.signal).toBe('short');
  });
});

describe('evaluateTrendFilteredZ60', () => {
  it('admits symmetric pullbacks that remain on the trend side of EMA200', () => {
    const longHistory = [
      ...Array.from({ length: 180 }, () => 90),
      ...Array.from({ length: 59 }, (_, index) => 120 + (index % 2 ? 0.1 : -0.1)),
      110,
    ];
    const shortHistory = [
      ...Array.from({ length: 180 }, () => 110),
      ...Array.from({ length: 59 }, (_, index) => 80 + (index % 2 ? 0.1 : -0.1)),
      90,
    ];
    const long = evaluateTrendFilteredZ60(bars(longHistory));
    const short = evaluateTrendFilteredZ60(bars(shortHistory));
    expect(long?.currentZ).toBeLessThan(-2.5);
    expect(long?.close).toBeGreaterThan(long?.trendMean ?? Infinity);
    expect(long?.signal).toBe('long');
    expect(short?.currentZ).toBeGreaterThan(2.5);
    expect(short?.close).toBeLessThan(short?.trendMean ?? -Infinity);
    expect(short?.signal).toBe('short');
  });

  it('blocks a statistical excursion on the wrong side of EMA200', () => {
    const closes = [
      ...Array.from({ length: 180 }, () => 120),
      ...Array.from({ length: 59 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1)),
      90,
    ];
    const result = evaluateTrendFilteredZ60(bars(closes));
    expect(result?.currentZ).toBeLessThan(-2.5);
    expect(result?.close).toBeLessThan(result?.trendMean ?? -Infinity);
    expect(result?.signal).toBeNull();
  });
});

describe('evaluateTrendStackZ60', () => {
  it('admits both sides only with aligned EMA200/EMA400 trends', () => {
    const longHistory = [
      ...Array.from({ length: 1_100 }, () => 80),
      ...Array.from({ length: 340 }, () => 100),
      ...Array.from({ length: 59 }, (_, index) => 120 + (index % 2 ? 0.1 : -0.1)),
      110,
    ];
    const shortHistory = [
      ...Array.from({ length: 1_100 }, () => 120),
      ...Array.from({ length: 340 }, () => 100),
      ...Array.from({ length: 59 }, (_, index) => 80 + (index % 2 ? 0.1 : -0.1)),
      90,
    ];
    const long = evaluateTrendStackZ60(bars(longHistory));
    const short = evaluateTrendStackZ60(bars(shortHistory));
    expect(long?.currentZ).toBeLessThan(-2.5);
    expect(long?.close).toBeGreaterThan(long?.trendMean ?? Infinity);
    expect(long?.trendMean).toBeGreaterThan(long?.slowTrendMean ?? Infinity);
    expect(long?.signal).toBe('long');
    expect(short?.currentZ).toBeGreaterThan(2.5);
    expect(short?.close).toBeLessThan(short?.trendMean ?? -Infinity);
    expect(short?.trendMean).toBeLessThan(short?.slowTrendMean ?? -Infinity);
    expect(short?.signal).toBe('short');
  });

  it('blocks a Z excursion when the two trend averages are not aligned', () => {
    const closes = [
      ...Array.from({ length: 1_100 }, () => 120),
      ...Array.from({ length: 399 }, (_, index) => 100 + (index % 2 ? 0.1 : -0.1)),
      90,
    ];
    const result = evaluateTrendStackZ60(bars(closes));
    expect(result?.currentZ).toBeLessThan(-2.5);
    expect(result?.signal).toBeNull();
  });
});

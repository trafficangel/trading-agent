import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateNativeHistoricalEvidence,
  NATIVE_HISTORICAL_REPORT_SHA256,
} from '../../src/lib/lighter-native-historical.js';

describe('frozen Native historical evidence', () => {
  it('accepts only the immutable corrected-cost report', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const evidence = evaluateNativeHistoricalEvidence(source);
    expect(evidence.sourceSha256).toBe(NATIVE_HISTORICAL_REPORT_SHA256);
    expect(evidence.candidates.filter((row) => row.passed).map((row) => row.strategyId))
      .toEqual(['btc-vwz60-touch', 'hype-vwz60-touch']);
    expect(evidence.portfolio.passed).toBe(true);
    expect(evidence.candidates.find((row) => row.strategyId === 'sol-z60-reclaim')?.reasons)
      .toContain('drawdown -19.237% < -15%');
    expect(evidence.candidates.find((row) => row.strategyId === 'bnb-z60-touch')?.reasons)
      .toContain('30d Long -0.126% <= 0%');
  });

  it('rejects a changed frozen result even when headline qualification remains', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as { rows: Array<{ netPct: number }> };
    source.rows[0]!.netPct += 0.001;
    expect(() => evaluateNativeHistoricalEvidence(source)).toThrow('hash mismatch');
  });
});

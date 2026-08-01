import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateNativeHistoricalEvidence,
  NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256,
  NATIVE_HISTORICAL_ZEC_CONFLUENCE_SHA256,
  NATIVE_HISTORICAL_REPORT_SHA256,
  NATIVE_HISTORICAL_RSI_SUPPLEMENT_SHA256,
  NATIVE_HISTORICAL_SUPPLEMENT_SHA256,
  NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256,
  NATIVE_HISTORICAL_DATA_CONFLUENCE_SHA256,
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

  it('admits the immutable XRP transfer report without changing the base artifact', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const evidence = evaluateNativeHistoricalEvidence(source, supplemental);
    expect(evidence.supplementalSourceSha256).toBe(NATIVE_HISTORICAL_SUPPLEMENT_SHA256);
    const xrp = evidence.candidates.find((row) => row.strategyId === 'xrp-vwz60-touch');
    expect(xrp?.passed).toBe(true);
    expect(xrp?.reasons).toEqual([]);
  });

  it('admits the immutable XLM ER60 transfer report as a separate artifact', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const xlmSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-transfer2-validation.json'),
      'utf8',
    )) as unknown;
    const evidence = evaluateNativeHistoricalEvidence(source, supplemental, xlmSupplemental);
    expect(evidence.xlmSupplementalSourceSha256)
      .toBe(NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256);
    const xlm = evidence.candidates.find((row) => row.strategyId === 'xlm-vwz60-touch-er25');
    expect(xlm?.passed).toBe(true);
    expect(xlm?.reasons).toEqual([]);
    expect(xlm?.metrics.recent.every((window) => window.long > 0 && window.short > 0))
      .toBe(true);
  });

  it('admits the independently rebuilt DATA report as a separate artifact', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const xlmSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-transfer2-validation.json'),
      'utf8',
    )) as unknown;
    const dataSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-data-vwz60-1m-rebuild-validation.json'),
      'utf8',
    )) as unknown;
    const evidence = evaluateNativeHistoricalEvidence(
      source,
      supplemental,
      xlmSupplemental,
      dataSupplemental,
    );
    expect(evidence.dataSupplementalSourceSha256)
      .toBe(NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256);
    const data = evidence.candidates.find((row) => row.strategyId === 'data-vwz60-touch');
    expect(data?.passed).toBe(true);
    expect(data?.reasons).toEqual([]);
    expect(data?.metrics.recent.every((window) => window.long > 0 && window.short > 0))
      .toBe(true);
  });

  it('admits the frozen APT and DOT RSI transfer report', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const xlmSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-transfer2-validation.json'),
      'utf8',
    )) as unknown;
    const dataSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-data-vwz60-1m-rebuild-validation.json'),
      'utf8',
    )) as unknown;
    const rsiSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-rsi14-trend-transfer-validation.json'),
      'utf8',
    )) as unknown;
    const evidence = evaluateNativeHistoricalEvidence(
      source,
      supplemental,
      xlmSupplemental,
      dataSupplemental,
      rsiSupplemental,
    );
    expect(evidence.rsiSupplementalSourceSha256)
      .toBe(NATIVE_HISTORICAL_RSI_SUPPLEMENT_SHA256);
    for (const strategyId of [
      'apt-rsi14-pullback-ema400',
      'dot-rsi14-pullback-ema400',
    ]) {
      const candidate = evidence.candidates.find((row) => row.strategyId === strategyId);
      expect(candidate?.passed).toBe(true);
      expect(candidate?.reasons).toEqual([]);
      expect(candidate?.metrics.recent.every((window) =>
        window.long > 0 && window.short > 0)).toBe(true);
    }
  });

  it('admits only the frozen regime-qualified ZEC and DATA confluence reports', () => {
    const paths = [
      'data/lighter-native-current-z60-validation.json',
      'data/lighter-vwz60-holdout-validation.json',
      'data/lighter-vwz60-transfer2-validation.json',
      'data/lighter-data-vwz60-1m-rebuild-validation.json',
      'data/lighter-rsi14-trend-transfer-validation.json',
      'data/lighter-zec-confluence-regime-validation.json',
      'data/lighter-data-confluence-regime-validation.json',
    ];
    const values = paths.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown);
    const evidence = evaluateNativeHistoricalEvidence(
      values[0], values[1], values[2], values[3], values[4], values[5], values[6],
    );
    expect(evidence.zecConfluenceSourceSha256)
      .toBe(NATIVE_HISTORICAL_ZEC_CONFLUENCE_SHA256);
    expect(evidence.dataConfluenceSourceSha256)
      .toBe(NATIVE_HISTORICAL_DATA_CONFLUENCE_SHA256);
    for (const strategyId of [
      'zec-rsi14-willr14-ema400',
      'data-vwz60-mfi14-ema400',
    ]) {
      const candidate = evidence.candidates.find((row) => row.strategyId === strategyId);
      expect(candidate?.passed).toBe(true);
      expect(candidate?.reasons).toEqual([]);
      expect(candidate?.metrics.recent.every((window) =>
        window.long > 0 && window.short > 0)).toBe(true);
    }
  });

  it('rejects a changed frozen result even when headline qualification remains', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as { rows: Array<{ netPct: number }> };
    source.rows[0]!.netPct += 0.001;
    expect(() => evaluateNativeHistoricalEvidence(source)).toThrow('hash mismatch');
  });

  it('rejects a changed supplemental result', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as { rows: Array<{ netPct: number }> };
    supplemental.rows[0]!.netPct += 0.001;
    expect(() => evaluateNativeHistoricalEvidence(source, supplemental))
      .toThrow('supplemental historical evidence hash mismatch');
  });

  it('rejects a changed XLM supplemental result', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const xlmSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-transfer2-validation.json'),
      'utf8',
    )) as { rows: Array<{ netPct: number }> };
    xlmSupplemental.rows[0]!.netPct += 0.001;
    expect(() => evaluateNativeHistoricalEvidence(source, supplemental, xlmSupplemental))
      .toThrow('XLM supplemental historical evidence hash mismatch');
  });

  it('rejects a changed DATA supplemental result', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const xlmSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-transfer2-validation.json'),
      'utf8',
    )) as unknown;
    const dataSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-data-vwz60-1m-rebuild-validation.json'),
      'utf8',
    )) as { rows: Array<{ netPct: number }> };
    dataSupplemental.rows[0]!.netPct += 0.001;
    expect(() => evaluateNativeHistoricalEvidence(
      source,
      supplemental,
      xlmSupplemental,
      dataSupplemental,
    )).toThrow('DATA supplemental historical evidence hash mismatch');
  });

  it('rejects a changed RSI supplemental result', () => {
    const source = JSON.parse(readFileSync(
      resolve('data/lighter-native-current-z60-validation.json'),
      'utf8',
    )) as unknown;
    const supplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-holdout-validation.json'),
      'utf8',
    )) as unknown;
    const xlmSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-vwz60-transfer2-validation.json'),
      'utf8',
    )) as unknown;
    const dataSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-data-vwz60-1m-rebuild-validation.json'),
      'utf8',
    )) as unknown;
    const rsiSupplemental = JSON.parse(readFileSync(
      resolve('data/lighter-rsi14-trend-transfer-validation.json'),
      'utf8',
    )) as { rows: Array<{ netPct: number }> };
    rsiSupplemental.rows[0]!.netPct += 0.001;
    expect(() => evaluateNativeHistoricalEvidence(
      source,
      supplemental,
      xlmSupplemental,
      dataSupplemental,
      rsiSupplemental,
    )).toThrow('RSI supplemental historical evidence hash mismatch');
  });
});

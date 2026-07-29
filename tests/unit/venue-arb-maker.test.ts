import { describe, expect, it } from 'vitest';
import {
  binanceAggTradeTakerSide,
  consumeMakerPrint,
  makerAbortAfterCosts,
  makerEntryEdgeBps,
  makerRoundTripAfterCosts,
  snapMakerPrice,
} from '../../src/lib/venue-arb-maker.js';

describe('venue arb maker shadow math', () => {
  it('maps Binance-style aggregate-trade maker flag to taker side', () => {
    expect(binanceAggTradeTakerSide(true)).toBe('SELL');
    expect(binanceAggTradeTakerSide(false)).toBe('BUY');
  });

  it('snaps floating tick arithmetic to an exchange-valid decimal price', () => {
    expect(snapMakerPrice(46.369, 0.010000000000005116, 'floor')).toBe(46.36);
    expect(snapMakerPrice(46.351, 0.010000000000005116, 'ceil')).toBe(46.36);
    expect(snapMakerPrice(100.26, 0.25, 'floor')).toBe(100.25);
    expect(snapMakerPrice(100.26, 0.25, 'ceil')).toBe(100.5);
  });

  it('does not invent a maker fill before queue and own size trade', () => {
    let state = { queueAhead: 5, remaining: 1, filled: false };
    state = consumeMakerPrint(state, 'buy', 100, 'SELL', 100, 4);
    expect(state).toEqual({ queueAhead: 1, remaining: 1, filled: false });
    state = consumeMakerPrint(state, 'buy', 100, 'SELL', 100, 1.5);
    expect(state).toEqual({ queueAhead: 0, remaining: 0.5, filled: false });
    state = consumeMakerPrint(state, 'buy', 100, 'SELL', 99.9, 0.01);
    expect(state).toEqual({ queueAhead: 0, remaining: 0, filled: true });
  });

  it('requires the aggressive side that can hit the resting quote', () => {
    const initial = { queueAhead: 1, remaining: 1, filled: false };
    expect(consumeMakerPrint(initial, 'sell', 101, 'SELL', 101, 10))
      .toEqual(initial);
    expect(consumeMakerPrint(initial, 'sell', 101, 'BUY', 100.9, 10))
      .toEqual(initial);
    expect(consumeMakerPrint(initial, 'sell', 101, 'BUY', 101.1, 0.01).filled)
      .toBe(true);
  });

  it('calculates locked entry edge for either Extended maker side', () => {
    expect(makerEntryEdgeBps('buy', 100, 100.2)).toBeCloseTo(20);
    expect(makerEntryEdgeBps('sell', 100.2, 100)).toBeCloseTo(20);
  });

  it('calculates a symmetric fully hedged round trip after every cost', () => {
    const common = {
      notionalUsd: 500,
      quantity: 5,
      entryExtended: 100,
      entryLighter: 100.2,
      exitExtended: 100.1,
      exitLighter: 100.1,
      extendedEntryFeeBps: 0,
      extendedExitFeeBps: 0,
      lighterEntryFeeBps: 0,
      lighterExitFeeBps: 0,
      executionBufferBps: 2,
      fundingBps: 0.25,
    };
    const longResult = makerRoundTripAfterCosts({
      ...common,
      extendedSide: 'long',
    });
    expect(longResult.grossUsd).toBeCloseTo(1);
    expect(longResult.netUsd).toBeCloseTo(0.8875);
    const shortResult = makerRoundTripAfterCosts({
      ...common,
      extendedSide: 'short',
      entryExtended: 100.2,
      entryLighter: 100,
    });
    expect(shortResult.netUsd).toBeCloseTo(0.8875);
  });

  it('accounts for the taker fee and buffer when a stale maker fill is aborted', () => {
    const long = makerAbortAfterCosts({
      extendedSide: 'long',
      notionalUsd: 100,
      quantity: 1,
      entryExtended: 100,
      exitExtended: 99.95,
      extendedExitFeeBps: 2.5,
      executionBufferBps: 2,
    });
    expect(long.grossUsd).toBeCloseTo(-0.05);
    expect(long.feesUsd).toBeCloseTo(0.0249875);
    expect(long.netUsd).toBeCloseTo(-0.0949875);
    expect(long.netBps).toBeCloseTo(-9.49875);

    const short = makerAbortAfterCosts({
      extendedSide: 'short',
      notionalUsd: 100,
      quantity: 1,
      entryExtended: 100,
      exitExtended: 100.05,
      extendedExitFeeBps: 2.5,
      executionBufferBps: 2,
    });
    expect(short.netUsd).toBeCloseTo(-0.0950125);
  });
});

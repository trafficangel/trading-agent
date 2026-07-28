import { describe, expect, it } from 'vitest';
import {
  consumeMakerPrint,
  makerEntryEdgeBps,
  makerRoundTripAfterCosts,
} from '../../src/lib/venue-arb-maker.js';

describe('venue arb maker shadow math', () => {
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
});

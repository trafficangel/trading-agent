import { describe, expect, it } from 'vitest';
import {
  executableVwap,
  netConvergenceEdgeBps,
  normalizeExchangeTimestampMs,
  rawCrossEdgeBps,
  roundTripCostBps,
} from '../src/lib/venue-arb.js';

describe('venue arbitrage math', () => {
  it('uses partial depth levels for an executable VWAP', () => {
    const result = executableVwap([[100, 3], [101, 4]], 500);
    expect(result).not.toBeNull();
    expect(result!.notionalUsd).toBeCloseTo(500);
    expect(result!.baseSize).toBeCloseTo(3 + 200 / 101);
    expect(result!.price).toBeCloseTo(500 / (3 + 200 / 101));
  });

  it('rejects a book without enough notional depth', () => {
    expect(executableVwap([[100, 2]], 500)).toBeNull();
  });

  it('calculates directed buy-to-sell spread in basis points', () => {
    expect(rawCrossEdgeBps(100, 100.2)).toBeCloseTo(20);
  });

  it('charges all four legs of a convergence trade', () => {
    expect(roundTripCostBps(0, 4.5, 2)).toBe(11);
    expect(netConvergenceEdgeBps(20, 0, 4.5, 2)).toBe(9);
    expect(roundTripCostBps(5, 5.5, 2)).toBe(23);
  });

  it('normalizes venue timestamps without trusting implausible clocks', () => {
    const receivedAt = 1_785_269_603_837;
    expect(normalizeExchangeTimestampMs(1_785_269_603, receivedAt))
      .toBe(1_785_269_603_000);
    expect(normalizeExchangeTimestampMs(1_785_269_603_496_000, receivedAt))
      .toBe(1_785_269_603_496);
    expect(normalizeExchangeTimestampMs(1_785_269_603_496_000_000, receivedAt))
      .toBe(1_785_269_603_496);
    expect(normalizeExchangeTimestampMs(1, receivedAt)).toBe(receivedAt);
    expect(normalizeExchangeTimestampMs(0, receivedAt)).toBe(receivedAt);
  });
});

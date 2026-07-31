import { describe, expect, it } from 'vitest';
import {
  LighterMinuteAccumulator,
  aggressorSide,
  applyLighterBookUpdate,
  createLighterBookState,
  isUsableMicrostructureMinute,
  lighterBookMetrics,
  resetLighterBookState,
  tradeUsd,
} from '../../src/lib/lighter-microstructure.js';

describe('Lighter order-book continuity', () => {
  it('applies the subscription snapshot and contiguous deltas', () => {
    const book = createLighterBookState();
    expect(
      applyLighterBookUpdate(book, {
        nonce: 100,
        begin_nonce: 90,
        bids: [
          { price: '99', size: '2' },
          { price: '98', size: '3' },
        ],
        asks: [
          { price: '101', size: '4' },
          { price: '102', size: '5' },
        ],
      }),
    ).toBe('applied');
    expect(
      applyLighterBookUpdate(book, {
        nonce: 105,
        begin_nonce: 100,
        bids: [
          { price: '99', size: '0' },
          { price: '100', size: '1' },
        ],
        asks: [{ price: '101', size: '2' }],
      }),
    ).toBe('applied');
    expect(book.nonce).toBe(105);
    expect(book.bids.has(99)).toBe(false);
    expect(book.bids.get(100)).toBe(1);
    expect(book.asks.get(101)).toBe(2);
  });

  it('rejects a nonce gap without mutating the book', () => {
    const book = createLighterBookState();
    applyLighterBookUpdate(book, {
      nonce: 100,
      begin_nonce: 90,
      bids: [{ price: '99', size: '2' }],
      asks: [{ price: '101', size: '2' }],
    });
    expect(
      applyLighterBookUpdate(book, {
        nonce: 110,
        begin_nonce: 101,
        bids: [{ price: '100', size: '5' }],
      }),
    ).toBe('gap');
    expect(book.nonce).toBe(100);
    expect(book.bids.has(100)).toBe(false);
    resetLighterBookState(book);
    expect(book.nonce).toBeNull();
    expect(book.bids.size).toBe(0);
  });
});

describe('Lighter microstructure features', () => {
  it('computes executable spread and top-five quote depth imbalance', () => {
    const book = createLighterBookState();
    applyLighterBookUpdate(book, {
      nonce: 1,
      begin_nonce: 0,
      bids: [
        { price: 99, size: 1 },
        { price: 98, size: 2 },
        { price: 97, size: 3 },
      ],
      asks: [
        { price: 101, size: 1 },
        { price: 102, size: 1 },
        { price: 103, size: 1 },
      ],
    });
    const metrics = lighterBookMetrics(book);
    expect(metrics).not.toBeNull();
    expect(metrics?.mid).toBe(100);
    expect(metrics?.spreadPct).toBe(2);
    expect(metrics?.bid5Usd).toBe(586);
    expect(metrics?.ask5Usd).toBe(306);
    expect(metrics?.depthImbalance).toBeCloseTo(280 / 892, 10);
  });

  it('classifies the taker from the resting maker side', () => {
    expect(aggressorSide({ is_maker_ask: true })).toBe('buy');
    expect(aggressorSide({ is_maker_ask: false })).toBe('sell');
    expect(aggressorSide({})).toBeNull();
    expect(tradeUsd({ usd_amount: '123.45' })).toBe(123.45);
    expect(tradeUsd({ price: '10', size: '2.5' })).toBe(25);
  });

  it('rejects incomplete, stale or gap-affected minutes', () => {
    expect(isUsableMicrostructureMinute({ samples: 60, nonceGaps: 0, staleSamples: 0 }, 60)).toBe(
      true,
    );
    expect(isUsableMicrostructureMinute({ samples: 47, nonceGaps: 0, staleSamples: 0 }, 60)).toBe(
      false,
    );
    expect(isUsableMicrostructureMinute({ samples: 60, nonceGaps: 1, staleSamples: 0 }, 60)).toBe(
      false,
    );
    expect(isUsableMicrostructureMinute({ samples: 60, nonceGaps: 0, staleSamples: 7 }, 60)).toBe(
      false,
    );
  });

  it('creates a complete minute row with quality and flow fields', () => {
    const minute = new LighterMinuteAccumulator(1_000_000);
    minute.noteBookUpdate();
    minute.noteBookUpdate();
    minute.noteNonceGap();
    minute.noteStaleSample();
    minute.sampleBook(
      {
        bid: 99,
        ask: 101,
        mid: 100,
        spreadPct: 2,
        bid5Usd: 600,
        ask5Usd: 400,
        depthImbalance: 0.2,
      },
      10,
    );
    minute.sampleBook(
      {
        bid: 101,
        ask: 103,
        mid: 102,
        spreadPct: 1,
        bid5Usd: 300,
        ask5Usd: 700,
        depthImbalance: -0.4,
      },
      30,
    );
    minute.addTrade({ usd_amount: 50, is_maker_ask: true });
    minute.addTrade({ price: 10, size: 2, is_maker_ask: false });
    minute.addTrade({ usd_amount: 5, is_maker_ask: false }, true);
    minute.updateStats({
      index_price: '100',
      mark_price: '100.2',
      current_funding_rate: '0.001',
      funding_rate: '0.0005',
    });

    const snapshot = minute.snapshot();
    expect(snapshot).toMatchObject({
      minuteTsMs: 1_000_000,
      samples: 2,
      bookUpdates: 2,
      nonceGaps: 1,
      staleSamples: 1,
      midOpen: 100,
      midHigh: 102,
      midLow: 100,
      midClose: 102,
      spreadAvgPct: 1.5,
      spreadMaxPct: 2,
      bid5UsdAvg: 450,
      ask5UsdAvg: 550,
      depthImbalanceAvg: -0.1,
      depthImbalanceClose: -0.4,
      bookAgeAvgMs: 20,
      bookAgeP95Ms: 30,
      buyUsd: 50,
      sellUsd: 20,
      cvdUsd: 30,
      tradeCount: 2,
      liquidationBuyUsd: 0,
      liquidationSellUsd: 5,
      currentFundingRate: 0.001,
      lastFundingRate: 0.0005,
    });
    expect(snapshot.basisPct).toBeCloseTo(0.2, 10);
  });
});

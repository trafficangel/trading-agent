import { describe, expect, it } from 'vitest';
import {
  GenericMakerShadow,
  type GenericMakerConfig,
  type GenericMakerResult,
  type MakerShadowMarket,
} from '../../src/lib/venue-arb-maker-shadow.js';

const config: GenericMakerConfig = {
  routeId: 'grvt-maker-lighter',
  makerVenue: 'grvt',
  hedgeVenue: 'lighter',
  notionalUsd: 100,
  entryEdgeBps: 5,
  cancelEdgeBps: 3,
  postFillNetBps: 3,
  exitNetBps: 1,
  quoteLatencyMs: 0,
  hedgeLatencyMs: 0,
  quoteTtlMs: 60_000,
  maxQueueUsd: 5_000,
  hedgeGraceMs: 1_000,
  maxHoldMs: 60_000,
  independenceMs: 0,
  bookFreshMs: 1_000,
  sourceFreshMs: 1_000,
  executionBufferBps: 1,
  makerFeeBps: -0.01,
  hedgeTakerFeeBps: 0,
  makerFallbackTakerFeeBps: 4.5,
  fundingBpsPerHour: 0,
  requiredSamples: 1,
  requiredPassPct: 100,
};

function market(
  at: number,
  hedgeSell: number,
  hedgeBuy: number,
): MakerShadowMarket {
  return {
    coin: 'BNB',
    maker: {
      bids: new Map([[100, 1]]),
      asks: new Map([[100.1, 1]]),
      exchangeAt: at,
      receivedAt: at,
    },
    hedge: {
      sellVwap: hedgeSell,
      buyVwap: hedgeBuy,
      exchangeAt: at,
      receivedAt: at,
    },
  };
}

describe('GenericMakerShadow', () => {
  it('requires prints through displayed queue and completes a positive cycle', () => {
    const results: GenericMakerResult[] = [];
    const engine = new GenericMakerShadow(config, {
      onResult: (result) => results.push(result),
    });

    engine.evaluate(1_000, [market(1_000, 100.2, 100.3)]);
    engine.evaluate(1_001, [market(1_001, 100.2, 100.3)]);
    engine.processTrade({
      id: 'entry-print',
      coin: 'BNB',
      side: 'SELL',
      price: 100,
      size: 2,
      tradeAt: 1_001,
    }, 1_001);
    engine.evaluate(1_002, [market(1_002, 100.2, 100.3)]);

    const afterEntry = engine.status() as {
      pair?: { coin?: string } | null;
    };
    expect(afterEntry.pair?.coin).toBe('BNB');

    engine.evaluate(1_003, [market(1_003, 100.2, 100)]);
    engine.evaluate(1_004, [market(1_004, 100.2, 100)]);
    engine.processTrade({
      id: 'exit-print',
      coin: 'BNB',
      side: 'BUY',
      price: 100.1,
      size: 2,
      tradeAt: 1_004,
    }, 1_004);
    engine.evaluate(1_005, [market(1_005, 100.2, 100)]);

    expect(results).toHaveLength(1);
    expect(results[0]?.reason).toBe('maker_round_trip');
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.realizedNetBps).toBeGreaterThan(0);
  });

  it('rejects stale snapshot trades instead of inventing a fill', () => {
    const engine = new GenericMakerShadow(config);
    engine.evaluate(2_000, [market(2_000, 100.2, 100.3)]);
    engine.evaluate(2_001, [market(2_001, 100.2, 100.3)]);
    engine.processTrade({
      id: 'stale-print',
      coin: 'BNB',
      side: 'SELL',
      price: 99,
      size: 100,
      tradeAt: 1,
    }, 2_001);
    const status = engine.status() as {
      telemetry: { staleTrades: number; queueFills: number };
      pair?: unknown;
    };
    expect(status.telemetry.staleTrades).toBe(1);
    expect(status.telemetry.queueFills).toBe(0);
    expect(status.pair).toBeNull();
  });

  it('selects a deeper small-queue level instead of a congested best quote', () => {
    const engine = new GenericMakerShadow(config);
    const snapshot: MakerShadowMarket = {
      coin: 'BNB',
      maker: {
        bids: new Map([[99.9, 300]]),
        asks: new Map([
          [100.1, 300],
          [100.2, 1],
        ]),
        exchangeAt: 3_000,
        receivedAt: 3_000,
      },
      hedge: {
        sellVwap: 99,
        buyVwap: 100,
        exchangeAt: 3_000,
        receivedAt: 3_000,
      },
    };
    engine.evaluate(3_000, [snapshot]);
    const status = engine.status() as {
      quote?: { side?: string; price?: number; distanceBps?: number } | null;
    };
    expect(status.quote?.side).toBe('sell');
    expect(status.quote?.price).toBe(100.2);
    expect(status.quote?.distanceBps).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  GenericMakerShadow,
  type GenericMakerConfig,
  type GenericMakerEvent,
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
  takerExitNetBps: 1,
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
  basis?: {
    entry: Partial<Record<'buy' | 'sell', number>>;
    exit: Partial<Record<'buy' | 'sell', number>>;
  },
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
    basisEntryBaselineBps: basis?.entry,
    basisExitBaselineBps: basis?.exit,
  };
}

describe('GenericMakerShadow', () => {
  it('requires recent maker prints when the activity gate is enabled', () => {
    const engine = new GenericMakerShadow({
      ...config,
      maxMakerTradeIdleMs: 1_000,
    });
    const stale = market(1_000, 100.2, 100.3);
    stale.makerLastTradeAt = null;
    engine.evaluate(1_000, [stale]);
    expect((engine.status() as { quote?: unknown }).quote).toBeNull();

    const fresh = market(1_001, 100.2, 100.3);
    fresh.makerLastTradeAt = 1_001;
    engine.evaluate(1_001, [fresh]);
    expect((engine.status() as { quote?: unknown }).quote).toBeTruthy();
  });

  it('requires prints through displayed queue and completes a positive cycle', () => {
    const results: GenericMakerResult[] = [];
    const events: GenericMakerEvent[] = [];
    const engine = new GenericMakerShadow(config, {
      onResult: (result) => results.push(result),
      onEvent: (event) => events.push(event),
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
    expect(results[0]?.reason).toBe('profitable_taker_exit');
    expect(results[0]?.exitMakerOrder).toBe(false);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.realizedNetBps).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'quote_created',
      'quote_activated',
      'queue_filled',
    ]));
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

  it('keeps an active quote through a brief data gap and cancels after grace', () => {
    const events: GenericMakerEvent[] = [];
    const engine = new GenericMakerShadow({
      ...config,
      quoteDataGraceMs: 500,
    }, {
      onEvent: (event) => events.push(event),
    });

    engine.evaluate(2_100, [market(2_100, 100.2, 100.3)]);
    engine.evaluate(2_101, [market(2_101, 100.2, 100.3)]);
    engine.evaluate(3_102, [market(2_101, 100.2, 100.3)]);
    expect((engine.status() as { quote?: unknown }).quote).toBeTruthy();

    engine.evaluate(3_500, [market(2_101, 100.2, 100.3)]);
    expect((engine.status() as { quote?: unknown }).quote).toBeTruthy();

    engine.evaluate(3_603, [market(2_101, 100.2, 100.3)]);
    expect((engine.status() as { quote?: unknown }).quote).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: 'edge_cancelled',
      reason: 'projection_unavailable',
    });
  });

  it('waits through a brief hedge gap while activating a quote', () => {
    const events: GenericMakerEvent[] = [];
    const engine = new GenericMakerShadow({
      ...config,
      quoteLatencyMs: 100,
      quoteDataGraceMs: 500,
    }, {
      onEvent: (event) => events.push(event),
    });

    engine.evaluate(2_200, [market(2_200, 100.2, 100.3)]);
    const missingHedge = market(2_300, 100.2, 100.3);
    missingHedge.hedge = null;
    engine.evaluate(2_300, [missingHedge]);

    const waiting = engine.status() as {
      quote?: { activatedAt?: number | null } | null;
    };
    expect(waiting.quote).toBeTruthy();
    expect(waiting.quote?.activatedAt).toBeNull();
    expect(events.some((event) => (
      event.type === 'placement_rejected'
    ))).toBe(false);

    engine.evaluate(2_500, [market(2_500, 100.2, 100.3)]);
    const activated = engine.status() as {
      quote?: { activatedAt?: number | null } | null;
    };
    expect(activated.quote?.activatedAt).toBe(2_500);
    expect(events.at(-1)?.type).toBe('quote_activated');
  });

  it('journals queue progress before a maker order fills', () => {
    const events: GenericMakerEvent[] = [];
    const engine = new GenericMakerShadow(config, {
      onEvent: (event) => events.push(event),
    });

    engine.evaluate(2_500, [market(2_500, 100.2, 100.3)]);
    engine.evaluate(2_501, [market(2_501, 100.2, 100.3)]);
    engine.processTrade({
      id: 'queue-progress-print',
      coin: 'BNB',
      side: 'SELL',
      price: 100,
      size: 0.5,
      tradeAt: 2_501,
    }, 2_501);

    const progress = events.find((event) => event.type === 'queue_progress');
    expect(progress).toMatchObject({
      queueAheadBeforeUsd: 100,
      queueAheadUsd: 50,
      remainingBeforeUsd: 100,
      remainingUsd: 100,
      consumedUsd: 50,
    });
    const status = engine.status() as {
      telemetry: { queueProgressEvents: number; queueFills: number };
    };
    expect(status.telemetry.queueProgressEvents).toBe(1);
    expect(status.telemetry.queueFills).toBe(0);
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

  it('prefers the most aggressive quote that still clears the net gate', () => {
    const engine = new GenericMakerShadow({
      ...config,
      entryEdgeBps: 1,
    });
    const snapshot: MakerShadowMarket = {
      coin: 'BNB',
      maker: {
        bids: new Map([
          [100, 0.1],
          [99.99, 0.1],
        ]),
        asks: new Map([
          [100.1, 0.1],
          [100.11, 0.1],
        ]),
        exchangeAt: 3_100,
        receivedAt: 3_100,
      },
      hedge: {
        sellVwap: 100.05,
        buyVwap: 100.2,
        exchangeAt: 3_100,
        receivedAt: 3_100,
      },
    };

    engine.evaluate(3_100, [snapshot]);

    const status = engine.status() as {
      quote?: {
        side?: string;
        price?: number;
        touchDistanceBps?: number;
      } | null;
    };
    expect(status.quote?.side).toBe('buy');
    expect(status.quote?.price).toBe(100.03);
    expect(status.quote?.touchDistanceBps).toBeLessThan(10);
  });

  it('forces a taker exit at max hold even while an exit quote is open', () => {
    const engine = new GenericMakerShadow({
      ...config,
      maxHoldMs: 10,
      takerExitNetBps: 1_000,
    });
    engine.restore([], {
      pair: {
        id: 'restored-pair',
        coin: 'BNB',
        makerSide: 'short',
        openedAt: 100,
        quantity: 1,
        entryMaker: 100.1,
        entryHedge: 100,
        entryEdgeBps: 10,
      },
      pendingHedge: null,
      cooldownUntil: 0,
    });

    engine.evaluate(100, [market(100, 100, 100)]);
    expect((engine.status() as { quote?: unknown }).quote).toBeTruthy();

    engine.evaluate(111, [market(111, 100, 100)]);
    const status = engine.status() as {
      quote?: unknown;
      pendingHedge?: { stage?: string; makerOrder?: boolean } | null;
    };
    expect(status.quote).toBeNull();
    expect(status.pendingHedge).toMatchObject({
      stage: 'exit',
      makerOrder: false,
    });
  });

  it('locks a profitable taker exit instead of waiting for a second maker fill', () => {
    const engine = new GenericMakerShadow({
      ...config,
      takerExitNetBps: 1,
    });
    engine.restore([], {
      pair: {
        id: 'profitable-pair',
        coin: 'BNB',
        makerSide: 'short',
        openedAt: 100,
        quantity: 1,
        entryMaker: 100.2,
        entryHedge: 100,
        entryEdgeBps: 20,
      },
      pendingHedge: null,
      cooldownUntil: 0,
    });

    engine.evaluate(101, [market(101, 100, 100)]);
    const status = engine.status() as {
      quote?: unknown;
      pendingHedge?: {
        stage?: string;
        makerOrder?: boolean;
        projectedNetBpsAtFill?: number;
      } | null;
    };
    expect(status.quote).toBeNull();
    expect(status.pendingHedge).toMatchObject({
      stage: 'exit',
      makerOrder: false,
    });
    expect(
      status.pendingHedge?.projectedNetBpsAtFill,
    ).toBeGreaterThanOrEqual(1);
  });

  it('quotes only a basis deviation that remains positive after four fills', () => {
    const basisConfig: GenericMakerConfig = {
      ...config,
      entryEdgeBps: 2,
      cancelEdgeBps: 1,
      postFillNetBps: 1,
      basisGateEnabled: true,
      basisMinDeviationBps: 5,
    };
    const staticEngine = new GenericMakerShadow(basisConfig);
    staticEngine.evaluate(4_000, [
      market(4_000, 100.2, 100.3, {
        entry: { buy: 20 },
        exit: { buy: -10 },
      }),
    ]);
    const staticStatus = staticEngine.status() as {
      quote?: unknown;
      telemetry?: {
        bestObservedTopDeviationBps?: number | null;
      };
    };
    expect(staticStatus.quote).toBeNull();
    expect(
      staticStatus.telemetry?.bestObservedTopDeviationBps,
    ).toBeLessThan(5);

    const dislocatedEngine = new GenericMakerShadow(basisConfig);
    dislocatedEngine.evaluate(4_001, [
      market(4_001, 100.2, 100.3, {
        entry: { buy: 10 },
        exit: { buy: -10 },
      }),
    ]);
    const quote = (dislocatedEngine.status() as {
      quote?: { side?: string; projectedNetBps?: number } | null;
      telemetry?: {
        bestObservedTopDeviationBps?: number | null;
      };
    }).quote;
    expect(quote?.side).toBe('buy');
    expect(quote?.projectedNetBps).toBeGreaterThanOrEqual(2);
  });

  it('does not manufacture a basis deviation by quoting far from top of book', () => {
    const engine = new GenericMakerShadow({
      ...config,
      entryEdgeBps: 2,
      cancelEdgeBps: 1,
      postFillNetBps: 1,
      basisGateEnabled: true,
      basisMinDeviationBps: 5,
      maxEntryDistanceBps: 25,
    });
    const snapshot = market(5_000, 100.2, 100.3, {
      entry: { buy: 20 },
      exit: { buy: -10 },
    });
    snapshot.maker!.bids.set(99.8, 0.1);
    engine.evaluate(5_000, [snapshot]);
    expect((engine.status() as { quote?: unknown }).quote).toBeNull();
  });
});

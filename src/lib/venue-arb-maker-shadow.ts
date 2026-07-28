import {
  consumeMakerPrint,
  makerEntryEdgeBps,
  makerRoundTripAfterCosts,
  snapMakerPrice,
  type MakerQueueState,
  type MakerSide,
  type TakerSide,
} from './venue-arb-maker.js';
import { executableVwap } from './venue-arb.js';

export type MakerShadowRawBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  exchangeAt: number;
  receivedAt: number;
};

export type MakerShadowHedgeBook = {
  buyVwap: number | null;
  sellVwap: number | null;
  exchangeAt: number;
  receivedAt: number;
};

export type MakerShadowMarket = {
  coin: string;
  maker: MakerShadowRawBook | null;
  hedge: MakerShadowHedgeBook | null;
};

export type MakerShadowTrade = {
  id: string;
  coin: string;
  side: TakerSide;
  price: number;
  size: number;
  tradeAt: number;
};

export type GenericMakerQuote = {
  id: string;
  coin: string;
  stage: 'entry' | 'exit';
  side: MakerSide;
  price: number;
  createdAt: number;
  activeAt: number;
  activatedAt: number | null;
  expiresAt: number;
  projectedNetBps: number;
  distanceBps: number;
  initialQuantity: number;
  firstFillAt: number | null;
  queue: MakerQueueState;
};

export type GenericMakerPair = {
  id: string;
  coin: string;
  makerSide: 'long' | 'short';
  openedAt: number;
  quantity: number;
  entryMaker: number;
  entryHedge: number;
  entryEdgeBps: number;
};

export type GenericMakerPendingHedge = {
  stage: 'entry' | 'exit';
  coin: string;
  side: MakerSide;
  makerFill: number;
  filledAt: number;
  dueAt: number;
  deadlineAt: number;
  makerOrder: boolean;
};

export type GenericMakerResult = {
  id: string;
  routeId: string;
  coin: string;
  makerSide: 'long' | 'short' | null;
  openedAt: number | null;
  closedAt: number;
  holdingMs: number | null;
  entryMaker: number | null;
  entryHedge: number | null;
  exitMaker: number | null;
  exitHedge: number | null;
  entryEdgeBps: number | null;
  realizedNetBps: number | null;
  realizedNetUsd: number | null;
  exitMakerOrder: boolean | null;
  passed: boolean;
  reason: string;
  fundingBps: number;
};

export type GenericMakerTelemetry = {
  tradeStreamConnected: boolean;
  tradeReconnects: number;
  trades: number;
  staleTrades: number;
  quotes: number;
  placementRejects: number;
  placementStaleRejects: number;
  placementCrossRejects: number;
  placementQueueRejects: number;
  placementEdgeRejects: number;
  edgeCancellations: number;
  quoteExpirations: number;
  queueFills: number;
  hedgeTimeouts: number;
  lastTradeAt: number | null;
  lastQuoteAt: number | null;
  bestProjectedEntryBps: number | null;
  bestProjectedCoin: string | null;
};

export type GenericMakerCheckpoint = {
  pair: GenericMakerPair | null;
  pendingHedge: GenericMakerPendingHedge | null;
  cooldownUntil: number;
};

export type GenericMakerConfig = {
  routeId: string;
  makerVenue: string;
  hedgeVenue: string;
  notionalUsd: number;
  entryEdgeBps: number;
  cancelEdgeBps: number;
  postFillNetBps: number;
  exitNetBps: number;
  quoteLatencyMs: number;
  hedgeLatencyMs: number;
  quoteTtlMs: number;
  maxQueueUsd: number;
  hedgeGraceMs: number;
  maxHoldMs: number;
  independenceMs: number;
  bookFreshMs: number;
  sourceFreshMs: number;
  executionBufferBps: number;
  makerFeeBps: number;
  hedgeTakerFeeBps: number;
  makerFallbackTakerFeeBps: number;
  fundingBpsPerHour: number;
  requiredSamples: number;
  requiredPassPct: number;
};

type GenericMakerHooks = {
  onResult?: (result: GenericMakerResult) => void;
  onCheckpoint?: (checkpoint: GenericMakerCheckpoint) => void;
};

function sortedLevels(
  book: MakerShadowRawBook,
  side: 'bids' | 'asks',
  limit = 20,
): Array<[number, number]> {
  return [...book[side].entries()]
    .filter(([price, size]) => price > 0 && size > 0)
    .sort((a, b) => side === 'bids' ? b[0] - a[0] : a[0] - b[0])
    .slice(0, limit);
}

function priceTick(book: MakerShadowRawBook): number | null {
  const prices = [
    ...sortedLevels(book, 'bids').map(([price]) => price),
    ...sortedLevels(book, 'asks').map(([price]) => price),
  ].sort((a, b) => a - b);
  let tick = Infinity;
  for (let index = 1; index < prices.length; index++) {
    const difference = prices[index]! - prices[index - 1]!;
    if (difference > 1e-10) tick = Math.min(tick, difference);
  }
  return Number.isFinite(tick) && tick > 0
    ? Number(tick.toPrecision(10))
    : null;
}

export class GenericMakerShadow {
  readonly config: GenericMakerConfig;

  readonly telemetry: GenericMakerTelemetry = {
    tradeStreamConnected: false,
    tradeReconnects: 0,
    trades: 0,
    staleTrades: 0,
    quotes: 0,
    placementRejects: 0,
    placementStaleRejects: 0,
    placementCrossRejects: 0,
    placementQueueRejects: 0,
    placementEdgeRejects: 0,
    edgeCancellations: 0,
    quoteExpirations: 0,
    queueFills: 0,
    hedgeTimeouts: 0,
    lastTradeAt: null,
    lastQuoteAt: null,
    bestProjectedEntryBps: null,
    bestProjectedCoin: null,
  };

  private readonly hooks: GenericMakerHooks;

  private results: GenericMakerResult[] = [];

  private quote: GenericMakerQuote | null = null;

  private pair: GenericMakerPair | null = null;

  private pendingHedge: GenericMakerPendingHedge | null = null;

  private cooldownUntil = 0;

  private readonly tradeIds = new Set<string>();

  private latestMarkets = new Map<string, MakerShadowMarket>();

  constructor(config: GenericMakerConfig, hooks: GenericMakerHooks = {}) {
    this.config = config;
    this.hooks = hooks;
  }

  restore(
    results: GenericMakerResult[],
    checkpoint?: Partial<GenericMakerCheckpoint> | null,
  ): void {
    this.results = results.slice(-5_000);
    const latestClosedAt = this.results.reduce(
      (latest, row) => Math.max(latest, Number(row.closedAt ?? 0)),
      0,
    );
    this.cooldownUntil = Math.max(
      latestClosedAt + this.config.independenceMs,
      Number(checkpoint?.cooldownUntil ?? 0),
    );
    if (
      checkpoint?.pair?.id
      && checkpoint.pair.coin
      && checkpoint.pair.quantity > 0
    ) this.pair = checkpoint.pair;
    if (
      checkpoint?.pendingHedge?.coin
      && checkpoint.pendingHedge.makerFill > 0
    ) this.pendingHedge = checkpoint.pendingHedge;
  }

  setTradeStreamConnected(connected: boolean): void {
    this.telemetry.tradeStreamConnected = connected;
    if (!connected && this.quote) {
      this.telemetry.placementRejects++;
      this.telemetry.placementStaleRejects++;
      this.quote = null;
    }
  }

  recordTradeReconnect(): void {
    this.telemetry.tradeReconnects++;
  }

  private fresh(
    now: number,
    maker?: MakerShadowRawBook | null,
    hedge?: MakerShadowHedgeBook | null,
  ): boolean {
    return (
      (!maker || (
        now - maker.receivedAt <= this.config.bookFreshMs
        && now - maker.exchangeAt <= this.config.sourceFreshMs
      ))
      && (!hedge || (
        now - hedge.receivedAt <= this.config.bookFreshMs
        && now - hedge.exchangeAt <= this.config.sourceFreshMs
      ))
    );
  }

  private hedgePrice(
    side: MakerSide,
    hedge: MakerShadowHedgeBook,
  ): number | null {
    return side === 'buy' ? hedge.sellVwap : hedge.buyVwap;
  }

  private entryProjection(
    side: MakerSide,
    makerFill: number,
    hedgeFill: number,
  ): number {
    return makerEntryEdgeBps(side, makerFill, hedgeFill)
      - this.config.executionBufferBps
      - this.config.makerFeeBps
      - this.config.hedgeTakerFeeBps;
  }

  private entryLevels(
    maker: MakerShadowRawBook,
    side: MakerSide,
    hedgeFill: number,
  ): Array<{
    price: number;
    queueAhead: number;
    distanceBps: number;
  }> {
    const bestBid = sortedLevels(maker, 'bids', 1)[0]?.[0];
    const bestAsk = sortedLevels(maker, 'asks', 1)[0]?.[0];
    const tick = priceTick(maker);
    if (bestBid == null || bestAsk == null || tick == null) return [];
    const requiredRawBps = this.config.entryEdgeBps
      + this.config.executionBufferBps
      + this.config.makerFeeBps
      + this.config.hedgeTakerFeeBps;
    let syntheticPrice: number;
    if (side === 'buy') {
      const maximum = hedgeFill / (1 + requiredRawBps / 10_000);
      syntheticPrice = Math.max(
        bestBid,
        snapMakerPrice(Math.min(bestAsk - tick, maximum), tick, 'floor'),
      );
    } else {
      const minimum = hedgeFill * (1 + requiredRawBps / 10_000);
      syntheticPrice = Math.min(
        bestAsk,
        snapMakerPrice(Math.max(bestBid + tick, minimum), tick, 'ceil'),
      );
    }
    const displayed = sortedLevels(
      maker,
      side === 'buy' ? 'bids' : 'asks',
      20,
    ).map(([price]) => price);
    const prices = [...new Set([syntheticPrice, ...displayed])]
      .filter((price) => (
        price > 0
        && (side === 'buy' ? price < bestAsk : price > bestBid)
        && this.entryProjection(side, price, hedgeFill)
          >= this.config.entryEdgeBps - 1e-8
      ));
    return prices.flatMap((price) => {
      const queueAhead = (
        side === 'buy' ? maker.bids : maker.asks
      ).get(price) ?? 0;
      if (queueAhead * price > this.config.maxQueueUsd) return [];
      const distanceBps = side === 'buy'
        ? Math.max(0, (bestBid / price - 1) * 10_000)
        : Math.max(0, (price / bestAsk - 1) * 10_000);
      return [{ price, queueAhead, distanceBps }];
    });
  }

  private closeProjection(
    now: number,
    pair: GenericMakerPair,
    makerFill: number,
    hedgeFill: number,
    makerOrder = true,
  ): number {
    const fundingBps = Math.max(0, now - pair.openedAt)
      / 3_600_000 * this.config.fundingBpsPerHour;
    return makerRoundTripAfterCosts({
      extendedSide: pair.makerSide,
      notionalUsd: this.config.notionalUsd,
      quantity: pair.quantity,
      entryExtended: pair.entryMaker,
      entryLighter: pair.entryHedge,
      exitExtended: makerFill,
      exitLighter: hedgeFill,
      extendedEntryFeeBps: this.config.makerFeeBps,
      extendedExitFeeBps: makerOrder
        ? this.config.makerFeeBps
        : this.config.makerFallbackTakerFeeBps,
      lighterEntryFeeBps: this.config.hedgeTakerFeeBps,
      lighterExitFeeBps: this.config.hedgeTakerFeeBps,
      executionBufferBps: this.config.executionBufferBps,
      fundingBps,
    }).netBps;
  }

  private entryCandidate(now: number): GenericMakerQuote | null {
    const candidates: GenericMakerQuote[] = [];
    this.telemetry.bestProjectedEntryBps = null;
    this.telemetry.bestProjectedCoin = null;
    for (const market of this.latestMarkets.values()) {
      if (!market.maker || !market.hedge) continue;
      if (!this.fresh(now, market.maker, market.hedge)) continue;
      for (const side of ['buy', 'sell'] as const) {
        const hedgeFill = this.hedgePrice(side, market.hedge);
        if (hedgeFill == null) continue;
        const displayedPrice = sortedLevels(
          market.maker,
          side === 'buy' ? 'bids' : 'asks',
          1,
        )[0]?.[0];
        if (displayedPrice != null) {
          const displayedProjection = this.entryProjection(
            side,
            displayedPrice,
            hedgeFill,
          );
          if (
            this.telemetry.bestProjectedEntryBps == null
            || displayedProjection > this.telemetry.bestProjectedEntryBps
          ) {
            this.telemetry.bestProjectedEntryBps = displayedProjection;
            this.telemetry.bestProjectedCoin = market.coin;
          }
        }
        for (const level of this.entryLevels(
          market.maker,
          side,
          hedgeFill,
        )) {
          const projectedNetBps = this.entryProjection(
            side,
            level.price,
            hedgeFill,
          );
          const quantity = this.config.notionalUsd / level.price;
          candidates.push({
            id: `GMQ${now}-${market.coin}-entry-${side}-${level.price}`,
            coin: market.coin,
            stage: 'entry',
            side,
            price: level.price,
            createdAt: now,
            activeAt: now + this.config.quoteLatencyMs,
            activatedAt: null,
            expiresAt: now + this.config.quoteLatencyMs
              + this.config.quoteTtlMs,
            projectedNetBps,
            distanceBps: level.distanceBps,
            initialQuantity: quantity,
            firstFillAt: null,
            queue: {
              queueAhead: level.queueAhead,
              remaining: quantity,
              filled: false,
            },
          });
        }
      }
    }
    const score = (candidate: GenericMakerQuote): number => (
      candidate.projectedNetBps / (
        1
        + candidate.queue.queueAhead * candidate.price
          / this.config.notionalUsd
        + candidate.distanceBps * 2
      )
    );
    return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  private exitCandidate(now: number): GenericMakerQuote | null {
    const pair = this.pair;
    if (!pair) return null;
    const market = this.latestMarkets.get(pair.coin);
    if (!market?.maker || !market.hedge) return null;
    if (!this.fresh(now, market.maker, market.hedge)) return null;
    const side: MakerSide = pair.makerSide === 'long' ? 'sell' : 'buy';
    const hedgeFill = this.hedgePrice(side, market.hedge);
    const bestBid = sortedLevels(market.maker, 'bids', 1)[0]?.[0];
    const bestAsk = sortedLevels(market.maker, 'asks', 1)[0]?.[0];
    if (hedgeFill == null || bestBid == null || bestAsk == null) return null;
    const levels = sortedLevels(
      market.maker,
      side === 'buy' ? 'bids' : 'asks',
      20,
    ).flatMap(([price, queueAhead]) => {
      const projectedNetBps = this.closeProjection(
        now,
        pair,
        price,
        hedgeFill,
      );
      if (projectedNetBps < this.config.exitNetBps) return [];
      const distanceBps = side === 'buy'
        ? Math.max(0, (bestBid / price - 1) * 10_000)
        : Math.max(0, (price / bestAsk - 1) * 10_000);
      const score = projectedNetBps / (
        1
        + queueAhead * price / this.config.notionalUsd
        + distanceBps * 2
      );
      return [{
        price,
        queueAhead,
        projectedNetBps,
        distanceBps,
        score,
      }];
    }).sort((a, b) => b.score - a.score);
    const selected = levels[0];
    if (!selected) return null;
    return {
      id: `GMQ${now}-${pair.coin}-exit-${side}`,
      coin: pair.coin,
      stage: 'exit',
      side,
      price: selected.price,
      createdAt: now,
      activeAt: now + this.config.quoteLatencyMs,
      activatedAt: null,
      expiresAt: now + this.config.quoteLatencyMs + this.config.quoteTtlMs,
      projectedNetBps: selected.projectedNetBps,
      distanceBps: selected.distanceBps,
      initialQuantity: pair.quantity,
      firstFillAt: null,
      queue: {
        queueAhead: selected.queueAhead,
        remaining: pair.quantity,
        filled: false,
      },
    };
  }

  private candidate(now: number): GenericMakerQuote | null {
    if (this.pendingHedge) return null;
    if (this.pair) return this.exitCandidate(now);
    if (now < this.cooldownUntil) return null;
    return this.entryCandidate(now);
  }

  private currentProjection(
    now: number,
    quote: GenericMakerQuote,
  ): number | null {
    const market = this.latestMarkets.get(quote.coin);
    if (!market?.hedge || !this.fresh(now, null, market.hedge)) return null;
    const hedgeFill = this.hedgePrice(quote.side, market.hedge);
    if (hedgeFill == null) return null;
    if (quote.stage === 'entry') {
      return this.entryProjection(quote.side, quote.price, hedgeFill);
    }
    if (!this.pair || this.pair.coin !== quote.coin) return null;
    return this.closeProjection(now, this.pair, quote.price, hedgeFill);
  }

  private activate(now: number): void {
    const quote = this.quote;
    if (!quote || quote.activatedAt != null || now < quote.activeAt) return;
    const market = this.latestMarkets.get(quote.coin);
    if (!market?.maker || !this.fresh(now, market.maker)) {
      this.telemetry.placementRejects++;
      this.telemetry.placementStaleRejects++;
      this.quote = null;
      return;
    }
    const bestOpposite = sortedLevels(
      market.maker,
      quote.side === 'buy' ? 'asks' : 'bids',
      1,
    )[0]?.[0];
    const wouldCross = bestOpposite != null && (
      quote.side === 'buy'
        ? quote.price >= bestOpposite
        : quote.price <= bestOpposite
    );
    if (wouldCross) {
      this.telemetry.placementRejects++;
      this.telemetry.placementCrossRejects++;
      this.quote = null;
      return;
    }
    const sameSide = quote.side === 'buy'
      ? market.maker.bids
      : market.maker.asks;
    quote.queue = {
      queueAhead: sameSide.get(quote.price) ?? 0,
      remaining: quote.queue.remaining,
      filled: false,
    };
    if (
      quote.stage === 'entry'
      && quote.queue.queueAhead * quote.price > this.config.maxQueueUsd
    ) {
      this.telemetry.placementRejects++;
      this.telemetry.placementQueueRejects++;
      this.quote = null;
      return;
    }
    const projection = this.currentProjection(now, quote);
    const minimum = quote.stage === 'entry'
      ? this.config.cancelEdgeBps
      : this.config.exitNetBps;
    if (projection == null || projection < minimum) {
      this.telemetry.placementRejects++;
      this.telemetry.placementEdgeRejects++;
      this.quote = null;
      return;
    }
    quote.activatedAt = now;
  }

  private checkpoint(): void {
    this.hooks.onCheckpoint?.({
      pair: this.pair,
      pendingHedge: this.pendingHedge,
      cooldownUntil: this.cooldownUntil,
    });
  }

  private append(result: GenericMakerResult): void {
    this.results.push(result);
    if (this.results.length > 5_000) this.results = this.results.slice(-5_000);
    this.hooks.onResult?.(result);
  }

  private reset(now: number): void {
    this.pendingHedge = null;
    this.pair = null;
    this.quote = null;
    this.cooldownUntil = now + this.config.independenceMs;
    this.checkpoint();
  }

  private failPending(
    pending: GenericMakerPendingHedge,
    now: number,
    reason: string,
  ): void {
    this.append({
      id: this.pair?.id ?? `GM${pending.filledAt}-${pending.coin}`,
      routeId: this.config.routeId,
      coin: pending.coin,
      makerSide: this.pair?.makerSide
        ?? (pending.side === 'buy' ? 'long' : 'short'),
      openedAt: this.pair?.openedAt
        ?? (pending.stage === 'entry' ? pending.filledAt : null),
      closedAt: now,
      holdingMs: this.pair
        ? Math.max(0, now - this.pair.openedAt)
        : pending.stage === 'entry'
          ? Math.max(0, now - pending.filledAt)
          : null,
      entryMaker: this.pair?.entryMaker
        ?? (pending.stage === 'entry' ? pending.makerFill : null),
      entryHedge: this.pair?.entryHedge ?? null,
      exitMaker: pending.stage === 'exit' ? pending.makerFill : null,
      exitHedge: null,
      entryEdgeBps: this.pair?.entryEdgeBps ?? null,
      realizedNetBps: null,
      realizedNetUsd: null,
      exitMakerOrder: pending.stage === 'exit' ? pending.makerOrder : null,
      passed: false,
      reason,
      fundingBps: 0,
    });
    this.telemetry.hedgeTimeouts++;
    this.reset(now);
  }

  private abortAfterLostEdge(
    pending: GenericMakerPendingHedge,
    now: number,
    market: MakerShadowMarket,
  ): boolean {
    if (!market.maker) return false;
    const makerLevels = pending.side === 'buy'
      ? sortedLevels(market.maker, 'bids')
      : sortedLevels(market.maker, 'asks');
    const exit = executableVwap(makerLevels, this.config.notionalUsd)?.price;
    if (exit == null) return false;
    const makerSide = pending.side === 'buy' ? 'long' : 'short';
    const quantity = this.config.notionalUsd / pending.makerFill;
    const grossUsd = (
      makerSide === 'long'
        ? exit - pending.makerFill
        : pending.makerFill - exit
    ) * quantity;
    const feesUsd = quantity * (
      pending.makerFill * this.config.makerFeeBps
      + exit * this.config.makerFallbackTakerFeeBps
    ) / 10_000;
    const bufferUsd = this.config.notionalUsd
      * this.config.executionBufferBps / 10_000;
    const netUsd = grossUsd - feesUsd - bufferUsd;
    const entryEdgeBps = makerEntryEdgeBps(
      pending.side,
      pending.makerFill,
      this.hedgePrice(pending.side, market.hedge!)!,
    );
    this.append({
      id: `GM${pending.filledAt}-${pending.coin}-${makerSide}`,
      routeId: this.config.routeId,
      coin: pending.coin,
      makerSide,
      openedAt: pending.filledAt,
      closedAt: now,
      holdingMs: Math.max(0, now - pending.filledAt),
      entryMaker: pending.makerFill,
      entryHedge: null,
      exitMaker: exit,
      exitHedge: null,
      entryEdgeBps,
      realizedNetBps: netUsd / this.config.notionalUsd * 10_000,
      realizedNetUsd: netUsd,
      exitMakerOrder: false,
      passed: netUsd > 0,
      reason: 'post_fill_edge_lost',
      fundingBps: 0,
    });
    this.reset(now);
    return true;
  }

  private evaluatePending(now: number): void {
    const pending = this.pendingHedge;
    if (!pending || now < pending.dueAt) return;
    if (now > pending.deadlineAt) {
      this.failPending(pending, now, `${pending.stage}_hedge_timeout`);
      return;
    }
    const market = this.latestMarkets.get(pending.coin);
    if (!market?.hedge || !this.fresh(now, market.maker, market.hedge)) return;
    const hedgeFill = this.hedgePrice(pending.side, market.hedge);
    if (hedgeFill == null) return;
    if (pending.stage === 'entry') {
      const makerSide = pending.side === 'buy' ? 'long' : 'short';
      const entryEdgeBps = makerEntryEdgeBps(
        pending.side,
        pending.makerFill,
        hedgeFill,
      );
      if (
        this.entryProjection(pending.side, pending.makerFill, hedgeFill)
        < this.config.postFillNetBps
      ) {
        this.abortAfterLostEdge(pending, now, market);
        return;
      }
      this.pair = {
        id: `GM${pending.filledAt}-${pending.coin}-${makerSide}`,
        coin: pending.coin,
        makerSide,
        openedAt: now,
        quantity: this.config.notionalUsd / pending.makerFill,
        entryMaker: pending.makerFill,
        entryHedge: hedgeFill,
        entryEdgeBps,
      };
      this.pendingHedge = null;
      this.checkpoint();
      return;
    }
    const pair = this.pair;
    if (!pair) {
      this.failPending(pending, now, 'exit_without_pair');
      return;
    }
    const fundingBps = Math.max(0, now - pair.openedAt)
      / 3_600_000 * this.config.fundingBpsPerHour;
    const modeled = makerRoundTripAfterCosts({
      extendedSide: pair.makerSide,
      notionalUsd: this.config.notionalUsd,
      quantity: pair.quantity,
      entryExtended: pair.entryMaker,
      entryLighter: pair.entryHedge,
      exitExtended: pending.makerFill,
      exitLighter: hedgeFill,
      extendedEntryFeeBps: this.config.makerFeeBps,
      extendedExitFeeBps: pending.makerOrder
        ? this.config.makerFeeBps
        : this.config.makerFallbackTakerFeeBps,
      lighterEntryFeeBps: this.config.hedgeTakerFeeBps,
      lighterExitFeeBps: this.config.hedgeTakerFeeBps,
      executionBufferBps: this.config.executionBufferBps,
      fundingBps,
    });
    this.append({
      id: pair.id,
      routeId: this.config.routeId,
      coin: pair.coin,
      makerSide: pair.makerSide,
      openedAt: pair.openedAt,
      closedAt: now,
      holdingMs: Math.max(0, now - pair.openedAt),
      entryMaker: pair.entryMaker,
      entryHedge: pair.entryHedge,
      exitMaker: pending.makerFill,
      exitHedge: hedgeFill,
      entryEdgeBps: pair.entryEdgeBps,
      realizedNetBps: modeled.netBps,
      realizedNetUsd: modeled.netUsd,
      exitMakerOrder: pending.makerOrder,
      passed: modeled.netBps > 0,
      reason: pending.makerOrder ? 'maker_round_trip' : 'max_hold_taker_exit',
      fundingBps,
    });
    this.reset(now);
  }

  evaluate(now: number, markets: MakerShadowMarket[]): void {
    this.latestMarkets = new Map(markets.map((market) => [market.coin, market]));
    this.evaluatePending(now);
    if (this.pendingHedge) return;
    if (
      this.pair
      && now - this.pair.openedAt >= this.config.maxHoldMs
      && !this.quote
    ) {
      const market = this.latestMarkets.get(this.pair.coin);
      if (market?.maker && market.hedge && this.fresh(now, market.maker, market.hedge)) {
        const side: MakerSide = this.pair.makerSide === 'long' ? 'sell' : 'buy';
        const levels = side === 'sell'
          ? sortedLevels(market.maker, 'bids')
          : sortedLevels(market.maker, 'asks');
        const makerFill = executableVwap(
          levels,
          this.config.notionalUsd,
        )?.price;
        if (makerFill != null) {
          this.pendingHedge = {
            stage: 'exit',
            coin: this.pair.coin,
            side,
            makerFill,
            filledAt: now,
            dueAt: now + this.config.hedgeLatencyMs,
            deadlineAt: now + this.config.hedgeLatencyMs
              + this.config.hedgeGraceMs,
            makerOrder: false,
          };
          this.checkpoint();
        }
      }
      return;
    }
    this.activate(now);
    if (this.quote?.activatedAt != null && this.quote.firstFillAt == null) {
      const projection = this.currentProjection(now, this.quote);
      const minimum = this.quote.stage === 'entry'
        ? this.config.cancelEdgeBps
        : this.config.exitNetBps;
      if (projection == null || projection < minimum) {
        this.telemetry.edgeCancellations++;
        this.quote = null;
      }
    }
    if (this.quote && now >= this.quote.expiresAt) {
      if (
        this.quote.firstFillAt != null
        && this.quote.queue.remaining < this.quote.initialQuantity
      ) {
        this.append({
          id: this.pair?.id ?? `GM${this.quote.firstFillAt}-${this.quote.coin}`,
          routeId: this.config.routeId,
          coin: this.quote.coin,
          makerSide: this.pair?.makerSide
            ?? (this.quote.side === 'buy' ? 'long' : 'short'),
          openedAt: this.pair?.openedAt ?? null,
          closedAt: now,
          holdingMs: this.pair
            ? Math.max(0, now - this.pair.openedAt)
            : null,
          entryMaker: this.pair?.entryMaker
            ?? (this.quote.stage === 'entry' ? this.quote.price : null),
          entryHedge: this.pair?.entryHedge ?? null,
          exitMaker: this.quote.stage === 'exit' ? this.quote.price : null,
          exitHedge: null,
          entryEdgeBps: this.pair?.entryEdgeBps ?? null,
          realizedNetBps: null,
          realizedNetUsd: null,
          exitMakerOrder: this.quote.stage === 'exit' ? true : null,
          passed: false,
          reason: `${this.quote.stage}_partial_fill_unhedged`,
          fundingBps: 0,
        });
        this.reset(now);
        return;
      }
      this.telemetry.quoteExpirations++;
      this.quote = null;
    }
    if (!this.quote) {
      this.quote = this.candidate(now);
      if (this.quote) {
        this.telemetry.quotes++;
        this.telemetry.lastQuoteAt = now;
      }
    }
  }

  processTrade(trade: MakerShadowTrade, receivedAt: number): void {
    if (this.tradeIds.has(trade.id)) return;
    this.tradeIds.add(trade.id);
    if (this.tradeIds.size > 50_000) this.tradeIds.clear();
    this.telemetry.trades++;
    this.telemetry.lastTradeAt = receivedAt;
    if (
      receivedAt - trade.tradeAt > this.config.sourceFreshMs
      || trade.tradeAt - receivedAt > 1_000
    ) {
      this.telemetry.staleTrades++;
      return;
    }
    const quote = this.quote;
    if (
      !quote
      || quote.coin !== trade.coin
      || quote.activatedAt == null
      || receivedAt < quote.activatedAt
      || receivedAt >= quote.expiresAt
    ) return;
    const previousRemaining = quote.queue.remaining;
    quote.queue = consumeMakerPrint(
      quote.queue,
      quote.side,
      quote.price,
      trade.side,
      trade.price,
      trade.size,
    );
    if (
      quote.firstFillAt == null
      && quote.queue.remaining < previousRemaining
    ) quote.firstFillAt = receivedAt;
    if (!quote.queue.filled) return;
    this.telemetry.queueFills++;
    this.pendingHedge = {
      stage: quote.stage,
      coin: quote.coin,
      side: quote.side,
      makerFill: quote.price,
      filledAt: quote.firstFillAt ?? receivedAt,
      dueAt: (quote.firstFillAt ?? receivedAt) + this.config.hedgeLatencyMs,
      deadlineAt: (quote.firstFillAt ?? receivedAt)
        + this.config.hedgeLatencyMs + this.config.hedgeGraceMs,
      makerOrder: true,
    };
    this.quote = null;
    this.checkpoint();
  }

  shutdown(now: number): void {
    if (
      this.quote?.firstFillAt != null
      && this.quote.queue.remaining < this.quote.initialQuantity
    ) {
      this.append({
        id: this.pair?.id ?? `GM${this.quote.firstFillAt}-${this.quote.coin}`,
        routeId: this.config.routeId,
        coin: this.quote.coin,
        makerSide: this.pair?.makerSide
          ?? (this.quote.side === 'buy' ? 'long' : 'short'),
        openedAt: this.pair?.openedAt ?? null,
        closedAt: now,
        holdingMs: this.pair ? Math.max(0, now - this.pair.openedAt) : null,
        entryMaker: this.pair?.entryMaker
          ?? (this.quote.stage === 'entry' ? this.quote.price : null),
        entryHedge: this.pair?.entryHedge ?? null,
        exitMaker: this.quote.stage === 'exit' ? this.quote.price : null,
        exitHedge: null,
        entryEdgeBps: this.pair?.entryEdgeBps ?? null,
        realizedNetBps: null,
        realizedNetUsd: null,
        exitMakerOrder: this.quote.stage === 'exit' ? true : null,
        passed: false,
        reason: `${this.quote.stage}_partial_fill_unhedged_at_shutdown`,
        fundingBps: 0,
      });
      this.reset(now);
      return;
    }
    this.quote = null;
    this.checkpoint();
  }

  status(): Record<string, unknown> {
    const completed = this.results.filter((row) => row.realizedNetBps != null);
    const passed = this.results.filter((row) => row.passed).length;
    const passedPct = this.results.length
      ? passed / this.results.length * 100
      : null;
    const netBps = completed.map((row) => Number(row.realizedNetBps));
    const sumNetBps = netBps.reduce((sum, value) => sum + value, 0);
    return {
      version: 'generic-maker-shadow-v1',
      routeId: this.config.routeId,
      config: this.config,
      readiness: {
        attempts: this.results.length,
        samples: completed.length,
        passed,
        passedPct,
        requiredSamples: this.config.requiredSamples,
        requiredPassPct: this.config.requiredPassPct,
        ready: completed.length >= this.config.requiredSamples
          && passedPct != null
          && passedPct >= this.config.requiredPassPct
          && sumNetBps > 0,
        sumNetBps,
        sumNetUsd: completed.reduce(
          (sum, row) => sum + Number(row.realizedNetUsd ?? 0),
          0,
        ),
        minNetBps: netBps.length ? Math.min(...netBps) : null,
        meanNetBps: netBps.length
          ? netBps.reduce((sum, value) => sum + value, 0) / netBps.length
          : null,
      },
      telemetry: this.telemetry,
      quote: this.quote,
      pair: this.pair,
      pendingHedge: this.pendingHedge,
      cooldownUntil: this.cooldownUntil,
      recent: this.results.slice(-20).reverse(),
    };
  }
}

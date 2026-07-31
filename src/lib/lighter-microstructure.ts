export type LighterLevel = { price: string | number; size: string | number };

export type LighterBookUpdate = {
  bids?: LighterLevel[];
  asks?: LighterLevel[];
  nonce?: string | number;
  begin_nonce?: string | number;
};

export type LighterTrade = {
  trade_id?: string | number;
  trade_id_str?: string;
  price?: string | number;
  size?: string | number;
  usd_amount?: string | number;
  is_maker_ask?: boolean;
};

export type LighterBookState = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  nonce: number | null;
};

export type BookMetrics = {
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
  bid5Usd: number;
  ask5Usd: number;
  depthImbalance: number;
};

export type MinuteMicrostructure = {
  minuteTsMs: number;
  samples: number;
  bookUpdates: number;
  nonceGaps: number;
  staleSamples: number;
  midOpen: number | null;
  midHigh: number | null;
  midLow: number | null;
  midClose: number | null;
  spreadAvgPct: number | null;
  spreadMaxPct: number | null;
  bid5UsdAvg: number | null;
  ask5UsdAvg: number | null;
  depthImbalanceAvg: number | null;
  depthImbalanceClose: number | null;
  bookAgeAvgMs: number | null;
  bookAgeP95Ms: number | null;
  buyUsd: number;
  sellUsd: number;
  cvdUsd: number;
  tradeCount: number;
  liquidationBuyUsd: number;
  liquidationSellUsd: number;
  indexPrice: number | null;
  markPrice: number | null;
  basisPct: number | null;
  currentFundingRate: number | null;
  lastFundingRate: number | null;
};

export function isUsableMicrostructureMinute(
  row: Pick<MinuteMicrostructure, 'samples' | 'nonceGaps' | 'staleSamples'>,
  expectedSamples: number,
): boolean {
  return (
    expectedSamples > 0 &&
    row.samples >= expectedSamples * 0.8 &&
    row.nonceGaps === 0 &&
    row.staleSamples <= expectedSamples * 0.1
  );
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function updateSide(target: Map<number, number>, rows: LighterLevel[] | undefined): void {
  for (const row of rows ?? []) {
    const price = finite(row.price);
    const size = finite(row.size);
    if (price == null || !(price > 0) || size == null || size < 0) continue;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

export function createLighterBookState(): LighterBookState {
  return { bids: new Map(), asks: new Map(), nonce: null };
}

export function resetLighterBookState(state: LighterBookState): void {
  state.bids.clear();
  state.asks.clear();
  state.nonce = null;
}

export function applyLighterBookUpdate(
  state: LighterBookState,
  update: LighterBookUpdate,
): 'applied' | 'gap' | 'invalid' {
  const nonce = finite(update.nonce);
  const beginNonce = finite(update.begin_nonce);
  if (nonce == null || beginNonce == null) return 'invalid';
  if (state.nonce != null && beginNonce !== state.nonce) return 'gap';

  updateSide(state.bids, update.bids);
  updateSide(state.asks, update.asks);
  state.nonce = nonce;
  return 'applied';
}

function topNotional(levels: Map<number, number>, descending: boolean, count: number): number {
  const top: Array<[number, number]> = [];
  for (const level of levels) {
    top.push(level);
    top.sort((left, right) => (descending ? right[0] - left[0] : left[0] - right[0]));
    if (top.length > count) top.pop();
  }
  return top.reduce((sum, [price, size]) => sum + price * size, 0);
}

export function lighterBookMetrics(state: LighterBookState): BookMetrics | null {
  if (!state.bids.size || !state.asks.size) return null;
  let bid = Number.NEGATIVE_INFINITY;
  let ask = Number.POSITIVE_INFINITY;
  for (const price of state.bids.keys()) bid = Math.max(bid, price);
  for (const price of state.asks.keys()) ask = Math.min(ask, price);
  if (!(bid > 0) || !(ask > bid)) return null;
  const mid = (bid + ask) / 2;
  const bid5Usd = topNotional(state.bids, true, 5);
  const ask5Usd = topNotional(state.asks, false, 5);
  const depth = bid5Usd + ask5Usd;
  return {
    bid,
    ask,
    mid,
    spreadPct: ((ask - bid) / mid) * 100,
    bid5Usd,
    ask5Usd,
    depthImbalance: depth > 0 ? (bid5Usd - ask5Usd) / depth : 0,
  };
}

export function tradeUsd(trade: LighterTrade): number | null {
  const direct = finite(trade.usd_amount);
  if (direct != null && direct >= 0) return direct;
  const price = finite(trade.price);
  const size = finite(trade.size);
  if (price == null || size == null || price < 0 || size < 0) return null;
  return price * size;
}

/** If the ask rests as maker, the taker is the aggressive buyer; otherwise seller. */
export function aggressorSide(trade: LighterTrade): 'buy' | 'sell' | null {
  if (typeof trade.is_maker_ask !== 'boolean') return null;
  return trade.is_maker_ask ? 'buy' : 'sell';
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

export class LighterMinuteAccumulator {
  readonly minuteTsMs: number;
  samples = 0;
  bookUpdates = 0;
  nonceGaps = 0;
  staleSamples = 0;
  private midOpen: number | null = null;
  private midHigh: number | null = null;
  private midLow: number | null = null;
  private midClose: number | null = null;
  private spreadSum = 0;
  private spreadMax: number | null = null;
  private bid5UsdSum = 0;
  private ask5UsdSum = 0;
  private depthImbalanceSum = 0;
  private depthImbalanceClose: number | null = null;
  private readonly bookAgesMs: number[] = [];
  private buyUsd = 0;
  private sellUsd = 0;
  private tradeCount = 0;
  private liquidationBuyUsd = 0;
  private liquidationSellUsd = 0;
  private indexPrice: number | null = null;
  private markPrice: number | null = null;
  private currentFundingRate: number | null = null;
  private lastFundingRate: number | null = null;

  constructor(minuteTsMs: number) {
    this.minuteTsMs = minuteTsMs;
  }

  noteBookUpdate(): void {
    this.bookUpdates++;
  }

  noteNonceGap(): void {
    this.nonceGaps++;
  }

  noteStaleSample(): void {
    this.staleSamples++;
  }

  sampleBook(metrics: BookMetrics, ageMs: number): void {
    this.samples++;
    this.midOpen ??= metrics.mid;
    this.midClose = metrics.mid;
    this.midHigh = this.midHigh == null ? metrics.mid : Math.max(this.midHigh, metrics.mid);
    this.midLow = this.midLow == null ? metrics.mid : Math.min(this.midLow, metrics.mid);
    this.spreadSum += metrics.spreadPct;
    this.spreadMax =
      this.spreadMax == null ? metrics.spreadPct : Math.max(this.spreadMax, metrics.spreadPct);
    this.bid5UsdSum += metrics.bid5Usd;
    this.ask5UsdSum += metrics.ask5Usd;
    this.depthImbalanceSum += metrics.depthImbalance;
    this.depthImbalanceClose = metrics.depthImbalance;
    this.bookAgesMs.push(Math.max(0, ageMs));
  }

  addTrade(trade: LighterTrade, liquidation = false): boolean {
    const usd = tradeUsd(trade);
    const side = aggressorSide(trade);
    if (usd == null || side == null) return false;
    if (liquidation) {
      if (side === 'buy') this.liquidationBuyUsd += usd;
      else this.liquidationSellUsd += usd;
    } else {
      if (side === 'buy') this.buyUsd += usd;
      else this.sellUsd += usd;
      this.tradeCount++;
    }
    return true;
  }

  updateStats(stats: Record<string, unknown>): void {
    this.indexPrice = finite(stats.index_price) ?? this.indexPrice;
    this.markPrice = finite(stats.mark_price) ?? this.markPrice;
    this.currentFundingRate = finite(stats.current_funding_rate) ?? this.currentFundingRate;
    this.lastFundingRate = finite(stats.funding_rate) ?? this.lastFundingRate;
  }

  snapshot(): MinuteMicrostructure {
    const divisor = this.samples || 1;
    const bookAgeAvgMs = this.bookAgesMs.length
      ? this.bookAgesMs.reduce((sum, value) => sum + value, 0) / this.bookAgesMs.length
      : null;
    const basisPct =
      this.indexPrice != null && this.markPrice != null && this.indexPrice > 0
        ? ((this.markPrice - this.indexPrice) / this.indexPrice) * 100
        : null;
    return {
      minuteTsMs: this.minuteTsMs,
      samples: this.samples,
      bookUpdates: this.bookUpdates,
      nonceGaps: this.nonceGaps,
      staleSamples: this.staleSamples,
      midOpen: this.midOpen,
      midHigh: this.midHigh,
      midLow: this.midLow,
      midClose: this.midClose,
      spreadAvgPct: this.samples ? this.spreadSum / divisor : null,
      spreadMaxPct: this.spreadMax,
      bid5UsdAvg: this.samples ? this.bid5UsdSum / divisor : null,
      ask5UsdAvg: this.samples ? this.ask5UsdSum / divisor : null,
      depthImbalanceAvg: this.samples ? this.depthImbalanceSum / divisor : null,
      depthImbalanceClose: this.depthImbalanceClose,
      bookAgeAvgMs,
      bookAgeP95Ms: percentile(this.bookAgesMs, 0.95),
      buyUsd: this.buyUsd,
      sellUsd: this.sellUsd,
      cvdUsd: this.buyUsd - this.sellUsd,
      tradeCount: this.tradeCount,
      liquidationBuyUsd: this.liquidationBuyUsd,
      liquidationSellUsd: this.liquidationSellUsd,
      indexPrice: this.indexPrice,
      markPrice: this.markPrice,
      basisPct,
      currentFundingRate: this.currentFundingRate,
      lastFundingRate: this.lastFundingRate,
    };
  }
}

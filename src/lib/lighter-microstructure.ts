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
  timestamp?: string | number;
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
  executableBuyVwap100: number | null;
  executableSellVwap100: number | null;
  executableRoundTrip100Pct: number | null;
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
  execCost100Samples: number;
  execCost100AvgPct: number | null;
  execCost100P95Pct: number | null;
  execCost100MaxPct: number | null;
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

export type StoredMicrostructureMinute = MinuteMicrostructure & {
  marketId: number;
  symbol: string;
  qualityOk: boolean;
};

export type MicrostructureFiveMinute = MinuteMicrostructure & {
  marketId: number;
  symbol: string;
  sourceMinutes: 5;
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

function weightedAverage(
  rows: StoredMicrostructureMinute[],
  field: keyof Pick<
    MinuteMicrostructure,
    'spreadAvgPct' | 'bid5UsdAvg' | 'ask5UsdAvg' | 'depthImbalanceAvg' | 'bookAgeAvgMs'
  >,
): number | null {
  let weighted = 0;
  let samples = 0;
  for (const row of rows) {
    const value = row[field];
    if (value == null || row.samples <= 0) continue;
    weighted += value * row.samples;
    samples += row.samples;
  }
  return samples ? weighted / samples : null;
}

function maximum(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value != null);
  return finiteValues.length ? Math.max(...finiteValues) : null;
}

function minimum(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value != null);
  return finiteValues.length ? Math.min(...finiteValues) : null;
}

/**
 * Builds a 5m feature row only from five aligned, consecutive, quality-approved
 * 1m rows. Invalid or missing input returns null; nothing is forward-filled.
 */
export function rollupLighterMicrostructureFiveMinute(
  source: StoredMicrostructureMinute[],
): MicrostructureFiveMinute | null {
  if (source.length !== 5) return null;
  const rows = [...source].sort((left, right) => left.minuteTsMs - right.minuteTsMs);
  const first = rows[0];
  const last = rows[4];
  if (!first || !last || first.minuteTsMs % (5 * 60_000) !== 0) return null;
  if (
    rows.some(
      (row, index) =>
        row.marketId !== first.marketId ||
        row.symbol !== first.symbol ||
        !row.qualityOk ||
        row.minuteTsMs !== first.minuteTsMs + index * 60_000,
    )
  )
    return null;

  return {
    marketId: first.marketId,
    symbol: first.symbol,
    sourceMinutes: 5,
    minuteTsMs: first.minuteTsMs,
    samples: rows.reduce((sum, row) => sum + row.samples, 0),
    bookUpdates: rows.reduce((sum, row) => sum + row.bookUpdates, 0),
    nonceGaps: rows.reduce((sum, row) => sum + row.nonceGaps, 0),
    staleSamples: rows.reduce((sum, row) => sum + row.staleSamples, 0),
    midOpen: first.midOpen,
    midHigh: maximum(rows.map((row) => row.midHigh)),
    midLow: minimum(rows.map((row) => row.midLow)),
    midClose: last.midClose,
    spreadAvgPct: weightedAverage(rows, 'spreadAvgPct'),
    spreadMaxPct: maximum(rows.map((row) => row.spreadMaxPct)),
    bid5UsdAvg: weightedAverage(rows, 'bid5UsdAvg'),
    ask5UsdAvg: weightedAverage(rows, 'ask5UsdAvg'),
    depthImbalanceAvg: weightedAverage(rows, 'depthImbalanceAvg'),
    depthImbalanceClose: last.depthImbalanceClose,
    bookAgeAvgMs: weightedAverage(rows, 'bookAgeAvgMs'),
    bookAgeP95Ms: maximum(rows.map((row) => row.bookAgeP95Ms)),
    execCost100Samples: rows.reduce((sum, row) => sum + row.execCost100Samples, 0),
    execCost100AvgPct: (() => {
      let weighted = 0;
      let samples = 0;
      for (const row of rows) {
        if (row.execCost100AvgPct == null || row.execCost100Samples <= 0) continue;
        weighted += row.execCost100AvgPct * row.execCost100Samples;
        samples += row.execCost100Samples;
      }
      return samples ? weighted / samples : null;
    })(),
    // A five-minute signal may only know the five completed source minutes.
    // Their largest minute p95 is a conservative causal reserve for entry.
    execCost100P95Pct: maximum(rows.map((row) => row.execCost100P95Pct)),
    execCost100MaxPct: maximum(rows.map((row) => row.execCost100MaxPct)),
    buyUsd: rows.reduce((sum, row) => sum + row.buyUsd, 0),
    sellUsd: rows.reduce((sum, row) => sum + row.sellUsd, 0),
    cvdUsd: rows.reduce((sum, row) => sum + row.cvdUsd, 0),
    tradeCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
    liquidationBuyUsd: rows.reduce((sum, row) => sum + row.liquidationBuyUsd, 0),
    liquidationSellUsd: rows.reduce((sum, row) => sum + row.liquidationSellUsd, 0),
    indexPrice: last.indexPrice,
    markPrice: last.markPrice,
    basisPct: last.basisPct,
    currentFundingRate: last.currentFundingRate,
    lastFundingRate: last.lastFundingRate,
  };
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

/**
 * Subscription snapshots contain older trades. Admit only exchange-stamped
 * events from the active accumulator minute so reconnects cannot replay
 * history into a new causal bar.
 */
export function lighterTradeBelongsToMinute(
  trade: LighterTrade,
  minuteTsMs: number,
): boolean {
  const timestampMs = finite(trade.timestamp);
  return timestampMs != null
    && timestampMs >= minuteTsMs
    && timestampMs < minuteTsMs + 60_000;
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

function executableVwap(
  levels: Map<number, number>,
  ascending: boolean,
  quoteNotional: number,
): number | null {
  const ordered = [...levels.entries()].sort((left, right) =>
    ascending ? left[0] - right[0] : right[0] - left[0]);
  let remaining = quoteNotional;
  let base = 0;
  let quote = 0;
  for (const [price, size] of ordered) {
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, remaining / price);
    base += take;
    quote += take * price;
    remaining -= take * price;
    if (remaining <= 1e-8) return base > 0 ? quote / base : null;
  }
  return null;
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
  const executableBuyVwap100 = executableVwap(state.asks, true, 100);
  const executableSellVwap100 = executableVwap(state.bids, false, 100);
  return {
    bid,
    ask,
    mid,
    spreadPct: ((ask - bid) / mid) * 100,
    bid5Usd,
    ask5Usd,
    depthImbalance: depth > 0 ? (bid5Usd - ask5Usd) / depth : 0,
    executableBuyVwap100,
    executableSellVwap100,
    executableRoundTrip100Pct:
      executableBuyVwap100 != null && executableSellVwap100 != null
        ? ((executableBuyVwap100 - executableSellVwap100) / mid) * 100
        : null,
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
  private readonly execCosts100Pct: number[] = [];
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
    if (metrics.executableRoundTrip100Pct != null) {
      this.execCosts100Pct.push(metrics.executableRoundTrip100Pct);
    }
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
      execCost100Samples: this.execCosts100Pct.length,
      execCost100AvgPct: this.execCosts100Pct.length
        ? this.execCosts100Pct.reduce((sum, value) => sum + value, 0)
          / this.execCosts100Pct.length
        : null,
      execCost100P95Pct: percentile(this.execCosts100Pct, 0.95),
      execCost100MaxPct: this.execCosts100Pct.length
        ? Math.max(...this.execCosts100Pct)
        : null,
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

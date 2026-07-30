export type MakerSide = 'buy' | 'sell';
export type TakerSide = 'BUY' | 'SELL';

export type MakerQueueState = {
  queueAhead: number;
  remaining: number;
  filled: boolean;
};

export function binanceAggTradeTakerSide(
  buyerIsMaker: boolean,
): TakerSide {
  return buyerIsMaker ? 'SELL' : 'BUY';
}

export function makerActivityTimestamp(
  tradeAt: number,
  receivedAt: number,
  maxSourceAgeMs: number,
): number | null {
  if (
    !Number.isFinite(tradeAt)
    || !Number.isFinite(receivedAt)
    || !Number.isFinite(maxSourceAgeMs)
    || maxSourceAgeMs < 0
    || tradeAt > receivedAt + 1_000
    || receivedAt - tradeAt > maxSourceAgeMs
  ) return null;
  return tradeAt;
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const [coefficient = '', exponentText] = text.split('e');
  const exponent = exponentText == null ? 0 : Number(exponentText);
  const fractionLength = coefficient.split('.')[1]?.length ?? 0;
  return Math.max(0, fractionLength - exponent);
}

export function snapMakerPrice(
  value: number,
  tick: number,
  mode: 'floor' | 'ceil',
): number {
  if (!(value > 0) || !(tick > 0)) return Number.NaN;
  const normalizedTick = Number(tick.toPrecision(10));
  const scaled = value / normalizedTick;
  const units = mode === 'floor'
    ? Math.floor(scaled + 1e-9)
    : Math.ceil(scaled - 1e-9);
  const decimals = Math.min(12, decimalPlaces(normalizedTick));
  return Number((units * normalizedTick).toFixed(decimals));
}

export function makerQueueAtPrice(
  levels: ReadonlyMap<number, number>,
  price: number,
  tick?: number | null,
): number {
  if (!(price > 0)) return 0;
  const floatingTolerance = Math.abs(price) * Number.EPSILON * 16;
  const tolerance = tick != null && tick > 0
    ? Math.max(tick * 1e-6, floatingTolerance)
    : floatingTolerance;
  let queueAhead = 0;
  for (const [levelPrice, size] of levels) {
    if (
      Math.abs(levelPrice - price) <= tolerance
      && Number.isFinite(size)
      && size > 0
    ) queueAhead += size;
  }
  return queueAhead;
}

export function consumeMakerPrint(
  state: MakerQueueState,
  makerSide: MakerSide,
  quotePrice: number,
  takerSide: TakerSide,
  tradePrice: number,
  tradeSize: number,
): MakerQueueState {
  if (
    state.filled
    || !(quotePrice > 0)
    || !(tradePrice > 0)
    || !(tradeSize > 0)
  ) return state;
  const relevant = makerSide === 'buy'
    ? takerSide === 'SELL' && tradePrice <= quotePrice
    : takerSide === 'BUY' && tradePrice >= quotePrice;
  if (!relevant) return state;
  // A print through our simulated price does not prove that the market would
  // also have absorbed our additional order. Consume only publicly observed
  // volume so large shadow orders cannot be "filled" by a tiny through-print.
  // Consecutive prints from the same aggressor still accumulate naturally.
  let available = tradeSize;
  const queueConsumed = Math.min(state.queueAhead, available);
  const queueAhead = state.queueAhead - queueConsumed;
  available -= queueConsumed;
  const remaining = Math.max(0, state.remaining - available);
  return {
    queueAhead,
    remaining,
    filled: remaining <= 1e-12,
  };
}

export function makerEntryEdgeBps(
  makerSide: MakerSide,
  extendedFill: number,
  lighterHedge: number,
): number {
  if (!(extendedFill > 0) || !(lighterHedge > 0)) return Number.NaN;
  return makerSide === 'buy'
    ? (lighterHedge / extendedFill - 1) * 10_000
    : (extendedFill / lighterHedge - 1) * 10_000;
}

export type MakerRoundTripInput = {
  extendedSide: 'long' | 'short';
  notionalUsd: number;
  quantity: number;
  entryExtended: number;
  entryLighter: number;
  exitExtended: number;
  exitLighter: number;
  extendedEntryFeeBps: number;
  extendedExitFeeBps: number;
  lighterEntryFeeBps: number;
  lighterExitFeeBps: number;
  executionBufferBps: number;
  fundingBps: number;
};

export function makerRoundTripAfterCosts(input: MakerRoundTripInput): {
  grossUsd: number;
  feesUsd: number;
  executionBufferUsd: number;
  fundingUsd: number;
  netUsd: number;
  netBps: number;
} {
  const grossPerUnit = input.extendedSide === 'long'
    ? (input.exitExtended - input.entryExtended)
      + (input.entryLighter - input.exitLighter)
    : (input.entryExtended - input.exitExtended)
      + (input.exitLighter - input.entryLighter);
  const grossUsd = grossPerUnit * input.quantity;
  const feesUsd = input.quantity * (
    input.entryExtended * input.extendedEntryFeeBps
    + input.exitExtended * input.extendedExitFeeBps
    + input.entryLighter * input.lighterEntryFeeBps
    + input.exitLighter * input.lighterExitFeeBps
  ) / 10_000;
  const executionBufferUsd = input.notionalUsd
    * input.executionBufferBps / 10_000;
  const fundingUsd = input.notionalUsd * input.fundingBps / 10_000;
  const netUsd = grossUsd - feesUsd - executionBufferUsd - fundingUsd;
  return {
    grossUsd,
    feesUsd,
    executionBufferUsd,
    fundingUsd,
    netUsd,
    netBps: netUsd / input.notionalUsd * 10_000,
  };
}

export type MakerAbortInput = {
  extendedSide: 'long' | 'short';
  notionalUsd: number;
  quantity: number;
  entryExtended: number;
  exitExtended: number;
  extendedExitFeeBps: number;
  executionBufferBps: number;
};

export function makerAbortAfterCosts(input: MakerAbortInput): {
  grossUsd: number;
  feesUsd: number;
  executionBufferUsd: number;
  netUsd: number;
  netBps: number;
} {
  const grossUsd = (
    input.extendedSide === 'long'
      ? input.exitExtended - input.entryExtended
      : input.entryExtended - input.exitExtended
  ) * input.quantity;
  const feesUsd = input.exitExtended * input.quantity
    * input.extendedExitFeeBps / 10_000;
  const executionBufferUsd = input.notionalUsd
    * input.executionBufferBps / 10_000;
  const netUsd = grossUsd - feesUsd - executionBufferUsd;
  return {
    grossUsd,
    feesUsd,
    executionBufferUsd,
    netUsd,
    netBps: netUsd / input.notionalUsd * 10_000,
  };
}

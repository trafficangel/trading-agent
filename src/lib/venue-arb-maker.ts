export type MakerSide = 'buy' | 'sell';
export type TakerSide = 'BUY' | 'SELL';

export type MakerQueueState = {
  queueAhead: number;
  remaining: number;
  filled: boolean;
};

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
  const tradedThrough = makerSide === 'buy'
    ? tradePrice < quotePrice
    : tradePrice > quotePrice;
  if (tradedThrough) {
    return { queueAhead: 0, remaining: 0, filled: true };
  }
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

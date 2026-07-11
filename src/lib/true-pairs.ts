export type PairFit = {
  alpha: number;
  beta: number;
  residualMean: number;
  residualStd: number;
  phi: number;
  halfLifeBars: number;
  returnCorrelation: number;
};

/** Fixed epoch for hourly research blocks; never roll this with wall-clock time. */
export const TRUE_PAIRS_HOURLY_EPOCH_MS = Date.parse('2024-07-12T00:00:00Z');

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleCovariance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN;
  const ma = mean(a);
  const mb = mean(b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - ma) * (b[i]! - mb);
  return sum / (a.length - 1);
}

function correlation(a: number[], b: number[]): number {
  const covariance = sampleCovariance(a, b);
  const va = sampleCovariance(a, a);
  const vb = sampleCovariance(b, b);
  return va > 0 && vb > 0 ? covariance / Math.sqrt(va * vb) : Number.NaN;
}

/** Fit log(A) = alpha + beta*log(B), then estimate residual AR(1) half-life. */
export function fitLogPair(aPrices: number[], bPrices: number[]): PairFit | null {
  if (aPrices.length !== bPrices.length || aPrices.length < 20) return null;
  if (aPrices.some((price) => !(price > 0)) || bPrices.some((price) => !(price > 0))) return null;
  const a = aPrices.map(Math.log);
  const b = bPrices.map(Math.log);
  const covariance = sampleCovariance(b, a);
  const variance = sampleCovariance(b, b);
  if (!(variance > 0) || !Number.isFinite(covariance)) return null;
  const beta = covariance / variance;
  const alpha = mean(a) - beta * mean(b);
  const residuals = a.map((value, index) => value - alpha - beta * b[index]!);
  const residualMean = mean(residuals);
  const residualVariance = sampleCovariance(residuals, residuals);
  if (!(residualVariance > 0)) return null;

  const lagged = residuals.slice(0, -1);
  const current = residuals.slice(1);
  const phi = sampleCovariance(lagged, current) / sampleCovariance(lagged, lagged);
  const halfLifeBars = phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : Infinity;
  const aReturns: number[] = [];
  const bReturns: number[] = [];
  for (let i = 1; i < a.length; i++) {
    aReturns.push(a[i]! - a[i - 1]!);
    bReturns.push(b[i]! - b[i - 1]!);
  }
  return {
    alpha,
    beta,
    residualMean,
    residualStd: Math.sqrt(residualVariance),
    phi,
    halfLifeBars,
    returnCorrelation: correlation(aReturns, bReturns),
  };
}

export function pairResidualZ(aPrice: number, bPrice: number, fit: PairFit): number {
  if (!(aPrice > 0) || !(bPrice > 0) || !(fit.residualStd > 0)) return Number.NaN;
  const residual = Math.log(aPrice) - fit.alpha - fit.beta * Math.log(bPrice);
  return (residual - fit.residualMean) / fit.residualStd;
}

/**
 * Return on total gross exposure. direction=1 means long A / short beta*B;
 * direction=-1 means short A / long beta*B.
 */
export function pairTradeGrossPct(args: {
  direction: 1 | -1;
  beta: number;
  aEntry: number;
  aExit: number;
  bEntry: number;
  bExit: number;
}): number {
  if (
    !(args.beta > 0) ||
    !(args.aEntry > 0) ||
    !(args.aExit > 0) ||
    !(args.bEntry > 0) ||
    !(args.bExit > 0)
  ) {
    return Number.NaN;
  }
  const aReturn = args.aExit / args.aEntry - 1;
  const bReturn = args.bExit / args.bEntry - 1;
  return ((args.direction * (aReturn - args.beta * bReturn)) / (1 + args.beta)) * 100;
}

export function pairTradeNetPct(
  args: Parameters<typeof pairTradeGrossPct>[0],
  roundTripCostPct: number,
): number {
  return pairTradeGrossPct(args) - roundTripCostPct;
}

export type PairTopOfBook = { bid: number; ask: number };

export function pairEntryPrices(
  direction: 1 | -1,
  a: PairTopOfBook,
  b: PairTopOfBook,
): { a: number; b: number } {
  return direction === 1 ? { a: a.ask, b: b.bid } : { a: a.bid, b: b.ask };
}

export function pairExitPrices(
  direction: 1 | -1,
  a: PairTopOfBook,
  b: PairTopOfBook,
): { a: number; b: number } {
  return direction === 1 ? { a: a.bid, b: b.ask } : { a: a.ask, b: b.bid };
}

/** Funding PnL on total gross exposure. Positive rates are paid by longs. */
export function pairFundingCarryPct(args: {
  direction: 1 | -1;
  beta: number;
  aRates: number[];
  bRates: number[];
}): number {
  if (!(args.beta > 0) || args.aRates.length !== args.bRates.length) return Number.NaN;
  let carry = 0;
  for (let i = 0; i < args.aRates.length; i++) {
    carry += (args.direction * (-args.aRates[i]! + args.beta * args.bRates[i]!)) / (1 + args.beta);
  }
  return carry * 100;
}

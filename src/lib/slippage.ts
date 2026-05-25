/**
 * Slippage — difference between the price we expected (the signal/target
 * price coming from LuxAlgo) and the price we actually got on Bybit
 * after the market order filled.
 *
 * Convention used everywhere: «slippage against us» in basis points.
 *   positive = fill was WORSE than expected (paid more on long /
 *              sold cheaper on short → reduces realised PnL)
 *   negative = fill was BETTER than expected (got lucky)
 *
 * 1 bp = 0.01%. 30 bps = 0.30%. Anything beyond 30 bps on a liquid
 * USDT-perp on Bybit usually means thin book, big-spread, or a fast-
 * moving candle — worth a heads-up to the operator.
 *
 * Formula:
 *   raw_pct = (fillPrice - signalPrice) / signalPrice × 100
 *   bps     = raw_pct × 100 × (side === 'long' ? +1 : -1)
 *
 * Long that filled higher than signal → +bps (against us).
 * Short that filled lower than signal  → +bps (against us).
 */
export function computeSlippageBps(args: {
  side: 'long' | 'short';
  signalPrice: number;
  fillPrice: number;
}): number {
  if (!args.signalPrice || !args.fillPrice) return 0;
  const rawPct = ((args.fillPrice - args.signalPrice) / args.signalPrice) * 100;
  const bps = rawPct * 100 * (args.side === 'long' ? 1 : -1);
  // Round to 1 bp resolution — sub-bps noise is below the data quality.
  return Math.round(bps);
}

/** Same for exits, but the sign is reversed: a long is closed by a SELL,
 *  so a lower fill price = worse for us; a short is closed by a BUY,
 *  so a higher fill price = worse for us. */
export function computeExitSlippageBps(args: {
  side: 'long' | 'short';
  signalPrice: number;
  fillPrice: number;
}): number {
  if (!args.signalPrice || !args.fillPrice) return 0;
  const rawPct = ((args.fillPrice - args.signalPrice) / args.signalPrice) * 100;
  // On exit the direction flips compared to entry.
  const bps = rawPct * 100 * (args.side === 'long' ? -1 : 1);
  return Math.round(bps);
}

/** Default threshold above which we alert the operator. Configurable
 *  via env if some pair tends to slip more (e.g. UNI or TRX with
 *  thinner books); for now a single value covers all symbols. */
export const SLIPPAGE_ALERT_BPS = 30; // 0.30%

/**
 * Recompute backtest aggregate stats from a raw LuxAlgo trades log,
 * sized to OUR notional ($1000 per trade) with Bybit-realistic
 * commission deducted. This is the SINGLE SOURCE OF TRUTH for all
 * "what numbers does the strategy actually produce" display:
 *
 *   - Landing page top stats grid
 *   - Landing page equity curve + trades table
 *   - Telegram announcement post
 *   - Operator-facing scripts
 *
 * Why not trust LuxAlgo's Performance Summary directly?
 *   1. LuxAlgo sizes each trade at "1 unit × entry price" — varies
 *      per symbol and price level. For BNB at $700 that's ~$700, but
 *      we always trade $1000 notional → numbers DIVERGE.
 *   2. LuxAlgo doesn't deduct exchange commission. Bybit perps charge
 *      0.055% taker × 2 sides = 0.11% round-trip = $1.10 per $1000
 *      trade. Across 100 trades that's $110 reduction in net P&L.
 *   3. LuxAlgo doesn't model our safety SL — not modelled here either
 *      (would require per-bar OHLC), but disclaimed on the page.
 *
 * What's MODELLED here:
 *   - $1000 fixed notional per trade
 *   - 0.11% round-trip commission deducted
 *   - Cumulative equity curve (peak → trough for drawdown)
 *   - Long vs short breakdown
 *
 * What's NOT modelled:
 *   - Safety SL — needs per-bar OHLC during each trade. In live
 *     trading this caps the worst 5-10% of trades; absence in
 *     backtest = backtest's drawdown is upper bound of reality.
 *   - Slippage — assumed zero (shadow mode anyway).
 *   - Funding rates — small at 15m timeframe, ignored.
 */

import { TRACK_C_NOTIONAL_USD } from './track-c-config.js';
import type { BacktestSnapshot } from './track-c-config.js';

const NOTIONAL = TRACK_C_NOTIONAL_USD;
const COMMISSION_PCT_PER_SIDE = 0.00055;
const COMMISSION_USD_PER_TRADE = NOTIONAL * COMMISSION_PCT_PER_SIDE * 2;

/** Trade row shape (matches what scripts/import-strategy.ts writes
 *  to src/strategies/data/<slug>.json). */
export type RawTrade = {
  num: number;
  side: 'long' | 'short';
  entryAt: number | null;
  entryPrice: number;
  exitAt: number | null;
  exitPrice: number;
};

/** Result of recomputing aggregate stats. Same shape as BacktestSnapshot
 *  so it can drop into the landing-page renderer 1:1. */
export type RecomputedStats = {
  /** Fields preserved from input metadata (periodLabel, periodDays) */
  periodLabel: string;
  periodDays: number;
  initialCapital: number;
  notionalUsd: number;
  commissionPctPerSide: number;

  /** Fully derived from trades */
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;

  /** All P&L values are NET of commission on $NOTIONAL notional. */
  netPnlUsd: number;
  netPnlPct: number;
  cagrPct: number;
  profitFactor: number;
  commissionPaidUsd: number;

  maxDrawdownUsd: number;
  maxDrawdownPct: number;

  avgWinUsd: number;
  avgWinPct: number;
  avgLossUsd: number;
  avgLossPct: number;
  largestWinUsd: number;
  largestLossUsd: number;

  longTrades: number;
  longPnlPct: number;
  shortTrades: number;
  shortPnlPct: number;
};

export type EnrichedTrade = RawTrade & {
  /** Gross % move (sign-adjusted by side). */
  pnlPct: number;
  /** Net USD pnl on $NOTIONAL minus commission. */
  netPnlUsd: number;
  /** Cumulative net USD pnl after this trade. */
  cumulativePnlUsd: number;
};

/** Walk the trades, compute each one's net P&L on $1000 minus commission,
 *  and the running cumulative equity curve. Returns the enriched array. */
export function enrichTrades(trades: RawTrade[]): EnrichedTrade[] {
  let cum = 0;
  return trades.map((t) => {
    const sign = t.side === 'long' ? 1 : -1;
    const grossPct = (sign * (t.exitPrice - t.entryPrice)) / t.entryPrice * 100;
    const grossUsd = (grossPct / 100) * NOTIONAL;
    const netUsd = grossUsd - COMMISSION_USD_PER_TRADE;
    cum += netUsd;
    return {
      ...t,
      pnlPct: grossPct,
      netPnlUsd: Math.round(netUsd * 100) / 100,
      cumulativePnlUsd: Math.round(cum * 100) / 100,
    };
  });
}

/** Recompute every aggregate stat from raw trades + period metadata.
 *  Returns a fully-populated BacktestSnapshot drop-in. */
export function recomputeBacktestStats(
  trades: RawTrade[],
  meta: Pick<BacktestSnapshot, 'periodLabel' | 'periodDays'>,
): RecomputedStats {
  const enriched = enrichTrades(trades);

  const totalTrades = enriched.length;
  let wins = 0, losses = 0;
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let longTrades = 0, shortTrades = 0;
  let longUsd = 0, shortUsd = 0;
  let netUsd = 0;
  let sumWinUsd = 0, sumLossUsd = 0;
  let largestWinUsd = 0, largestLossUsd = 0;

  for (const t of enriched) {
    netUsd += t.netPnlUsd;
    if (t.side === 'long') {
      longTrades++;
      longUsd += t.netPnlUsd;
    } else {
      shortTrades++;
      shortUsd += t.netPnlUsd;
    }
    if (t.netPnlUsd > 0) {
      wins++;
      grossProfitUsd += t.netPnlUsd;
      sumWinUsd += t.netPnlUsd;
      if (t.netPnlUsd > largestWinUsd) largestWinUsd = t.netPnlUsd;
    } else if (t.netPnlUsd < 0) {
      losses++;
      grossLossUsd += Math.abs(t.netPnlUsd);
      sumLossUsd += t.netPnlUsd;
      if (t.netPnlUsd < largestLossUsd) largestLossUsd = t.netPnlUsd;
    }
    // (netPnlUsd === 0: rare ties, count as neither for WR purposes)
  }

  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const profitFactor = grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : 0;
  const avgWinUsd = wins > 0 ? sumWinUsd / wins : 0;
  const avgLossUsd = losses > 0 ? sumLossUsd / losses : 0;

  // Max drawdown (USD) — walk equity curve, track running peak.
  let peak = 0;
  let maxDdUsd = 0;
  let runningCum = 0;
  for (const t of enriched) {
    runningCum += t.netPnlUsd;
    if (runningCum > peak) peak = runningCum;
    const dd = peak - runningCum;
    if (dd > maxDdUsd) maxDdUsd = dd;
  }

  // Annualised return — LINEAR, not compounding.
  // We use FIXED $1000 notional per trade (no growing account); profits
  // don't get reinvested. A compounding CAGR formula would massively
  // overstate the rate. Linear = (total% / days) × 365 is the right
  // model for fixed-notional shadow/copy trading.
  const totalReturnPct = (netUsd / NOTIONAL) * 100;
  const cagrPct = meta.periodDays > 0
    ? (totalReturnPct * 365) / meta.periodDays
    : 0;

  const round2 = (n: number): number => Math.round(n * 100) / 100;

  return {
    periodLabel: meta.periodLabel,
    periodDays: meta.periodDays,
    initialCapital: NOTIONAL,
    notionalUsd: NOTIONAL,
    commissionPctPerSide: COMMISSION_PCT_PER_SIDE,

    totalTrades,
    wins,
    losses,
    winRate: Math.round(winRate * 10000) / 10000,

    netPnlUsd: round2(netUsd),
    netPnlPct: round2((netUsd / NOTIONAL) * 100),
    cagrPct: round2(cagrPct),
    profitFactor: Math.round(profitFactor * 1000) / 1000,
    commissionPaidUsd: round2(totalTrades * COMMISSION_USD_PER_TRADE),

    maxDrawdownUsd: round2(maxDdUsd),
    maxDrawdownPct: round2((maxDdUsd / NOTIONAL) * 100),

    avgWinUsd: round2(avgWinUsd),
    avgWinPct: round2((avgWinUsd / NOTIONAL) * 100),
    avgLossUsd: round2(avgLossUsd),
    avgLossPct: round2((avgLossUsd / NOTIONAL) * 100),
    largestWinUsd: round2(largestWinUsd),
    largestLossUsd: round2(largestLossUsd),

    longTrades,
    longPnlPct: round2((longUsd / NOTIONAL) * 100),
    shortTrades,
    shortPnlPct: round2((shortUsd / NOTIONAL) * 100),
  };
}

import type { MicrostructureFiveMinute } from './lighter-microstructure.js';

const FIVE_MINUTES_MS = 5 * 60_000;

export type MicroSide = 'long' | 'short';
export type TrendRegime = 'bull' | 'bear' | 'mixed';
export type VolatilityRegime = 'high' | 'low';

export type MicroFeatureBar = {
  marketId: number;
  symbol: string;
  timeMs: number;
  open: number;
  close: number;
  returnPct: number;
  spreadPct: number;
  bid5Usd: number;
  ask5Usd: number;
  depthImbalance: number;
  flowImbalance: number;
  liquidationImbalance: number;
  basisPct: number;
  fundingRatePctH: number;
  trend: TrendRegime;
  volatility: VolatilityRegime;
};

export type MicroRule = {
  id: string;
  family: 'flow-continuation' | 'absorption-reversal' | 'basis-reversion';
  holdBars: number;
  signal: (bar: MicroFeatureBar) => MicroSide | null;
};

export type MicroTrade = {
  ruleId: string;
  marketId: number;
  symbol: string;
  side: MicroSide;
  signalTimeMs: number;
  entryTimeMs: number;
  exitTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  grossPct: number;
  fundingPct: number;
  executionCostPct: number;
  netPct: number;
  trend: TrendRegime;
  volatility: VolatilityRegime;
};

export type MicroStats = {
  trades: number;
  netPct: number;
  profitFactor: number | null;
};

export type MicroRuleEvaluation = {
  ruleId: string;
  qualified: boolean;
  reasons: readonly string[];
  trades: number;
  netPct: number;
  profitFactor: number | null;
  adverseNetPct: number;
  adverseProfitFactor: number | null;
  meanL95Pct: number;
  maxDrawdownPct: number;
  long: MicroStats;
  short: MicroStats;
  folds: readonly MicroStats[];
  trend: Record<TrendRegime, MicroStats>;
  volatility: Record<VolatilityRegime, MicroStats>;
  activeSymbols: number;
  positiveSymbols: number;
  dominance: number;
  leaveOneOutMinNetPct: number;
};

function sideFromMirrored(
  longCondition: boolean,
  shortCondition: boolean,
): MicroSide | null {
  if (longCondition === shortCondition) return null;
  return longCondition ? 'long' : 'short';
}

function flowContinuation(bar: MicroFeatureBar): MicroSide | null {
  return sideFromMirrored(
    bar.depthImbalance >= 0.20 && bar.flowImbalance >= 0.25,
    bar.depthImbalance <= -0.20 && bar.flowImbalance <= -0.25,
  );
}

function absorptionReversal(bar: MicroFeatureBar): MicroSide | null {
  return sideFromMirrored(
    bar.flowImbalance <= -0.55 && bar.depthImbalance >= 0.15 && bar.returnPct <= 0,
    bar.flowImbalance >= 0.55 && bar.depthImbalance <= -0.15 && bar.returnPct >= 0,
  );
}

function basisReversion(bar: MicroFeatureBar): MicroSide | null {
  return sideFromMirrored(
    bar.basisPct <= -0.04 && bar.flowImbalance >= -0.35,
    bar.basisPct >= 0.04 && bar.flowImbalance <= 0.35,
  );
}

/**
 * Frozen before the first seven-day exploratory sample. These are six whole
 * hypotheses, not a parameter grid. Changing them requires a new preregistered
 * dataset epoch; otherwise the future 21-day result would be post-selected.
 */
export const PREREGISTERED_MICRO_RULES: readonly MicroRule[] = [
  { id: 'OF-CONT-25-H1', family: 'flow-continuation', holdBars: 1, signal: flowContinuation },
  { id: 'OF-CONT-25-H3', family: 'flow-continuation', holdBars: 3, signal: flowContinuation },
  { id: 'ABSORB-55-H1', family: 'absorption-reversal', holdBars: 1, signal: absorptionReversal },
  { id: 'ABSORB-55-H3', family: 'absorption-reversal', holdBars: 3, signal: absorptionReversal },
  { id: 'BASIS-4BP-H3', family: 'basis-reversion', holdBars: 3, signal: basisReversion },
  { id: 'BASIS-4BP-H6', family: 'basis-reversion', holdBars: 6, signal: basisReversion },
] as const;

function finite(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

function ema(previous: number | null, value: number, period: number): number {
  if (previous == null) return value;
  const alpha = 2 / (period + 1);
  return previous + alpha * (value - previous);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

/** Causal features: the current completed 5m row may be used, future rows may not. */
export function buildCausalMicroFeatureBars(
  rows: readonly MicrostructureFiveMinute[],
): MicroFeatureBar[] {
  const byMarket = new Map<number, MicrostructureFiveMinute[]>();
  for (const row of rows) {
    const market = byMarket.get(row.marketId) ?? [];
    market.push(row);
    byMarket.set(row.marketId, market);
  }
  const result: MicroFeatureBar[] = [];
  for (const marketRows of byMarket.values()) {
    marketRows.sort((left, right) => left.minuteTsMs - right.minuteTsMs);
    let fast: number | null = null;
    let slow: number | null = null;
    let absoluteReturnEma: number | null = null;
    let previousClose: number | null = null;
    const recentReturns: number[] = [];
    let consecutive = 0;
    let previousTime: number | null = null;

    for (const row of marketRows) {
      if (
        !finite(row.midOpen)
        || !finite(row.midClose)
        || !finite(row.spreadAvgPct)
        || !finite(row.bid5UsdAvg)
        || !finite(row.ask5UsdAvg)
        || !finite(row.depthImbalanceClose)
        || !finite(row.basisPct)
        || !finite(row.currentFundingRate)
      ) {
        consecutive = 0;
        previousTime = row.minuteTsMs;
        previousClose = null;
        recentReturns.length = 0;
        fast = null;
        slow = null;
        absoluteReturnEma = null;
        continue;
      }
      if (previousTime == null || row.minuteTsMs - previousTime !== FIVE_MINUTES_MS) {
        consecutive = 0;
        previousClose = null;
        recentReturns.length = 0;
        fast = null;
        slow = null;
        absoluteReturnEma = null;
      }
      previousTime = row.minuteTsMs;
      consecutive++;
      const returnPct = previousClose == null
        ? 0
        : (row.midClose - previousClose) / previousClose * 100;
      previousClose = row.midClose;
      fast = ema(fast, row.midClose, 12);
      slow = ema(slow, row.midClose, 48);
      absoluteReturnEma = ema(absoluteReturnEma, Math.abs(returnPct), 48);
      recentReturns.push(returnPct);
      if (recentReturns.length > 12) recentReturns.shift();
      if (consecutive < 48 || recentReturns.length < 12) continue;

      const tradedUsd = row.buyUsd + row.sellUsd;
      const liquidationUsd = row.liquidationBuyUsd + row.liquidationSellUsd;
      const trend: TrendRegime = row.midClose > fast && fast > slow
        ? 'bull'
        : row.midClose < fast && fast < slow
          ? 'bear'
          : 'mixed';
      const volatility: VolatilityRegime = standardDeviation(recentReturns)
        > Math.max(1e-9, absoluteReturnEma) * 1.25
        ? 'high'
        : 'low';
      result.push({
        marketId: row.marketId,
        symbol: row.symbol,
        timeMs: row.minuteTsMs,
        open: row.midOpen,
        close: row.midClose,
        returnPct,
        spreadPct: row.spreadAvgPct,
        bid5Usd: row.bid5UsdAvg,
        ask5Usd: row.ask5UsdAvg,
        depthImbalance: row.depthImbalanceClose,
        flowImbalance: tradedUsd > 0 ? row.cvdUsd / tradedUsd : 0,
        liquidationImbalance: liquidationUsd > 0
          ? (row.liquidationBuyUsd - row.liquidationSellUsd) / liquidationUsd
          : 0,
        basisPct: row.basisPct,
        fundingRatePctH: row.currentFundingRate,
        trend,
        volatility,
      });
    }
  }
  return result.sort((left, right) => left.timeMs - right.timeMs || left.marketId - right.marketId);
}

function liquidityPass(bar: MicroFeatureBar, executionCostPct: number): boolean {
  return bar.bid5Usd >= 500
    && bar.ask5Usd >= 500
    && bar.spreadPct <= Math.max(0.02, executionCostPct * 1.5);
}

function fundingPnlPct(
  side: MicroSide,
  entryRatePctH: number,
  exitRatePctH: number,
  heldMs: number,
): number {
  const meanRate = (entryRatePctH + exitRatePctH) / 2;
  return (side === 'long' ? -meanRate : meanRate) * heldMs / 3_600_000;
}

/**
 * Signal at completed bar t, entry at t+1 open, exit after the frozen horizon.
 * Missing bars, costs, funding or $500 per-side top-five depth reject the trade.
 */
export function simulateMicrostructureRule(
  features: readonly MicroFeatureBar[],
  rule: MicroRule,
  executionCostsPct: ReadonlyMap<string, number>,
): MicroTrade[] {
  const byMarket = new Map<number, MicroFeatureBar[]>();
  for (const bar of features) {
    const rows = byMarket.get(bar.marketId) ?? [];
    rows.push(bar);
    byMarket.set(bar.marketId, rows);
  }
  const trades: MicroTrade[] = [];
  for (const marketBars of byMarket.values()) {
    marketBars.sort((left, right) => left.timeMs - right.timeMs);
    for (let index = 0; index < marketBars.length; index++) {
      const signalBar = marketBars[index]!;
      const cost = executionCostsPct.get(signalBar.symbol);
      if (cost == null || !Number.isFinite(cost) || cost < 0 || !liquidityPass(signalBar, cost)) {
        continue;
      }
      const side = rule.signal(signalBar);
      if (!side) continue;
      const entryIndex = index + 1;
      const exitIndex = entryIndex + rule.holdBars;
      const entry = marketBars[entryIndex];
      const exit = marketBars[exitIndex];
      if (
        !entry
        || !exit
        || entry.timeMs !== signalBar.timeMs + FIVE_MINUTES_MS
        || exit.timeMs !== entry.timeMs + rule.holdBars * FIVE_MINUTES_MS
      ) continue;
      const grossPct = side === 'long'
        ? (exit.open - entry.open) / entry.open * 100
        : (entry.open - exit.open) / entry.open * 100;
      const fundingPct = fundingPnlPct(
        side,
        entry.fundingRatePctH,
        exit.fundingRatePctH,
        exit.timeMs - entry.timeMs,
      );
      trades.push({
        ruleId: rule.id,
        marketId: signalBar.marketId,
        symbol: signalBar.symbol,
        side,
        signalTimeMs: signalBar.timeMs,
        entryTimeMs: entry.timeMs,
        exitTimeMs: exit.timeMs,
        entryPrice: entry.open,
        exitPrice: exit.open,
        grossPct,
        fundingPct,
        executionCostPct: cost,
        netPct: grossPct + fundingPct - cost,
        trend: signalBar.trend,
        volatility: signalBar.volatility,
      });
      index = exitIndex - 1;
    }
  }
  return trades.sort((left, right) => left.entryTimeMs - right.entryTimeMs || left.marketId - right.marketId);
}

function tradeNet(trade: MicroTrade, costMultiplier = 1): number {
  return trade.grossPct + trade.fundingPct - trade.executionCostPct * costMultiplier;
}

function stats(trades: readonly MicroTrade[], costMultiplier = 1): MicroStats {
  const values = trades.map((trade) => tradeNet(trade, costMultiplier));
  const wins = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(
    values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );
  return {
    trades: values.length,
    netPct: values.reduce((sum, value) => sum + value, 0),
    profitFactor: losses > 0 ? wins / losses : values.length ? Infinity : null,
  };
}

function lowerConfidence95(values: readonly number[]): number {
  if (values.length < 2) return Number.NEGATIVE_INFINITY;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return mean - 1.645 * standardDeviation(values) / Math.sqrt(values.length);
}

function drawdown(trades: readonly MicroTrade[], capacityUnits: number): number {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const trade of trades) {
    equity += trade.netPct;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum / Math.max(1, capacityUnits);
}

function thirds(trades: readonly MicroTrade[]): MicroStats[] {
  return [0, 1, 2].map((fold) => {
    const start = Math.floor(trades.length * fold / 3);
    const end = Math.floor(trades.length * (fold + 1) / 3);
    return stats(trades.slice(start, end));
  });
}

export function evaluateMicrostructureRule(
  ruleId: string,
  sourceTrades: readonly MicroTrade[],
  capacityUnits = 10,
): MicroRuleEvaluation {
  const trades = [...sourceTrades].sort(
    (left, right) => left.entryTimeMs - right.entryTimeMs || left.marketId - right.marketId,
  );
  const base = stats(trades);
  const adverse = stats(trades, 1.5);
  const long = stats(trades.filter((trade) => trade.side === 'long'));
  const short = stats(trades.filter((trade) => trade.side === 'short'));
  const folds = thirds(trades);
  const trend = {
    bull: stats(trades.filter((trade) => trade.trend === 'bull')),
    bear: stats(trades.filter((trade) => trade.trend === 'bear')),
    mixed: stats(trades.filter((trade) => trade.trend === 'mixed')),
  };
  const volatility = {
    high: stats(trades.filter((trade) => trade.volatility === 'high')),
    low: stats(trades.filter((trade) => trade.volatility === 'low')),
  };
  const bySymbol = new Map<string, MicroTrade[]>();
  for (const trade of trades) {
    const rows = bySymbol.get(trade.symbol) ?? [];
    rows.push(trade);
    bySymbol.set(trade.symbol, rows);
  }
  const symbolNets = [...bySymbol.values()].map((rows) => stats(rows).netPct);
  const positiveTotal = symbolNets.filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const dominance = positiveTotal > 0
    ? Math.max(0, ...symbolNets) / positiveTotal
    : 1;
  const leaveOneOutMinNetPct = symbolNets.length
    ? Math.min(...symbolNets.map((value) => base.netPct - value))
    : Number.NEGATIVE_INFINITY;
  const meanL95Pct = lowerConfidence95(trades.map((trade) => trade.netPct));
  const maxDrawdownPct = drawdown(trades, capacityUnits);
  const reasons: string[] = [];
  if (base.trades < 120) reasons.push(`trades ${base.trades} < 120`);
  if (!(base.netPct > 0)) reasons.push(`net ${base.netPct.toFixed(3)}% <= 0%`);
  if (!(base.profitFactor != null && base.profitFactor >= 1.2)) {
    reasons.push(`PF ${base.profitFactor?.toFixed(2) ?? 'n/a'} < 1.20`);
  }
  if (!(adverse.netPct > 0 && adverse.profitFactor != null && adverse.profitFactor >= 1.1)) {
    reasons.push('1.5x cost stress failed');
  }
  if (!(meanL95Pct > 0)) reasons.push(`mean L95 ${meanL95Pct.toFixed(4)}% <= 0%`);
  if (!(long.trades >= 30 && long.netPct > 0)) reasons.push('long side failed');
  if (!(short.trades >= 30 && short.netPct > 0)) reasons.push('short side failed');
  if (folds.some((fold) => !(fold.trades >= 30 && fold.netPct > 0))) {
    reasons.push('chronological thirds failed');
  }
  if (maxDrawdownPct > 5) reasons.push(`drawdown ${maxDrawdownPct.toFixed(2)}% > 5%`);
  if (!(trend.bull.trades >= 20 && trend.bull.netPct > 0)) reasons.push('bull regime failed');
  if (!(trend.bear.trades >= 20 && trend.bear.netPct > 0)) reasons.push('bear regime failed');
  if (!(volatility.high.trades >= 20 && volatility.high.netPct > 0)) {
    reasons.push('high-volatility regime failed');
  }
  if (!(volatility.low.trades >= 20 && volatility.low.netPct > 0)) {
    reasons.push('low-volatility regime failed');
  }
  const activeSymbols = bySymbol.size;
  const positiveSymbols = symbolNets.filter((value) => value > 0).length;
  if (activeSymbols < 4) reasons.push(`active symbols ${activeSymbols} < 4`);
  if (positiveSymbols < Math.max(3, Math.ceil(activeSymbols / 2))) {
    reasons.push(`positive symbols ${positiveSymbols}/${activeSymbols}`);
  }
  if (dominance > 0.6) reasons.push(`dominance ${(dominance * 100).toFixed(1)}% > 60%`);
  if (!(leaveOneOutMinNetPct > 0)) reasons.push('leave-one-market-out failed');

  return {
    ruleId,
    qualified: reasons.length === 0,
    reasons,
    trades: base.trades,
    netPct: base.netPct,
    profitFactor: base.profitFactor,
    adverseNetPct: adverse.netPct,
    adverseProfitFactor: adverse.profitFactor,
    meanL95Pct,
    maxDrawdownPct,
    long,
    short,
    folds,
    trend,
    volatility,
    activeSymbols,
    positiveSymbols,
    dominance,
    leaveOneOutMinNetPct,
  };
}

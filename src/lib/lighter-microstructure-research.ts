import type { MicrostructureFiveMinute } from './lighter-microstructure.js';
import {
  lighterFundingPnlPct,
  type LighterFundingSeries,
} from './lighter-funding-history.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** First eligible minute after the preregistered flow-quality correction. */
export const MICROSTRUCTURE_RESEARCH_EPOCH_AT_MS = Date.parse(
  '2026-07-31T18:45:00.000Z',
);

/** Independent challenger clock, frozen after the core feed was health-checked. */
export const MICROSTRUCTURE_CHALLENGER_EPOCH_AT_MS = Date.parse(
  '2026-07-31T19:00:00.000Z',
);

type MicrostructureSourceBar = Omit<MicrostructureFiveMinute, 'sourceMinutes'>;

export type MicroSide = 'long' | 'short';
export type TrendRegime = 'bull' | 'bear' | 'mixed';
export type VolatilityRegime = 'high' | 'low';

export type MicroFeatureBar = {
  marketId: number;
  symbol: string;
  timeMs: number;
  barMinutes: 1 | 5;
  open: number;
  close: number;
  returnPct: number;
  spreadPct: number;
  bid5Usd: number;
  ask5Usd: number;
  depthImbalance: number;
  depthImbalanceChange: number;
  tradedUsd: number;
  tradeCount: number;
  flowImbalance: number;
  returnVolRatio: number;
  liquidationImbalance: number;
  liquidationShare: number;
  basisPct: number;
  fundingRatePctH: number;
  /** Causal p95 from the completed signal bar's $100 L2 samples. */
  executionCostPct: number | null;
  /** Worst causal $100 round trip observed inside the completed signal bar. */
  adverseExecutionCostPct: number | null;
  /** P95 age of the completed signal bar's native L2 snapshots. */
  bookAgeMs: number;
  trend: TrendRegime;
  volatility: VolatilityRegime;
};

export type MicroRule = {
  id: string;
  family:
    | 'flow-continuation'
    | 'absorption-reversal'
    | 'basis-reversion'
    | 'book-flip-continuation'
    | 'low-impact-absorption'
    | 'liquidation-exhaustion';
  holdMinutes: 5 | 15 | 30;
  signal: (bar: MicroFeatureBar) => MicroSide | null;
};

export type MicroTrade = {
  ruleId: string;
  marketId: number;
  symbol: string;
  side: MicroSide;
  barMinutes: 1 | 5;
  signalTimeMs: number;
  entryTimeMs: number;
  exitTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  grossPct: number;
  fundingPct: number;
  executionCostPct: number;
  adverseExecutionCostPct: number;
  bookAgeMs: number;
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
  discovery: MicroStats;
  oos: MicroStats;
  oosLong: MicroStats;
  oosShort: MicroStats;
};

/**
 * Return an already locked first-admissible frozen selection, or null while
 * the file is still pre-gate. An evaluated file with a missing/mismatched
 * lock is never overwritten: doing so would turn the 21d holdout into a
 * rolling, repeatedly inspected selection window.
 */
export function existingImmutableFrozenMicrostructureReport(
  value: unknown,
  expectedVersion = 'lighter-microstructure-sweep-v3',
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  if (report.status !== 'evaluated') return null;
  if (
    report.version !== expectedVersion
    || report.mode !== 'frozen'
    || report.immutableSelection !== true
    || report.autoPromotion !== false
    || !Array.isArray(report.shadowEligibleRules)
    || !Array.isArray(report.evaluations)
  ) {
    throw new Error(
      `existing evaluated frozen microstructure report is not an immutable ${expectedVersion} selection; refusing overwrite`,
    );
  }
  return report;
}

function sideFromMirrored(
  longCondition: boolean,
  shortCondition: boolean,
): MicroSide | null {
  if (longCondition === shortCondition) return null;
  return longCondition ? 'long' : 'short';
}

function flowContinuation(bar: MicroFeatureBar): MicroSide | null {
  if (bar.tradeCount < 5 || bar.tradedUsd < 500) return null;
  return sideFromMirrored(
    bar.depthImbalance >= 0.20 && bar.flowImbalance >= 0.25,
    bar.depthImbalance <= -0.20 && bar.flowImbalance <= -0.25,
  );
}

function absorptionReversal(bar: MicroFeatureBar): MicroSide | null {
  if (bar.tradeCount < 5 || bar.tradedUsd < 500) return null;
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

function bookFlipContinuation(bar: MicroFeatureBar): MicroSide | null {
  if (bar.tradeCount < 5 || bar.tradedUsd < 500) return null;
  return sideFromMirrored(
    bar.depthImbalanceChange >= 0.30
      && bar.depthImbalance >= 0.20
      && bar.flowImbalance >= 0.10,
    bar.depthImbalanceChange <= -0.30
      && bar.depthImbalance <= -0.20
      && bar.flowImbalance <= -0.10,
  );
}

function lowImpactAbsorption(bar: MicroFeatureBar): MicroSide | null {
  if (bar.tradeCount < 5 || bar.tradedUsd < 500) return null;
  return sideFromMirrored(
    bar.flowImbalance <= -0.60
      && bar.returnVolRatio >= -0.25
      && bar.depthImbalance >= 0.10,
    bar.flowImbalance >= 0.60
      && bar.returnVolRatio <= 0.25
      && bar.depthImbalance <= -0.10,
  );
}

function liquidationExhaustion(bar: MicroFeatureBar): MicroSide | null {
  if (bar.tradeCount < 5 || bar.tradedUsd < 500) return null;
  return sideFromMirrored(
    bar.liquidationShare >= 0.20
      && bar.liquidationImbalance <= -0.60
      && bar.returnVolRatio <= -0.50
      && bar.depthImbalance >= 0.10,
    bar.liquidationShare >= 0.20
      && bar.liquidationImbalance >= 0.60
      && bar.returnVolRatio >= 0.50
      && bar.depthImbalance <= -0.10,
  );
}

/**
 * Frozen before the first seven-day exploratory sample. These are six whole
 * hypotheses, not a parameter grid. Changing them requires a new preregistered
 * dataset epoch; otherwise the future 21-day result would be post-selected.
 */
export const PREREGISTERED_MICRO_RULES: readonly MicroRule[] = [
  { id: 'OF-CONT-25-H1', family: 'flow-continuation', holdMinutes: 5, signal: flowContinuation },
  { id: 'OF-CONT-25-H3', family: 'flow-continuation', holdMinutes: 15, signal: flowContinuation },
  { id: 'ABSORB-55-H1', family: 'absorption-reversal', holdMinutes: 5, signal: absorptionReversal },
  { id: 'ABSORB-55-H3', family: 'absorption-reversal', holdMinutes: 15, signal: absorptionReversal },
  { id: 'BASIS-4BP-H3', family: 'basis-reversion', holdMinutes: 15, signal: basisReversion },
  { id: 'BASIS-4BP-H6', family: 'basis-reversion', holdMinutes: 30, signal: basisReversion },
] as const;

/**
 * Independently dated challenger set. It is not a parameter grid: the paired
 * rows alter only the fixed holding horizon and every signal is mirrored.
 */
export const PREREGISTERED_MICRO_CHALLENGERS: readonly MicroRule[] = [
  { id: 'BOOK-FLIP-30-H1', family: 'book-flip-continuation', holdMinutes: 5, signal: bookFlipContinuation },
  { id: 'BOOK-FLIP-30-H3', family: 'book-flip-continuation', holdMinutes: 15, signal: bookFlipContinuation },
  { id: 'LOW-IMPACT-60-H1', family: 'low-impact-absorption', holdMinutes: 5, signal: lowImpactAbsorption },
  { id: 'LOW-IMPACT-60-H3', family: 'low-impact-absorption', holdMinutes: 15, signal: lowImpactAbsorption },
  { id: 'LIQ-EXHAUST-20-H3', family: 'liquidation-exhaustion', holdMinutes: 15, signal: liquidationExhaustion },
  { id: 'LIQ-EXHAUST-20-H6', family: 'liquidation-exhaustion', holdMinutes: 30, signal: liquidationExhaustion },
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

/** Causal features: the current completed bar may be used, future rows may not. */
export function buildCausalMicroFeatureBars(
  rows: readonly MicrostructureSourceBar[],
  barMinutes: 1 | 5,
): MicroFeatureBar[] {
  const barMs = barMinutes * MINUTE_MS;
  const fastPeriod = 60 / barMinutes;
  const slowPeriod = 240 / barMinutes;
  const volatilityWindow = 60 / barMinutes;
  const byMarket = new Map<number, MicrostructureSourceBar[]>();
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
        || !finite(row.depthImbalanceAvg)
        || !finite(row.depthImbalanceClose)
        || !finite(row.bookAgeP95Ms)
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
      if (previousTime == null || row.minuteTsMs - previousTime !== barMs) {
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
      fast = ema(fast, row.midClose, fastPeriod);
      slow = ema(slow, row.midClose, slowPeriod);
      absoluteReturnEma = ema(absoluteReturnEma, Math.abs(returnPct), slowPeriod);
      recentReturns.push(returnPct);
      if (recentReturns.length > volatilityWindow) recentReturns.shift();
      if (consecutive < slowPeriod || recentReturns.length < volatilityWindow) continue;

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
      const trailingVolatility = standardDeviation(recentReturns);
      result.push({
        marketId: row.marketId,
        symbol: row.symbol,
        timeMs: row.minuteTsMs,
        barMinutes,
        open: row.midOpen,
        close: row.midClose,
        returnPct,
        spreadPct: row.spreadAvgPct,
        bid5Usd: row.bid5UsdAvg,
        ask5Usd: row.ask5UsdAvg,
        depthImbalance: row.depthImbalanceClose,
        depthImbalanceChange: row.depthImbalanceClose - row.depthImbalanceAvg,
        tradedUsd,
        tradeCount: row.tradeCount,
        flowImbalance: tradedUsd > 0 ? row.cvdUsd / tradedUsd : 0,
        returnVolRatio: trailingVolatility > 1e-9 ? returnPct / trailingVolatility : 0,
        liquidationImbalance: liquidationUsd > 0
          ? (row.liquidationBuyUsd - row.liquidationSellUsd) / liquidationUsd
          : 0,
        liquidationShare: tradedUsd > 0 ? liquidationUsd / tradedUsd : 0,
        basisPct: row.basisPct,
        fundingRatePctH: row.currentFundingRate,
        executionCostPct: row.execCost100P95Pct,
        adverseExecutionCostPct: row.execCost100MaxPct,
        bookAgeMs: row.bookAgeP95Ms,
        trend,
        volatility,
      });
    }
  }
  return result.sort((left, right) => left.timeMs - right.timeMs || left.marketId - right.marketId);
}

function liquidityPass(bar: MicroFeatureBar): boolean {
  // Spread and slippage are already present in the measured executable $100
  // round-trip cost. A second ratio/fixed-spread gate would double-filter the
  // same cost and reintroduce an arbitrary assumption.
  return bar.bid5Usd >= 500
    && bar.ask5Usd >= 500
    && bar.bookAgeMs <= 2_000;
}

/**
 * Signal at completed bar t, entry at t+1 open, exit after the frozen horizon.
 * Missing bars, costs, exact funding history, stale L2 or $500 per-side
 * top-five depth reject the trade.
 */
export function simulateMicrostructureRule(
  features: readonly MicroFeatureBar[],
  rule: MicroRule,
  fundingByMarket: ReadonlyMap<number, LighterFundingSeries>,
  maximumConcurrentPositions = 10,
): MicroTrade[] {
  if (!Number.isInteger(maximumConcurrentPositions) || maximumConcurrentPositions < 1) return [];
  const byMarket = new Map<number, MicroFeatureBar[]>();
  for (const bar of features) {
    const rows = byMarket.get(bar.marketId) ?? [];
    rows.push(bar);
    byMarket.set(bar.marketId, rows);
  }
  const trades: MicroTrade[] = [];
  for (const marketBars of byMarket.values()) {
    marketBars.sort((left, right) => left.timeMs - right.timeMs);
    const fundingSeries = fundingByMarket.get(marketBars[0]!.marketId);
    if (!fundingSeries) continue;
    for (let index = 0; index < marketBars.length; index++) {
      const signalBar = marketBars[index]!;
      const cost = signalBar.executionCostPct;
      const adverseCost = signalBar.adverseExecutionCostPct;
      if (
        cost == null
        || !Number.isFinite(cost)
        || cost < 0
        || adverseCost == null
        || !Number.isFinite(adverseCost)
        || adverseCost < cost
        || !liquidityPass(signalBar)
      ) {
        continue;
      }
      const side = rule.signal(signalBar);
      if (!side) continue;
      const holdBars = rule.holdMinutes / signalBar.barMinutes;
      if (!Number.isInteger(holdBars) || holdBars < 1) continue;
      const barMs = signalBar.barMinutes * MINUTE_MS;
      const entryIndex = index + 1;
      const exitIndex = entryIndex + holdBars;
      const entry = marketBars[entryIndex];
      const exit = marketBars[exitIndex];
      if (
        !entry
        || !exit
        || entry.barMinutes !== signalBar.barMinutes
        || exit.barMinutes !== signalBar.barMinutes
        || entry.timeMs !== signalBar.timeMs + barMs
        || exit.timeMs !== entry.timeMs + rule.holdMinutes * MINUTE_MS
      ) continue;
      const grossPct = side === 'long'
        ? (exit.open - entry.open) / entry.open * 100
        : (entry.open - exit.open) / entry.open * 100;
      const fundingPct = lighterFundingPnlPct(
        fundingSeries,
        side,
        entry.timeMs,
        exit.timeMs,
      );
      trades.push({
        ruleId: rule.id,
        marketId: signalBar.marketId,
        symbol: signalBar.symbol,
        side,
        barMinutes: signalBar.barMinutes,
        signalTimeMs: signalBar.timeMs,
        entryTimeMs: entry.timeMs,
        exitTimeMs: exit.timeMs,
        entryPrice: entry.open,
        exitPrice: exit.open,
        grossPct,
        fundingPct,
        executionCostPct: cost,
        adverseExecutionCostPct: adverseCost,
        bookAgeMs: signalBar.bookAgeMs,
        netPct: grossPct + fundingPct - cost,
        trend: signalBar.trend,
        volatility: signalBar.volatility,
      });
      index = exitIndex - 1;
    }
  }
  const ordered = trades.sort(
    (left, right) => left.entryTimeMs - right.entryTimeMs || left.marketId - right.marketId,
  );
  const accepted: MicroTrade[] = [];
  const activeExitTimes: number[] = [];
  for (const trade of ordered) {
    for (let index = activeExitTimes.length - 1; index >= 0; index--) {
      if (activeExitTimes[index]! <= trade.entryTimeMs) activeExitTimes.splice(index, 1);
    }
    if (activeExitTimes.length >= maximumConcurrentPositions) continue;
    accepted.push(trade);
    activeExitTimes.push(trade.exitTimeMs);
  }
  return accepted;
}

function tradeNet(trade: MicroTrade, adverse = false): number {
  const executionCost = adverse
    ? trade.adverseExecutionCostPct
    : trade.executionCostPct;
  return trade.grossPct + trade.fundingPct - executionCost;
}

function stats(trades: readonly MicroTrade[], adverse = false): MicroStats {
  const values = trades.map((trade) => tradeNet(trade, adverse));
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
  discoveryCutoffMs = (sourceTrades[0]?.entryTimeMs ?? 0) + 7 * DAY_MS,
): MicroRuleEvaluation {
  const trades = [...sourceTrades].sort(
    (left, right) => left.entryTimeMs - right.entryTimeMs || left.marketId - right.marketId,
  );
  const base = stats(trades);
  const adverse = stats(trades, true);
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
  const discoveryTrades = trades.filter((trade) => trade.entryTimeMs < discoveryCutoffMs);
  const oosTrades = trades.filter((trade) => trade.entryTimeMs >= discoveryCutoffMs);
  const discovery = stats(discoveryTrades);
  const oos = stats(oosTrades);
  const oosLong = stats(oosTrades.filter((trade) => trade.side === 'long'));
  const oosShort = stats(oosTrades.filter((trade) => trade.side === 'short'));
  const reasons: string[] = [];
  if (base.trades < 120) reasons.push(`trades ${base.trades} < 120`);
  if (!(base.netPct > 0)) reasons.push(`net ${base.netPct.toFixed(3)}% <= 0%`);
  if (!(base.profitFactor != null && base.profitFactor >= 1.2)) {
    reasons.push(`PF ${base.profitFactor?.toFixed(2) ?? 'n/a'} < 1.20`);
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
  if (!(oos.trades >= 60 && oos.netPct > 0 && oos.profitFactor != null && oos.profitFactor >= 1.1)) {
    reasons.push('frozen OOS failed');
  }
  if (!(oosLong.trades >= 15 && oosLong.netPct > 0)) reasons.push('OOS long side failed');
  if (!(oosShort.trades >= 15 && oosShort.netPct > 0)) reasons.push('OOS short side failed');

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
    discovery,
    oos,
    oosLong,
    oosShort,
  };
}

export type MomentumSegmentSide = 'long' | 'short';
export type MomentumSegmentLayer = 'fast' | 'confirm' | 'unknown';

export type MomentumSegmentRow = {
  side: MomentumSegmentSide;
  layer: MomentumSegmentLayer;
  pnlPct: number;
};

export type MomentumSegmentPolicy = {
  sampleSize: number;
  recentSize: number;
  minAveragePct: number;
  minRecentAveragePct: number;
};

export type MomentumSegmentStats = {
  n: number;
  averagePct: number;
  winRate: number;
  sumPct: number;
};

export type MomentumSegmentEvaluation = {
  enabled: boolean;
  sample: MomentumSegmentStats;
  recent: MomentumSegmentStats;
  reason: string;
};

export type MomentumPromotionStage = 'shadow' | 'canary-1' | 'canary-2' | 'scaled';

export type MomentumPromotionTrade = {
  pnlPct: number;
  netPnlUsd: number | null;
  exact: boolean;
  closedAt: number;
};

export type MomentumPromotionPolicy = {
  pauseSampleSize: number;
  pauseBelowAveragePct: number;
  retryAfterMs: number;
  canary2MinTrades: number;
  canary2MinAveragePct: number;
  canary2MinProfitFactor: number;
  canary2MaxDrawdownPct: number;
  scaledMinTrades: number;
  scaledMinAveragePct: number;
  scaledMinProfitFactor: number;
  scaledMaxDrawdownPct: number;
};

export type MomentumPromotionEvaluation = {
  stage: MomentumPromotionStage;
  liveEnabled: boolean;
  maxOpen: 1 | 2;
  n: number;
  exactN: number;
  netPnlUsd: number;
  averagePct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  nextStage: MomentumPromotionStage | null;
  nextMinTrades: number | null;
  retryAfter: number | null;
  reason: string;
};

export const CONFIRM_LONG_CANARY_POLICY: MomentumSegmentPolicy = {
  sampleSize: 40,
  recentSize: 20,
  minAveragePct: 0.03,
  minRecentAveragePct: 0,
};

export const MOMENTUM_PROMOTION_POLICY: MomentumPromotionPolicy = {
  pauseSampleSize: 3,
  pauseBelowAveragePct: 0,
  retryAfterMs: 24 * 60 * 60_000,
  canary2MinTrades: 10,
  canary2MinAveragePct: 0.03,
  canary2MinProfitFactor: 1.10,
  canary2MaxDrawdownPct: 1.50,
  scaledMinTrades: 25,
  scaledMinAveragePct: 0.05,
  scaledMinProfitFactor: 1.20,
  scaledMaxDrawdownPct: 2.00,
};

function stats(rows: MomentumSegmentRow[]): MomentumSegmentStats {
  const finite = rows.filter((row) => Number.isFinite(row.pnlPct));
  if (finite.length === 0) return { n: 0, averagePct: 0, winRate: 0, sumPct: 0 };
  const sumPct = finite.reduce((sum, row) => sum + row.pnlPct, 0);
  return {
    n: finite.length,
    averagePct: sumPct / finite.length,
    winRate: finite.filter((row) => row.pnlPct > 0).length / finite.length,
    sumPct,
  };
}

function meetsPromotionGate(
  n: number,
  exactN: number,
  averagePct: number,
  netPnlUsd: number,
  profitFactor: number | null,
  maxDrawdownPct: number,
  minTrades: number,
  minAveragePct: number,
  minProfitFactor: number,
  maxAllowedDrawdownPct: number,
): boolean {
  const profitFactorPasses = profitFactor === null ? netPnlUsd > 0 : profitFactor >= minProfitFactor;
  return n >= minTrades
    && exactN === n
    && netPnlUsd > 0
    && averagePct >= minAveragePct
    && profitFactorPasses
    && maxDrawdownPct <= maxAllowedDrawdownPct;
}

/** Trades must be chronological so drawdown and loss-cooldown decisions have no lookahead. */
export function evaluateMomentumPromotion(
  tradesOldestFirst: MomentumPromotionTrade[],
  shadowEdgeProven: boolean,
  nowMs: number,
  policy: MomentumPromotionPolicy = MOMENTUM_PROMOTION_POLICY,
): MomentumPromotionEvaluation {
  const trades = tradesOldestFirst.filter((trade) => Number.isFinite(trade.pnlPct) && Number.isFinite(trade.closedAt));
  const n = trades.length;
  const exactTrades = trades.filter((trade) => trade.exact && trade.netPnlUsd != null && Number.isFinite(trade.netPnlUsd));
  const exactN = exactTrades.length;
  const netPnlUsd = exactTrades.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0);
  const averagePct = n ? trades.reduce((sum, trade) => sum + trade.pnlPct, 0) / n : 0;
  const grossProfit = exactTrades.reduce((sum, trade) => sum + Math.max(0, trade.netPnlUsd ?? 0), 0);
  const grossLoss = exactTrades.reduce((sum, trade) => sum + Math.max(0, -(trade.netPnlUsd ?? 0)), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  let equityPct = 0;
  let peakPct = 0;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equityPct += trade.pnlPct;
    peakPct = Math.max(peakPct, equityPct);
    maxDrawdownPct = Math.max(maxDrawdownPct, peakPct - equityPct);
  }

  const recent = trades.slice(-policy.pauseSampleSize);
  const recentAveragePct = recent.length
    ? recent.reduce((sum, trade) => sum + trade.pnlPct, 0) / recent.length
    : 0;
  const latestClosedAt = trades.at(-1)?.closedAt ?? null;
  const retryAfter = recent.length >= policy.pauseSampleSize
    && recentAveragePct < policy.pauseBelowAveragePct
    && latestClosedAt != null
    ? latestClosedAt + policy.retryAfterMs
    : null;

  let stage: MomentumPromotionStage;
  let reason: string;
  if (!shadowEdgeProven) {
    stage = 'shadow';
    reason = 'shadow edge is not proven';
  } else if (retryAfter != null && nowMs < retryAfter) {
    stage = 'shadow';
    reason = `recent ${policy.pauseSampleSize} live trades are red; retry after cooldown`;
  } else if (meetsPromotionGate(
    n, exactN, averagePct, netPnlUsd, profitFactor, maxDrawdownPct,
    policy.scaledMinTrades, policy.scaledMinAveragePct, policy.scaledMinProfitFactor, policy.scaledMaxDrawdownPct,
  )) {
    stage = 'scaled';
    reason = 'scaled evidence gate passed';
  } else if (meetsPromotionGate(
    n, exactN, averagePct, netPnlUsd, profitFactor, maxDrawdownPct,
    policy.canary2MinTrades, policy.canary2MinAveragePct, policy.canary2MinProfitFactor, policy.canary2MaxDrawdownPct,
  )) {
    stage = 'canary-2';
    reason = 'canary-2 evidence gate passed';
  } else {
    stage = 'canary-1';
    reason = retryAfter != null ? 'loss cooldown elapsed; one-slot probe restored' : 'collecting exact canary evidence';
  }

  const nextStage = stage === 'shadow' ? 'canary-1' : stage === 'canary-1' ? 'canary-2' : stage === 'canary-2' ? 'scaled' : null;
  const nextMinTrades = stage === 'canary-1'
    ? policy.canary2MinTrades
    : stage === 'canary-2'
      ? policy.scaledMinTrades
      : null;

  return {
    stage,
    liveEnabled: stage !== 'shadow',
    maxOpen: stage === 'canary-1' || stage === 'shadow' ? 1 : 2,
    n,
    exactN,
    netPnlUsd,
    averagePct,
    profitFactor,
    maxDrawdownPct,
    nextStage,
    nextMinTrades,
    retryAfter,
    reason,
  };
}

/** Rows must be newest first so both windows use only current evidence. */
export function evaluateMomentumSegment(
  rowsNewestFirst: MomentumSegmentRow[],
  layer: MomentumSegmentLayer,
  side: MomentumSegmentSide,
  policy: MomentumSegmentPolicy,
): MomentumSegmentEvaluation {
  const family = rowsNewestFirst.filter((row) => row.layer === layer && row.side === side);
  const sampleRows = family.slice(0, policy.sampleSize);
  const recentRows = sampleRows.slice(0, policy.recentSize);
  const sample = stats(sampleRows);
  const recent = stats(recentRows);

  let reason = 'edge proven';
  if (sample.n < policy.sampleSize) reason = `sample ${sample.n}/${policy.sampleSize}`;
  else if (recent.n < policy.recentSize) reason = `recent ${recent.n}/${policy.recentSize}`;
  else if (sample.averagePct < policy.minAveragePct) {
    reason = `average ${sample.averagePct.toFixed(3)}% < ${policy.minAveragePct.toFixed(3)}%`;
  } else if (recent.averagePct < policy.minRecentAveragePct) {
    reason = `recent average ${recent.averagePct.toFixed(3)}% < ${policy.minRecentAveragePct.toFixed(3)}%`;
  }

  return { enabled: reason === 'edge proven', sample, recent, reason };
}

/** Chronological, no-lookahead replay of the same online decision policy. */
export function walkForwardMomentumSegment(
  rowsOldestFirst: MomentumSegmentRow[],
  layer: MomentumSegmentLayer,
  side: MomentumSegmentSide,
  policy: MomentumSegmentPolicy,
): MomentumSegmentStats {
  const selected: MomentumSegmentRow[] = [];
  const history: MomentumSegmentRow[] = [];
  for (const row of rowsOldestFirst) {
    const evaluation = evaluateMomentumSegment([...history].reverse(), layer, side, policy);
    if (row.layer === layer && row.side === side && evaluation.enabled) selected.push(row);
    history.push(row);
  }
  return stats(selected);
}

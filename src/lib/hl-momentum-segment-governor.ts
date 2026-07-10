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

export const CONFIRM_LONG_CANARY_POLICY: MomentumSegmentPolicy = {
  sampleSize: 40,
  recentSize: 20,
  minAveragePct: 0.03,
  minRecentAveragePct: 0,
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

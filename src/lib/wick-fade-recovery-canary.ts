export const WICK_FADE_RECOVERY_ENABLED_KEY = 'wick_fade_recovery_canary_enabled';
export const WICK_FADE_RECOVERY_STATE_KEY = 'wick_fade_recovery_canary_state';
export const WICK_FADE_RECOVERY_RESUME_APPROVED_KEY = 'wick_fade_recovery_full_resume_approved';
export const WICK_FADE_RECOVERY_ENTRY_REASON = 'recovery-canary';

export type WickFadeRecoveryStatus = 'active' | 'ready' | 'failed';

export type WickFadeRecoveryTrade = {
  pnlPct: number;
  netPnlUsd: number | null;
  closeReason: string | null;
  exact: boolean;
};

export type WickFadeRecoveryPolicy = {
  minTrades: number;
  maxTrades: number;
  minProfitFactor: number;
  maxConsecutiveStops: number;
};

export type WickFadeRecoveryEvaluation = {
  status: WickFadeRecoveryStatus;
  allowEntry: boolean;
  n: number;
  exactN: number;
  netPct: number;
  netPnlUsd: number;
  profitFactor: number | null;
  consecutiveStops: number;
  reason: string;
};

export type WickFadeRecoveryRuntimeState = WickFadeRecoveryEvaluation & {
  enabled: boolean;
  checkedAt: number;
  candidate: string | null;
  entryAllowed: boolean;
  driftReason: string | null;
};

export const WICK_FADE_RECOVERY_POLICY: WickFadeRecoveryPolicy = {
  minTrades: 5,
  maxTrades: 10,
  minProfitFactor: 1.1,
  maxConsecutiveStops: 2,
};

function stopLike(row: WickFadeRecoveryTrade): boolean {
  return row.pnlPct < 0 && (
    row.closeReason === 'catastrophe'
    || row.closeReason === 'daily-kill'
    || row.closeReason === 'reconciled-flat'
  );
}

export function evaluateWickFadeRecoveryCanary(
  rowsOldestFirst: WickFadeRecoveryTrade[],
  policy: WickFadeRecoveryPolicy = WICK_FADE_RECOVERY_POLICY,
): WickFadeRecoveryEvaluation {
  const rows = rowsOldestFirst.filter((row) => Number.isFinite(row.pnlPct));
  const exactRows = rows.filter((row) => row.exact && row.netPnlUsd != null && Number.isFinite(row.netPnlUsd));
  const netPct = exactRows.reduce((sum, row) => sum + row.pnlPct, 0);
  const netPnlUsd = exactRows.reduce((sum, row) => sum + (row.netPnlUsd ?? 0), 0);
  const grossProfit = exactRows.reduce((sum, row) => sum + Math.max(0, row.netPnlUsd ?? 0), 0);
  const grossLoss = exactRows.reduce((sum, row) => sum + Math.max(0, -(row.netPnlUsd ?? 0)), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  let consecutiveStops = 0;
  for (const row of [...exactRows].reverse()) {
    if (!stopLike(row)) break;
    consecutiveStops++;
  }

  const base = {
    n: rows.length,
    exactN: exactRows.length,
    netPct,
    netPnlUsd,
    profitFactor,
    consecutiveStops,
  };
  if (rows.length !== exactRows.length) {
    return {
      ...base,
      status: 'active',
      allowEntry: false,
      reason: `waiting for exact accounting ${exactRows.length}/${rows.length}`,
    };
  }
  if (consecutiveStops >= policy.maxConsecutiveStops) {
    return {
      ...base,
      status: 'failed',
      allowEntry: false,
      reason: `${consecutiveStops} consecutive stop-like losses`,
    };
  }
  const pfPasses = profitFactor == null ? netPnlUsd > 0 : profitFactor >= policy.minProfitFactor;
  if (rows.length >= policy.minTrades && netPnlUsd > 0 && netPct > 0 && pfPasses) {
    return {
      ...base,
      status: 'ready',
      allowEntry: false,
      reason: `manual review gate passed at ${rows.length} trades`,
    };
  }
  if (rows.length >= policy.maxTrades) {
    return {
      ...base,
      status: 'failed',
      allowEntry: false,
      reason: `evidence gate failed after ${rows.length} trades`,
    };
  }
  return {
    ...base,
    status: 'active',
    allowEntry: true,
    reason: `collecting exact recovery evidence ${rows.length}/${policy.minTrades}-${policy.maxTrades}`,
  };
}

export function recoveryCanaryHoldsGlobalPause(
  status: WickFadeRecoveryStatus | null,
  fullResumeApproved = false,
): boolean {
  return status !== null && !fullResumeApproved;
}

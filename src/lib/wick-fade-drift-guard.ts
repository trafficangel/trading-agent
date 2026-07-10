export type WickFadeDriftTrade = {
  pnlPct: number;
  netPnlUsd: number | null;
};

export type WickFadeDriftStats = {
  n: number;
  averagePct: number;
  sumPct: number;
  winRate: number;
  profitFactor: number | null;
};

export type WickFadeDriftPolicy = {
  fastWindow: number;
  slowWindow: number;
  pauseFastAveragePct: number;
  pauseFastProfitFactor: number;
  pauseSlowAveragePct: number;
  pauseSlowProfitFactor: number;
  resumeFastAveragePct: number;
  resumeFastProfitFactor: number;
  resumeSlowAveragePct: number;
  resumeSlowProfitFactor: number;
};

export type WickFadeDriftEvaluation = {
  blocked: boolean;
  stage: 'live' | 'paused';
  reason: string;
  fast: WickFadeDriftStats;
  slow: WickFadeDriftStats;
};

export type WickFadeDriftRuntimeState = WickFadeDriftEvaluation & {
  checkedAt: number;
  changedAt: number;
};

export const WICK_FADE_DRIFT_STATE_KEY = 'wick_fade_drift_guard_state';
export const WICK_FADE_DRIFT_STALE_MS = 10 * 60_000;

export const WICK_FADE_DRIFT_POLICY: WickFadeDriftPolicy = {
  fastWindow: 20,
  slowWindow: 40,
  pauseFastAveragePct: -0.15,
  pauseFastProfitFactor: 0.75,
  pauseSlowAveragePct: -0.10,
  pauseSlowProfitFactor: 0.85,
  resumeFastAveragePct: 0.03,
  resumeFastProfitFactor: 1.05,
  resumeSlowAveragePct: 0,
  resumeSlowProfitFactor: 1,
};

export function wickFadeDriftBlockReason(raw: string | undefined, nowMs: number): string | null {
  if (!raw) return 'drift guard is initializing';
  try {
    const state = JSON.parse(raw) as WickFadeDriftRuntimeState;
    if (!state.checkedAt || nowMs - state.checkedAt > WICK_FADE_DRIFT_STALE_MS) return 'drift guard state is stale';
    return state.blocked ? state.reason : null;
  } catch {
    return 'drift guard state is invalid';
  }
}

function stats(rows: WickFadeDriftTrade[]): WickFadeDriftStats {
  if (rows.length === 0) return { n: 0, averagePct: 0, sumPct: 0, winRate: 0, profitFactor: null };
  const sumPct = rows.reduce((sum, row) => sum + row.pnlPct, 0);
  let grossProfit = 0;
  let grossLoss = 0;
  for (const row of rows) {
    const value = row.netPnlUsd ?? row.pnlPct;
    if (value > 0) grossProfit += value;
    else if (value < 0) grossLoss += Math.abs(value);
  }
  return {
    n: rows.length,
    averagePct: sumPct / rows.length,
    sumPct,
    winRate: rows.filter((row) => row.pnlPct > 0).length / rows.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}

function pfPasses(value: number | null, minimum: number, sumPct: number): boolean {
  return value == null ? sumPct > 0 : value >= minimum;
}

function fmt(statsValue: WickFadeDriftStats): string {
  const pf = statsValue.profitFactor == null ? (statsValue.sumPct > 0 ? 'inf' : 'na') : statsValue.profitFactor.toFixed(2);
  return `n=${statsValue.n} avg=${statsValue.averagePct.toFixed(3)}% PF=${pf}`;
}

/** Rows must be newest first. A paused book needs stronger recovery evidence than the pause threshold. */
export function evaluateWickFadeDriftGuard(
  rows: WickFadeDriftTrade[],
  wasBlocked: boolean,
  policy: WickFadeDriftPolicy = WICK_FADE_DRIFT_POLICY,
): WickFadeDriftEvaluation {
  const fast = stats(rows.slice(0, policy.fastWindow));
  const slow = stats(rows.slice(0, policy.slowWindow));
  if (slow.n < policy.slowWindow) {
    return { blocked: true, stage: 'paused', reason: `exact sample ${slow.n}/${policy.slowWindow}`, fast, slow };
  }

  const fastTrip = fast.averagePct <= policy.pauseFastAveragePct
    || !pfPasses(fast.profitFactor, policy.pauseFastProfitFactor, fast.sumPct);
  const slowTrip = slow.averagePct <= policy.pauseSlowAveragePct
    || !pfPasses(slow.profitFactor, policy.pauseSlowProfitFactor, slow.sumPct);
  if (!wasBlocked && (fastTrip || slowTrip)) {
    const window = fastTrip ? `fast ${fmt(fast)}` : `slow ${fmt(slow)}`;
    return { blocked: true, stage: 'paused', reason: `rolling deterioration: ${window}`, fast, slow };
  }

  if (wasBlocked) {
    const fastRecovered = fast.averagePct >= policy.resumeFastAveragePct
      && pfPasses(fast.profitFactor, policy.resumeFastProfitFactor, fast.sumPct);
    const slowRecovered = slow.averagePct >= policy.resumeSlowAveragePct
      && pfPasses(slow.profitFactor, policy.resumeSlowProfitFactor, slow.sumPct);
    if (!fastRecovered || !slowRecovered) {
      return { blocked: true, stage: 'paused', reason: `recovery not proven: fast ${fmt(fast)}; slow ${fmt(slow)}`, fast, slow };
    }
  }

  return { blocked: false, stage: 'live', reason: `rolling edge healthy: fast ${fmt(fast)}; slow ${fmt(slow)}`, fast, slow };
}

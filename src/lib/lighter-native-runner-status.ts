export const LIGHTER_NATIVE_RUNNER_STATUS_KEY = 'lighter_native_runner_status_v1';

export type NativeRunnerEvaluationState =
  | 'waiting'
  | 'signal_emitted'
  | 'position_open'
  | 'exit_emitted'
  | 'same_bar_reentry_blocked'
  | 'entry_disabled'
  | 'data_error'
  | 'evaluation_error';

export type NativeRunnerEvaluation = {
  strategyId: string;
  symbol: string;
  marketId: number;
  family: 'zscore' | 'vwz';
  mode: 'touch' | 'reclaim';
  threshold: number;
  trendFilter: 'ema200' | 'ema200_400' | null;
  attemptedBarTime: number;
  barTime: number | null;
  evaluatedAt: number;
  state: NativeRunnerEvaluationState;
  reason: string;
  side: 'long' | 'short' | null;
  close: number | null;
  mean: number | null;
  previousZ: number | null;
  currentZ: number | null;
  trendMean: number | null;
  slowTrendMean: number | null;
  efficiencyRatio60: number | null;
  error: string | null;
};

export type NativeRunnerStatus = {
  version: 1;
  heartbeatAt: number;
  targetBarTime: number;
  evaluations: NativeRunnerEvaluation[];
};

type WaitingReasonInput = {
  mode: 'touch' | 'reclaim';
  threshold: number;
  previousZ: number;
  currentZ: number;
  close: number;
  trendMean?: number;
  slowTrendMean?: number;
};

/**
 * Explain a completed-bar no-entry decision without changing the decision.
 * The runner stores this alongside the latest evaluation so an operator can
 * distinguish a healthy quiet strategy from a dead data path.
 */
export function nativeWaitingReason(input: WaitingReasonInput): string {
  const hasStack = input.trendMean != null && input.slowTrendMean != null;
  const hasSingleTrend = input.trendMean != null && input.slowTrendMean == null;

  if (input.mode === 'reclaim') {
    if (input.currentZ < -input.threshold || input.currentZ > input.threshold) {
      return 'waiting_reclaim';
    }
    return 'z_inside_threshold';
  }

  if (input.currentZ < -input.threshold) {
    if (
      hasStack
      && !(input.close > input.trendMean! && input.trendMean! > input.slowTrendMean!)
    ) return 'long_trend_stack_not_aligned';
    if (hasSingleTrend && !(input.close > input.trendMean!)) {
      return 'long_trend_not_aligned';
    }
    return 'long_setup_ready';
  }
  if (input.currentZ > input.threshold) {
    if (
      hasStack
      && !(input.close < input.trendMean! && input.trendMean! < input.slowTrendMean!)
    ) return 'short_trend_stack_not_aligned';
    if (hasSingleTrend && !(input.close < input.trendMean!)) {
      return 'short_trend_not_aligned';
    }
    return 'short_setup_ready';
  }
  return 'z_inside_threshold';
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const STATES = new Set<NativeRunnerEvaluationState>([
  'waiting',
  'signal_emitted',
  'position_open',
  'exit_emitted',
  'same_bar_reentry_blocked',
  'entry_disabled',
  'data_error',
  'evaluation_error',
]);

/** Fail closed on malformed operational state; the page must never imply a
 * live runner from partially valid or stale JSON. */
export function parseNativeRunnerStatus(raw: string | null): NativeRunnerStatus | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<NativeRunnerStatus>;
    if (
      value.version !== 1
      || finiteOrNull(value.heartbeatAt) == null
      || finiteOrNull(value.targetBarTime) == null
      || !Array.isArray(value.evaluations)
    ) return null;
    const evaluations: NativeRunnerEvaluation[] = [];
    for (const row of value.evaluations as Partial<NativeRunnerEvaluation>[]) {
      if (
        typeof row.strategyId !== 'string'
        || typeof row.symbol !== 'string'
        || finiteOrNull(row.marketId) == null
        || (row.family !== 'zscore' && row.family !== 'vwz')
        || (row.mode !== 'touch' && row.mode !== 'reclaim')
        || finiteOrNull(row.threshold) == null
        || !(row.threshold! > 0)
        || (row.trendFilter != null
          && row.trendFilter !== 'ema200'
          && row.trendFilter !== 'ema200_400')
        || finiteOrNull(row.attemptedBarTime) == null
        || finiteOrNull(row.evaluatedAt) == null
        || typeof row.state !== 'string'
        || !STATES.has(row.state as NativeRunnerEvaluationState)
        || typeof row.reason !== 'string'
      ) return null;
      const side = row.side === 'long' || row.side === 'short' ? row.side : null;
      evaluations.push({
        strategyId: row.strategyId,
        symbol: row.symbol,
        marketId: row.marketId!,
        family: row.family,
        mode: row.mode,
        threshold: row.threshold!,
        trendFilter: row.trendFilter ?? null,
        attemptedBarTime: row.attemptedBarTime!,
        barTime: finiteOrNull(row.barTime),
        evaluatedAt: row.evaluatedAt!,
        state: row.state as NativeRunnerEvaluationState,
        reason: row.reason,
        side,
        close: finiteOrNull(row.close),
        mean: finiteOrNull(row.mean),
        previousZ: finiteOrNull(row.previousZ),
        currentZ: finiteOrNull(row.currentZ),
        trendMean: finiteOrNull(row.trendMean),
        slowTrendMean: finiteOrNull(row.slowTrendMean),
        efficiencyRatio60: finiteOrNull(row.efficiencyRatio60),
        error: typeof row.error === 'string' ? row.error : null,
      });
    }
    return {
      version: 1,
      heartbeatAt: value.heartbeatAt!,
      targetBarTime: value.targetBarTime!,
      evaluations,
    };
  } catch {
    return null;
  }
}

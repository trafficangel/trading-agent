export const LIGHTER_NATIVE_RUNNER_STATUS_KEY = 'lighter_native_runner_status_v1';
export const NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS = 90_000;

export type NativeRunnerEvaluationState =
  | 'waiting'
  | 'signal_emitted'
  | 'position_open'
  | 'exit_emitted'
  | 'same_bar_reentry_blocked'
  | 'data_error'
  | 'evaluation_error';

export type NativeRunnerEvaluation = {
  strategyId: string;
  symbol: string;
  marketId: number;
  timeframeMinutes: 1 | 5;
  family: 'zscore' | 'vwz' | 'rsi' | 'rsi_mfi' | 'rsi_williams' | 'vwz_mfi' | 'vwz_williams' | 'vwz_stochastic' | 'bb_williams_reclaim';
  mode: 'touch' | 'reclaim';
  threshold: number;
  trendFilter: 'ema200' | 'ema400' | 'ema200_400' | null;
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
  previousRsi: number | null;
  currentRsi: number | null;
  secondaryOscillator: number | null;
  error: string | null;
};

export type NativeRunnerStatus = {
  version: 1;
  heartbeatAt: number;
  targetBarTime: number;
  evaluations: NativeRunnerEvaluation[];
};

export type NativeRunnerLivenessEvaluation = {
  passed: boolean;
  checkedAt: number;
  heartbeatAgeMs: number | null;
  requiredStrategyIds: readonly string[];
  healthyStrategyIds: readonly string[];
  reasons: readonly string[];
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

export function nativeRsiWaitingReason(input: {
  level: number;
  currentRsi: number;
  close: number;
  trendMean: number;
}): string {
  if (input.currentRsi < input.level) {
    return input.close > input.trendMean
      ? 'long_setup_ready'
      : 'long_trend_not_aligned';
  }
  if (input.currentRsi > 100 - input.level) {
    return input.close < input.trendMean
      ? 'short_setup_ready'
      : 'short_trend_not_aligned';
  }
  return 'rsi_inside_threshold';
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
        || (row.timeframeMinutes != null
          && row.timeframeMinutes !== 1
          && row.timeframeMinutes !== 5)
        || (row.family !== 'zscore'
          && row.family !== 'vwz'
          && row.family !== 'rsi'
          && row.family !== 'rsi_williams'
          && row.family !== 'vwz_mfi'
          && row.family !== 'vwz_williams'
          && row.family !== 'vwz_stochastic'
          && row.family !== 'bb_williams_reclaim')
        || (row.mode !== 'touch' && row.mode !== 'reclaim')
        || finiteOrNull(row.threshold) == null
        || !(row.threshold! > 0)
        || (row.trendFilter != null
          && row.trendFilter !== 'ema200'
          && row.trendFilter !== 'ema400'
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
        timeframeMinutes: row.timeframeMinutes ?? 5,
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
        previousRsi: finiteOrNull(row.previousRsi),
        currentRsi: finiteOrNull(row.currentRsi),
        secondaryOscillator: finiteOrNull(row.secondaryOscillator),
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

/**
 * Fail-closed operational proof shared by the promotion audit. A fresh global
 * heartbeat alone is insufficient: every strategy must have a current,
 * successfully evaluated completed bar. The wider per-bar age allowance is
 * intentional because a 5m decision remains current until the next 5m bar.
 */
export function evaluateNativeRunnerLiveness(
  status: NativeRunnerStatus | null,
  requiredStrategyIds: readonly string[],
  nowMs: number,
): NativeRunnerLivenessEvaluation {
  const required = [...new Set(requiredStrategyIds)].sort();
  const reasons: string[] = [];
  if (!status) return {
    passed: false,
    checkedAt: nowMs,
    heartbeatAgeMs: null,
    requiredStrategyIds: required,
    healthyStrategyIds: [],
    reasons: ['runner status unavailable'],
  };

  const heartbeatAgeMs = nowMs - status.heartbeatAt;
  if (heartbeatAgeMs < -300_000) reasons.push('runner heartbeat is in the future');
  if (heartbeatAgeMs > NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS) {
    reasons.push(
      `runner heartbeat age ${heartbeatAgeMs}ms > ${NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS}ms`,
    );
  }

  const healthyStrategyIds: string[] = [];
  for (const strategyId of required) {
    const matching = status.evaluations.filter((row) => row.strategyId === strategyId);
    if (matching.length !== 1) {
      reasons.push(`${strategyId}: evaluation missing or duplicated`);
      continue;
    }
    const row = matching[0]!;
    const timeframeMs = row.timeframeMinutes * 60_000;
    const maxEvaluationAgeMs = timeframeMs + NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS;
    const maxBarAgeMs = 2 * timeframeMs + NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS;
    const evaluationAgeMs = nowMs - row.evaluatedAt;
    const barAgeMs = nowMs - row.attemptedBarTime;
    const rowReasons: string[] = [];
    if (evaluationAgeMs < -300_000 || barAgeMs < -300_000) {
      rowReasons.push('evaluation is in the future');
    }
    if (evaluationAgeMs > maxEvaluationAgeMs) {
      rowReasons.push(`evaluation age ${evaluationAgeMs}ms > ${maxEvaluationAgeMs}ms`);
    }
    if (barAgeMs > maxBarAgeMs) {
      rowReasons.push(`decision bar age ${barAgeMs}ms > ${maxBarAgeMs}ms`);
    }
    if (row.barTime !== row.attemptedBarTime) {
      rowReasons.push('latest attempted bar was not evaluated');
    }
    if (row.state === 'data_error' || row.state === 'evaluation_error' || row.error != null) {
      rowReasons.push(`runner state ${row.state}${row.error ? `: ${row.error}` : ''}`);
    }
    if (rowReasons.length) {
      reasons.push(`${strategyId}: ${rowReasons.join('; ')}`);
    } else {
      healthyStrategyIds.push(strategyId);
    }
  }

  return {
    passed: reasons.length === 0,
    checkedAt: nowMs,
    heartbeatAgeMs,
    requiredStrategyIds: required,
    healthyStrategyIds,
    reasons,
  };
}

export type MomentumConfidenceSignal = {
  layer: 'fast' | 'confirm';
  score: number;
  prob: number;
  expectedPnl: number;
};

export type MomentumConfidenceThresholds = {
  minScore: number;
  minProb: number;
  minExpectedPnl: number;
};

export const DEFAULT_MOMENTUM_CONFIDENCE_THRESHOLDS: MomentumConfidenceThresholds = {
  minScore: 96,
  minProb: 0.60,
  minExpectedPnl: 0.25,
};

export function isConfidentMomentumSignal(
  signal: MomentumConfidenceSignal,
  thresholds: MomentumConfidenceThresholds = DEFAULT_MOMENTUM_CONFIDENCE_THRESHOLDS,
): boolean {
  return signal.layer === 'confirm'
    && signal.score >= thresholds.minScore
    && signal.prob >= thresholds.minProb
    && signal.expectedPnl >= thresholds.minExpectedPnl;
}

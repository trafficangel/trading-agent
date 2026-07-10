export const HL_MOMENTUM_CALIBRATION_VERSION = 'robust-residual-v1';

export type CalibrationObservation = {
  pnlPct: number;
  rawProb: number;
  rawExpectedPnl: number;
};

export type RobustCalibration = {
  n: number;
  actualWr: number;
  avgRawProb: number;
  avgActualPnl: number;
  avgRawExpectedPnl: number;
  brier: number;
  robustEvResidual: number;
  residualMedian: number;
  residualCap: number;
  targetProbBias: number;
  targetEvBias: number;
};

export type CalibrationOptions = {
  priorN?: number;
  evPriorN?: number;
  minResidualCap?: number;
  maxResidualCap?: number;
  probBiasMin?: number;
  probBiasMax?: number;
  evBiasMin?: number;
  evBiasMax?: number;
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const mean = (xs: number[]): number => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function robustCalibration(
  observations: CalibrationObservation[],
  options: CalibrationOptions = {},
): RobustCalibration {
  const priorN = options.priorN ?? 40;
  const evPriorN = options.evPriorN ?? 40;
  const minResidualCap = options.minResidualCap ?? 0.20;
  const maxResidualCap = options.maxResidualCap ?? 0.75;
  const probBiasMin = options.probBiasMin ?? -0.08;
  const probBiasMax = options.probBiasMax ?? 0.05;
  const evBiasMin = options.evBiasMin ?? -0.50;
  const evBiasMax = options.evBiasMax ?? 0.30;

  const rows = observations.filter((r) =>
    Number.isFinite(r.pnlPct)
    && Number.isFinite(r.rawProb)
    && Number.isFinite(r.rawExpectedPnl),
  );
  const n = rows.length;
  if (!n) {
    return {
      n: 0,
      actualWr: 0,
      avgRawProb: 0,
      avgActualPnl: 0,
      avgRawExpectedPnl: 0,
      brier: 0,
      robustEvResidual: 0,
      residualMedian: 0,
      residualCap: minResidualCap,
      targetProbBias: 0,
      targetEvBias: 0,
    };
  }

  const outcomes = rows.map((r) => r.pnlPct > 0 ? 1 : 0);
  const rawProbs = rows.map((r) => clamp(r.rawProb, 0, 1));
  const residuals = rows.map((r) => r.pnlPct - r.rawExpectedPnl);
  const residualMedian = median(residuals);
  const mad = median(residuals.map((r) => Math.abs(r - residualMedian)));
  const residualCap = clamp(2.5 * 1.4826 * mad, minResidualCap, maxResidualCap);
  const robustEvResidual = mean(residuals.map((r) =>
    clamp(r, residualMedian - residualCap, residualMedian + residualCap),
  ));
  const avgRawProb = mean(rawProbs);
  const actualWr = mean(outcomes);
  const probShrink = n / (n + Math.max(0, priorN));
  const evShrink = n / (n + Math.max(0, evPriorN));

  return {
    n,
    actualWr,
    avgRawProb,
    avgActualPnl: mean(rows.map((r) => r.pnlPct)),
    avgRawExpectedPnl: mean(rows.map((r) => r.rawExpectedPnl)),
    brier: mean(rows.map((r, i) => (rawProbs[i]! - outcomes[i]!) ** 2)),
    robustEvResidual,
    residualMedian,
    residualCap,
    targetProbBias: clamp((actualWr - avgRawProb) * probShrink, probBiasMin, probBiasMax),
    targetEvBias: clamp(robustEvResidual * evShrink, evBiasMin, evBiasMax),
  };
}

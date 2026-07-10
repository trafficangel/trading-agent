export type MomentumExecutionSide = 'long' | 'short';

export type MomentumIntrabarPosition = {
  side: MomentumExecutionSide;
  entryPx: number;
  openedAt: number;
};

export type MomentumIntrabarRisk = {
  stopPct: number;
  trailActivatePct: number;
  trailGivebackPct: number;
  trailMinLockPct: number;
};

export type MomentumIntrabarPolicy = {
  holdMs: number;
  trailHoldMs: number;
  decayExitMs: number;
  decayMinMfeR: number;
  decayLossR: number;
};

export type MomentumIntrabarTrail = {
  active: boolean;
  bestPx: number;
  movePct: number;
  trailPx: number | null;
};

export type MomentumIntrabarExitReason =
  | 'fast-stop'
  | 'fast-trailing-stop'
  | 'fast-momentum-decay'
  | 'fast-time-stop';

export type MomentumIntrabarEvaluation = {
  bestPx: number;
  trail: MomentumIntrabarTrail;
  exitReason: MomentumIntrabarExitReason | null;
};

export const HL_MOMENTUM_COST_RT_PCT = 0.09;
export const HL_MOMENTUM_FAST_EXECUTION_VERSION = 'fast-intrabar-v2';
export const HL_MOMENTUM_FAST_EXECUTION_TAG = `execution=${HL_MOMENTUM_FAST_EXECUTION_VERSION}`;
export const HL_MOMENTUM_FAST_LONG_CANARY_TAG = 'canary=fast-long-v2';

export const HL_MOMENTUM_INTRABAR_POLICY: MomentumIntrabarPolicy = {
  holdMs: 30 * 60_000,
  trailHoldMs: 60 * 60_000,
  decayExitMs: 6 * 60_000,
  decayMinMfeR: 0.35,
  decayLossR: 0.30,
};

function favorableMove(position: MomentumIntrabarPosition, px: number): number {
  return position.side === 'long'
    ? (px - position.entryPx) / position.entryPx
    : (position.entryPx - px) / position.entryPx;
}

export function momentumNetPnlPct(
  side: MomentumExecutionSide,
  entryPx: number,
  exitPx: number,
  costRtPct = HL_MOMENTUM_COST_RT_PCT,
): number {
  const gross = side === 'long'
    ? ((exitPx - entryPx) / entryPx) * 100
    : ((entryPx - exitPx) / entryPx) * 100;
  return gross - costRtPct;
}

/** One exit evaluator is shared by fast paper and live management. */
export function evaluateMomentumIntrabar(
  position: MomentumIntrabarPosition,
  mid: number,
  nowMs: number,
  risk: MomentumIntrabarRisk,
  previousBestPx = position.entryPx,
  policy: MomentumIntrabarPolicy = HL_MOMENTUM_INTRABAR_POLICY,
): MomentumIntrabarEvaluation {
  const bestPx = position.side === 'long'
    ? Math.max(previousBestPx, mid)
    : Math.min(previousBestPx, mid);
  const move = favorableMove(position, bestPx);
  const active = move >= risk.trailActivatePct;
  const trailPx = active
    ? position.side === 'long'
      ? Math.max(position.entryPx * (1 + risk.trailMinLockPct), bestPx * (1 - risk.trailGivebackPct))
      : Math.min(position.entryPx * (1 - risk.trailMinLockPct), bestPx * (1 + risk.trailGivebackPct))
    : null;
  const trail = { active, bestPx, movePct: move * 100, trailPx };

  const stopPx = position.side === 'long'
    ? position.entryPx * (1 - risk.stopPct)
    : position.entryPx * (1 + risk.stopPct);
  const stopHit = position.side === 'long' ? mid <= stopPx : mid >= stopPx;
  const trailHit = active && trailPx != null
    ? position.side === 'long' ? mid <= trailPx : mid >= trailPx
    : false;
  const ageMs = nowMs - position.openedAt;
  const decayed = ageMs >= policy.decayExitMs
    && move < risk.stopPct * policy.decayMinMfeR
    && favorableMove(position, mid) <= -risk.stopPct * policy.decayLossR;
  const timed = ageMs >= (active ? policy.trailHoldMs : policy.holdMs);

  const exitReason = stopHit
    ? 'fast-stop'
    : trailHit
      ? 'fast-trailing-stop'
      : decayed
        ? 'fast-momentum-decay'
        : timed
          ? 'fast-time-stop'
          : null;
  return { bestPx, trail, exitReason };
}

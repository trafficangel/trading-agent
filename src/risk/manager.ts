import type { Decision } from '../llm/decision.schema.js';

export type RiskCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

export type RiskLimits = {
  /** Max size_pct allowed (e.g. 2.0). */
  maxSizePct: number;
  /** Min SL distance as % of entry. */
  minSlDistPct: number;
  /** Max SL distance as % of entry. */
  maxSlDistPct: number;
  /** Minimum R:R ratio for TP1 (TP1 distance / SL distance). */
  minRR: number;
};

export const DEFAULT_LIMITS: RiskLimits = {
  maxSizePct: 2.0,
  minSlDistPct: 0.2,
  maxSlDistPct: 5.0,
  minRR: 1.5,
};

/**
 * Stage-2 risk gate. Stage 2 doesn't place orders, so this is purely advisory
 * — but we already enforce the same logic that Stage 3 will use, so when we
 * flip the executor on, no surprises.
 */
export function checkDecision(d: Decision, limits: RiskLimits = DEFAULT_LIMITS): RiskCheckResult {
  if (d.decision !== 'OPEN') return { ok: true };

  if (!d.side || !d.entry || !d.sl || d.size_pct === undefined) {
    return { ok: false, reason: 'OPEN missing side/entry/sl/size_pct' };
  }

  // SL distance sanity
  const slDistPct = (Math.abs(d.entry - d.sl) / d.entry) * 100;
  if (slDistPct < limits.minSlDistPct) return { ok: false, reason: `SL too tight: ${slDistPct.toFixed(2)}%` };
  if (slDistPct > limits.maxSlDistPct) return { ok: false, reason: `SL too wide: ${slDistPct.toFixed(2)}%` };

  // Direction sanity
  if (d.side === 'long' && d.sl >= d.entry) {
    return { ok: false, reason: 'long SL must be below entry' };
  }
  if (d.side === 'short' && d.sl <= d.entry) {
    return { ok: false, reason: 'short SL must be above entry' };
  }

  // Size cap
  if (d.size_pct > limits.maxSizePct) {
    return { ok: false, reason: `size_pct ${d.size_pct} exceeds cap ${limits.maxSizePct}` };
  }

  // TP1 R:R >= configured minimum (default 1.5)
  if (d.tp.length === 0) return { ok: false, reason: 'no TP set' };
  const tp1 = d.tp[0]!;
  const slDist = Math.abs(d.entry - d.sl);
  const tp1Dist = Math.abs(tp1 - d.entry);
  const rr = tp1Dist / slDist;
  if (rr < limits.minRR) {
    return {
      ok: false,
      reason: `TP1 R:R = ${rr.toFixed(2)} < ${limits.minRR} required`,
    };
  }

  // TP1 direction sanity
  if (d.side === 'long' && tp1 <= d.entry) return { ok: false, reason: 'long TP1 must be above entry' };
  if (d.side === 'short' && tp1 >= d.entry) return { ok: false, reason: 'short TP1 must be below entry' };

  return { ok: true };
}

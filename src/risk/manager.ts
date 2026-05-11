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
  /** Min SL distance as multiple of ATR(14) on 15m. Below this, noise wicks
   *  the SL out before the thesis plays. Default 0.7. */
  minSlAtrMult: number;
  /** Max SL distance as multiple of ATR(14) on 15m. Beyond this the R:R
   *  becomes fictional — TP at 1.5× of a giant SL is unrealistic to hit.
   *  Default 4.0. */
  maxSlAtrMult: number;
};

export const DEFAULT_LIMITS: RiskLimits = {
  maxSizePct: 2.0,
  minSlDistPct: 0.2,
  maxSlDistPct: 5.0,
  minRR: 1.5,
  minSlAtrMult: 0.7,
  maxSlAtrMult: 4.0,
};

/**
 * Stage-2 risk gate. Stage 2 doesn't place orders, so this is currently
 * PURELY ADVISORY — `checkDecision()` returns `{ok: false, reason}`, the
 * caller writes that into the audit row, but the OPEN post STILL goes to
 * Telegram (just with the reason appended to the caption). Risk gate does
 * NOT block downstream actions in shadow mode.
 *
 * IMPORTANT (TODO for Stage 3 / live executor):
 *   Before flipping the executor to real orders, the code that calls
 *   `placeOrder()` MUST check `if (!riskGate.ok) skip` and abort the trade.
 *   See decide.ts where `riskGate` is computed but only used decoratively.
 *   Audit row is fine to write either way — but no ORDER without ok.
 *
 * `atr15m` is optional: when provided, we additionally check SL distance
 * against ATR(14) on 15m to catch noise-prone tight SLs and fictional-R:R
 * wide SLs. Pass null/undefined to skip the ATR check (e.g. if Bybit volume
 * fetch failed — we don't want to block a sane trade just because we
 * couldn't measure ATR).
 */
export function checkDecision(
  d: Decision,
  limits: RiskLimits = DEFAULT_LIMITS,
  atr15m?: number | null,
): RiskCheckResult {
  if (d.decision !== 'OPEN') return { ok: true };

  if (!d.side || !d.entry || !d.sl || d.size_pct === undefined) {
    return { ok: false, reason: 'OPEN missing side/entry/sl/size_pct' };
  }

  // SL distance sanity (% of entry)
  const slDist = Math.abs(d.entry - d.sl);
  const slDistPct = (slDist / d.entry) * 100;
  if (slDistPct < limits.minSlDistPct) return { ok: false, reason: `SL too tight: ${slDistPct.toFixed(2)}%` };
  if (slDistPct > limits.maxSlDistPct) return { ok: false, reason: `SL too wide: ${slDistPct.toFixed(2)}%` };

  // SL distance vs ATR (skip if ATR not provided)
  if (atr15m && atr15m > 0) {
    const slMult = slDist / atr15m;
    if (slMult < limits.minSlAtrMult) {
      return {
        ok: false,
        reason: `SL ${slMult.toFixed(2)}×ATR — too tight (noise risk; min ${limits.minSlAtrMult}×ATR)`,
      };
    }
    if (slMult > limits.maxSlAtrMult) {
      return {
        ok: false,
        reason: `SL ${slMult.toFixed(2)}×ATR — too wide (fictional R:R; max ${limits.maxSlAtrMult}×ATR)`,
      };
    }
  }

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

/**
 * Pure PnL math, no DB / config dependencies — safe to import from
 * tests and from any code path. Extracted from src/db/repos/decisions.ts
 * (where it lived next to the schema for historical reasons) during
 * audit C1 — see tests/unit/calc-pnl.test.ts.
 *
 * Signature contract: calcPnl(side, entry, sl, closePrice).
 *   - pnlPct: side-adjusted percent move from entry to close
 *   - pnlR:   in R-multiples (1R = SL distance from entry)
 *
 * Sign rule: long profits when closePrice > entry, short profits when
 * closePrice < entry. pnlR sign follows pnlPct sign. Zero SL distance
 * returns pnlR=0 (avoid div-by-zero); pnlPct still meaningful.
 */

export function calcPnl(
  side: 'long' | 'short',
  entry: number,
  sl: number,
  closePrice: number,
): { pnlPct: number; pnlR: number } {
  const dir = side === 'long' ? 1 : -1;
  const pnlPct = ((closePrice - entry) / entry) * 100 * dir;
  const slDist = Math.abs(entry - sl);
  if (slDist === 0) {
    return {
      pnlPct: Math.round(pnlPct * 100) / 100,
      pnlR: 0,
    };
  }
  const pnlDist = Math.abs(closePrice - entry);
  const sign = pnlPct >= 0 ? 1 : -1;
  const pnlR = sign * (pnlDist / slDist);
  return {
    pnlPct: Math.round(pnlPct * 100) / 100,
    pnlR: Math.round(pnlR * 100) / 100,
  };
}

export type ArbLegSide = 'long' | 'short';
export type ArbBasisDirection = 'LONG HL / SHORT BY' | 'LONG BY / SHORT HL';

export function sidesForBasisDirection(direction: ArbBasisDirection): {
  hl: ArbLegSide;
  bybit: ArbLegSide;
} {
  return direction === 'LONG HL / SHORT BY'
    ? { hl: 'long', bybit: 'short' }
    : { hl: 'short', bybit: 'long' };
}

function decimalPlaces(step: string): number {
  const normalized = step.toLowerCase();
  if (normalized.includes('e-')) return Number(normalized.split('e-')[1] ?? 0);
  const dot = normalized.indexOf('.');
  return dot < 0 ? 0 : normalized.length - dot - 1;
}

export function quantizeToStep(value: number, step: string, mode: 'floor' | 'ceil' = 'floor'): number {
  const increment = Number(step);
  if (!(value > 0) || !(increment > 0)) return 0;
  const scaled = value / increment;
  const units = mode === 'ceil' ? Math.ceil(scaled - 1e-10) : Math.floor(scaled + 1e-10);
  return Number((units * increment).toFixed(decimalPlaces(step)));
}

export function underlyingDeltaMismatchPct(
  hlQty: number,
  hlUnit: number,
  bybitQty: number,
  bybitUnit: number,
): number {
  const hlUnderlying = hlQty * hlUnit;
  const bybitUnderlying = bybitQty * bybitUnit;
  const average = (hlUnderlying + bybitUnderlying) / 2;
  return average > 0 ? Math.abs(hlUnderlying - bybitUnderlying) / average * 100 : Infinity;
}

export function estimatedBasisNetFromFills(args: {
  direction: ArbBasisDirection;
  hlEntryPx: number;
  hlUnit: number;
  bybitEntryPx: number;
  bybitUnit: number;
  totalCostPct: number;
}): number {
  const hlUnderlying = args.hlEntryPx / args.hlUnit;
  const bybitUnderlying = args.bybitEntryPx / args.bybitUnit;
  const average = (hlUnderlying + bybitUnderlying) / 2;
  if (!(average > 0)) return Number.NaN;
  const gross = args.direction === 'LONG HL / SHORT BY'
    ? (bybitUnderlying - hlUnderlying) / average * 100
    : (hlUnderlying - bybitUnderlying) / average * 100;
  return gross - args.totalCostPct;
}

function legReturnPct(side: ArbLegSide, entryPx: number, exitPx: number): number {
  if (!(entryPx > 0) || !(exitPx > 0)) return Number.NaN;
  return side === 'long'
    ? (exitPx - entryPx) / entryPx * 100
    : (entryPx - exitPx) / entryPx * 100;
}

/** Pair PnL relative to one leg's notional. Four taker fills cost 0.20% at base fees. */
export function estimatedPairNetPnlPct(args: {
  hlSide: ArbLegSide;
  hlEntryPx: number;
  hlExitPx: number;
  bybitSide: ArbLegSide;
  bybitEntryPx: number;
  bybitExitPx: number;
  roundTripFeesPct?: number;
}): number {
  return legReturnPct(args.hlSide, args.hlEntryPx, args.hlExitPx)
    + legReturnPct(args.bybitSide, args.bybitEntryPx, args.bybitExitPx)
    - (args.roundTripFeesPct ?? 0.20);
}

export function arbExitReason(args: {
  netPnlPct: number;
  openedAt: number;
  nowMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMs: number;
}): 'take-profit' | 'basis-stop' | 'max-hold' | null {
  if (args.netPnlPct >= args.takeProfitPct) return 'take-profit';
  if (args.netPnlPct <= args.stopLossPct) return 'basis-stop';
  if (args.nowMs - args.openedAt >= args.maxHoldMs) return 'max-hold';
  return null;
}

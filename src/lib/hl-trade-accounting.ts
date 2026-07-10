export type HlAccountingFill = {
  time: number;
  px: number;
  sz: number;
  side: 'B' | 'A';
  dir: string;
  startPosition: number;
  closedPnl: number;
  fee: number;
};

export type HlAccountingFunding = {
  time: number;
  usdc: number;
};

export type HlTradeAccounting = {
  entryTime: number;
  exitTime: number | null;
  entryAvgPx: number;
  exitAvgPx: number | null;
  entryQty: number;
  exitQty: number;
  entryNotionalUsd: number;
  exitNotionalUsd: number;
  grossPnlUsd: number;
  feesUsd: number;
  fundingUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  fillCount: number;
  complete: boolean;
};

const ENTRY_LOOKBACK_MS = 60_000;
const ENTRY_CONFIRM_GRACE_MS = 15_000;

export function calculateHlTradeAccounting(
  fills: HlAccountingFill[],
  funding: HlAccountingFunding[],
  recordedOpenedAt: number,
): HlTradeAccounting | null {
  const sorted = fills
    .filter((f) => Number.isFinite(f.time) && f.px > 0 && f.sz > 0)
    .sort((a, b) => a.time - b.time);
  const candidates = sorted
    .map((fill, index) => ({ fill, index }))
    .filter(({ fill }) =>
      fill.dir.toLowerCase().includes('open')
      && Math.abs(fill.startPosition) < 1e-9
      && fill.time >= recordedOpenedAt - ENTRY_LOOKBACK_MS
      && fill.time <= recordedOpenedAt + ENTRY_CONFIRM_GRACE_MS,
    );
  if (!candidates.length) return null;
  const entryIndex = candidates.reduce((best, candidate) =>
    Math.abs(candidate.fill.time - recordedOpenedAt) < Math.abs(best.fill.time - recordedOpenedAt)
      ? candidate
      : best,
  ).index;

  const tradeFills: HlAccountingFill[] = [];
  let exitTime: number | null = null;
  for (let i = entryIndex; i < sorted.length; i += 1) {
    const fill = sorted[i]!;
    if (i > entryIndex && fill.dir.toLowerCase().includes('open') && Math.abs(fill.startPosition) < 1e-9) break;
    tradeFills.push(fill);
    const signedDelta = fill.side === 'B' ? fill.sz : -fill.sz;
    const endPosition = fill.startPosition + signedDelta;
    if (fill.dir.toLowerCase().includes('close') && Math.abs(endPosition) <= Math.max(1e-9, fill.sz * 1e-8)) {
      exitTime = fill.time;
      break;
    }
  }

  const entryFills = tradeFills.filter((f) => f.dir.toLowerCase().includes('open'));
  const exitFills = tradeFills.filter((f) => f.dir.toLowerCase().includes('close'));
  const entryQty = entryFills.reduce((sum, f) => sum + f.sz, 0);
  const exitQty = exitFills.reduce((sum, f) => sum + f.sz, 0);
  const entryNotionalUsd = entryFills.reduce((sum, f) => sum + f.px * f.sz, 0);
  const exitNotionalUsd = exitFills.reduce((sum, f) => sum + f.px * f.sz, 0);
  if (!(entryQty > 0) || !(entryNotionalUsd > 0)) return null;

  const entryTime = entryFills[0]!.time;
  const fundingEnd = exitTime ?? Number.POSITIVE_INFINITY;
  const fundingUsd = funding
    .filter((f) => f.time >= entryTime && f.time <= fundingEnd && Number.isFinite(f.usdc))
    .reduce((sum, f) => sum + f.usdc, 0);
  const grossPnlUsd = tradeFills.reduce((sum, f) => sum + f.closedPnl, 0);
  const feesUsd = tradeFills.reduce((sum, f) => sum + f.fee, 0);
  const netPnlUsd = grossPnlUsd - feesUsd + fundingUsd;

  return {
    entryTime,
    exitTime,
    entryAvgPx: entryNotionalUsd / entryQty,
    exitAvgPx: exitQty > 0 ? exitNotionalUsd / exitQty : null,
    entryQty,
    exitQty,
    entryNotionalUsd,
    exitNotionalUsd,
    grossPnlUsd,
    feesUsd,
    fundingUsd,
    netPnlUsd,
    netPnlPct: (netPnlUsd / entryNotionalUsd) * 100,
    fillCount: tradeFills.length,
    complete: exitTime != null && exitQty >= entryQty * 0.999,
  };
}

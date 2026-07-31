export type PriceLevel = readonly [price: number, size: number];

export const NATIVE_FORWARD_GATE = {
  targetClosed: 20,
  minDurationDays: 7,
  minClosedPerSide: 3,
  minProfitFactor: 1.2,
  maxDrawdownPct: 5,
  maxCaptureErrorRatePct: 2,
  maxP95BookAgeMs: 2_000,
} as const;

export type NativeForwardGateInput = {
  netPcts: readonly number[];
  sides: readonly ('long' | 'short')[];
  symbols: readonly string[];
  openedAtMs: readonly number[];
  closedAtMs: readonly number[];
  signalCount: number;
  captureErrors: number;
  executionCostPcts: readonly number[];
  bookAgesMs: readonly number[];
  /** Fixed-notional portfolio capacity. One for a standalone strategy. */
  drawdownCapacityUnits?: number;
  /** One for a standalone strategy; frozen at four for portfolio P2. */
  minUniqueSymbols?: number;
};

export type NativeForwardGateEvaluation = {
  status: 'collecting' | 'passed' | 'failed';
  entryAllowed: boolean;
  closed: number;
  netPct: number;
  profitFactor: number | null;
  firstHalfPct: number;
  secondHalfPct: number;
  maxDrawdownPct: number;
  captureErrorRatePct: number;
  avgExecutionCostPct: number | null;
  p95BookAgeMs: number | null;
  durationDays: number;
  longClosed: number;
  shortClosed: number;
  uniqueSymbols: number;
  reasons: readonly string[];
};

export type NativeForwardPnlRow = {
  net_pnl_pct: number;
  side: 'long' | 'short';
  symbol: string;
  opened_at: number;
  closed_at: number;
};
export type NativeForwardSignalRow = {
  capture_status: string;
  book_age_ms: number | null;
  bid: number | null;
  ask: number | null;
  buy_slippage_pct: number | null;
  sell_slippage_pct: number | null;
};

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile95(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

/**
 * Prospective Native Quant promotion/continuation gate. Before the frozen
 * sample target it observes unless the irreversible drawdown ceiling is
 * breached. At and after the target, a failed condition blocks new Shadow
 * entries; coverage gaps keep collecting but never qualify for Real. Exits
 * remain independently executable.
 */
export function evaluateNativeForwardGate(
  input: NativeForwardGateInput,
): NativeForwardGateEvaluation {
  const netPcts = input.netPcts.filter(Number.isFinite);
  const closed = netPcts.length;
  const netPct = sum(netPcts);
  const grossWin = sum(netPcts.filter((value) => value > 0));
  const grossLoss = Math.abs(sum(netPcts.filter((value) => value < 0)));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : closed ? Infinity : null;
  const split = Math.floor(closed / 2);
  const firstHalfPct = sum(netPcts.slice(0, split));
  const secondHalfPct = sum(netPcts.slice(split));

  let equity = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const value of netPcts) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity);
  }
  maxDrawdownPct /= Math.max(1, input.drawdownCapacityUnits ?? 1);

  const validCosts = input.executionCostPcts.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  const validBookAges = input.bookAgesMs.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  const signalCount = Math.max(0, Math.trunc(input.signalCount));
  const captureErrors = Math.max(0, Math.trunc(input.captureErrors));
  const captureErrorRatePct = signalCount > 0 ? captureErrors / signalCount * 100 : 0;
  const avgExecutionCostPct = validCosts.length ? sum(validCosts) / validCosts.length : null;
  const p95BookAgeMs = percentile95(validBookAges);
  const longClosed = input.sides.filter((side) => side === 'long').length;
  const shortClosed = input.sides.filter((side) => side === 'short').length;
  const uniqueSymbols = new Set(input.symbols.filter(Boolean)).size;
  const validOpenedAt = input.openedAtMs.filter(Number.isFinite);
  const validClosedAt = input.closedAtMs.filter(Number.isFinite);
  const durationDays = validOpenedAt.length && validClosedAt.length
    ? (Math.max(...validClosedAt) - Math.min(...validOpenedAt)) / 86_400_000
    : 0;

  // Maximum drawdown is path-dependent and cannot improve after it has been
  // observed. Waiting for the full sample after the frozen ceiling is already
  // breached would only accumulate more exposure for a strategy that can no
  // longer qualify. Other statistics may still recover, so they remain
  // observational until targetClosed.
  if (
    closed < NATIVE_FORWARD_GATE.targetClosed
    && maxDrawdownPct > NATIVE_FORWARD_GATE.maxDrawdownPct
  ) {
    const reason = `drawdown ${maxDrawdownPct.toFixed(3)}% > ${NATIVE_FORWARD_GATE.maxDrawdownPct.toFixed(1)}%`;
    return {
      status: 'failed',
      entryAllowed: false,
      closed,
      netPct,
      profitFactor,
      firstHalfPct,
      secondHalfPct,
      maxDrawdownPct,
      captureErrorRatePct,
      avgExecutionCostPct,
      p95BookAgeMs,
      durationDays,
      longClosed,
      shortClosed,
      uniqueSymbols,
      reasons: [reason],
    };
  }

  if (closed < NATIVE_FORWARD_GATE.targetClosed) {
    return {
      status: 'collecting',
      entryAllowed: true,
      closed,
      netPct,
      profitFactor,
      firstHalfPct,
      secondHalfPct,
      maxDrawdownPct,
      captureErrorRatePct,
      avgExecutionCostPct,
      p95BookAgeMs,
      durationDays,
      longClosed,
      shortClosed,
      uniqueSymbols,
      reasons: [],
    };
  }

  const reasons: string[] = [];
  if (!(netPct > 0)) reasons.push(`net ${netPct.toFixed(3)}% <= 0%`);
  if (!(profitFactor != null && profitFactor >= NATIVE_FORWARD_GATE.minProfitFactor)) {
    reasons.push(
      `PF ${profitFactor == null ? 'n/a' : profitFactor.toFixed(2)} < ${NATIVE_FORWARD_GATE.minProfitFactor.toFixed(2)}`,
    );
  }
  if (!(firstHalfPct > 0)) reasons.push(`first half ${firstHalfPct.toFixed(3)}% <= 0%`);
  if (!(secondHalfPct > 0)) reasons.push(`second half ${secondHalfPct.toFixed(3)}% <= 0%`);
  if (maxDrawdownPct > NATIVE_FORWARD_GATE.maxDrawdownPct) {
    reasons.push(
      `drawdown ${maxDrawdownPct.toFixed(3)}% > ${NATIVE_FORWARD_GATE.maxDrawdownPct.toFixed(1)}%`,
    );
  }
  if (captureErrorRatePct > NATIVE_FORWARD_GATE.maxCaptureErrorRatePct) {
    reasons.push(
      `capture errors ${captureErrorRatePct.toFixed(2)}% > ${NATIVE_FORWARD_GATE.maxCaptureErrorRatePct.toFixed(1)}%`,
    );
  }
  if (validCosts.length < closed) {
    reasons.push(`execution samples ${validCosts.length} < ${closed}`);
  }
  if (validBookAges.length < closed) {
    reasons.push(`book-age samples ${validBookAges.length} < ${closed}`);
  } else if (p95BookAgeMs == null || p95BookAgeMs > NATIVE_FORWARD_GATE.maxP95BookAgeMs) {
    reasons.push(
      `book age p95 ${p95BookAgeMs == null ? 'n/a' : `${p95BookAgeMs.toFixed(0)}ms`} > ${NATIVE_FORWARD_GATE.maxP95BookAgeMs}ms`,
    );
  }

  if (reasons.length) {
    return {
      status: 'failed',
      entryAllowed: false,
      closed,
      netPct,
      profitFactor,
      firstHalfPct,
      secondHalfPct,
      maxDrawdownPct,
      captureErrorRatePct,
      avgExecutionCostPct,
      p95BookAgeMs,
      durationDays,
      longClosed,
      shortClosed,
      uniqueSymbols,
      reasons,
    };
  }

  const evidenceReasons: string[] = [];
  if (durationDays < NATIVE_FORWARD_GATE.minDurationDays) {
    evidenceReasons.push(
      `duration ${durationDays.toFixed(1)}d < ${NATIVE_FORWARD_GATE.minDurationDays}d`,
    );
  }
  if (longClosed < NATIVE_FORWARD_GATE.minClosedPerSide) {
    evidenceReasons.push(
      `long closes ${longClosed} < ${NATIVE_FORWARD_GATE.minClosedPerSide}`,
    );
  }
  if (shortClosed < NATIVE_FORWARD_GATE.minClosedPerSide) {
    evidenceReasons.push(
      `short closes ${shortClosed} < ${NATIVE_FORWARD_GATE.minClosedPerSide}`,
    );
  }
  const minUniqueSymbols = Math.max(1, Math.trunc(input.minUniqueSymbols ?? 1));
  if (uniqueSymbols < minUniqueSymbols) {
    evidenceReasons.push(`markets ${uniqueSymbols} < ${minUniqueSymbols}`);
  }

  if (evidenceReasons.length) {
    return {
      status: 'collecting',
      entryAllowed: true,
      closed,
      netPct,
      profitFactor,
      firstHalfPct,
      secondHalfPct,
      maxDrawdownPct,
      captureErrorRatePct,
      avgExecutionCostPct,
      p95BookAgeMs,
      durationDays,
      longClosed,
      shortClosed,
      uniqueSymbols,
      reasons: evidenceReasons,
    };
  }

  return {
    status: 'passed',
    entryAllowed: true,
    closed,
    netPct,
    profitFactor,
    firstHalfPct,
    secondHalfPct,
    maxDrawdownPct,
    captureErrorRatePct,
    avgExecutionCostPct,
    p95BookAgeMs,
    durationDays,
    longClosed,
    shortClosed,
    uniqueSymbols,
    reasons: [],
  };
}

/**
 * Canonical DB-row adapter shared by the Shadow entry path and the independent
 * Real-promotion audit. Keeping one implementation prevents a looser audit
 * from disagreeing with the runtime gate.
 */
export function evaluateNativeForwardRows(
  pnlRows: readonly NativeForwardPnlRow[],
  signalRows: readonly NativeForwardSignalRow[],
  drawdownCapacityUnits = 1,
  minUniqueSymbols = 1,
): NativeForwardGateEvaluation {
  const captured = signalRows.filter((row) => row.capture_status === 'captured');
  const executionCostPcts = captured.flatMap((row) => {
    if (
      row.bid == null
      || row.ask == null
      || !(row.bid > 0)
      || !(row.ask > row.bid)
      || row.buy_slippage_pct == null
      || row.sell_slippage_pct == null
    ) return [];
    const mid = (row.ask + row.bid) / 2;
    return [((row.ask - row.bid) / mid * 100)
      + row.buy_slippage_pct + row.sell_slippage_pct];
  });
  return evaluateNativeForwardGate({
    netPcts: pnlRows.map((row) => row.net_pnl_pct),
    sides: pnlRows.map((row) => row.side),
    symbols: pnlRows.map((row) => row.symbol),
    openedAtMs: pnlRows.map((row) => row.opened_at),
    closedAtMs: pnlRows.map((row) => row.closed_at),
    signalCount: signalRows.length,
    captureErrors: signalRows.filter((row) => row.capture_status === 'error').length,
    executionCostPcts,
    bookAgesMs: captured.flatMap((row) => row.book_age_ms == null ? [] : [row.book_age_ms]),
    drawdownCapacityUnits,
    minUniqueSymbols,
  });
}

/** VWAP for a fixed quote-currency notional. Returns null if depth is short. */
export function quoteNotionalVwap(
  levels: readonly PriceLevel[],
  notionalUsd: number,
): number | null {
  if (!(notionalUsd > 0)) return null;
  let remaining = notionalUsd;
  let quantity = 0;
  let cost = 0;
  for (const [price, available] of levels) {
    if (!(price > 0) || !(available > 0)) continue;
    const take = Math.min(available, remaining / price);
    quantity += take;
    cost += take * price;
    remaining -= take * price;
    if (remaining <= 1e-8) return quantity > 0 ? cost / quantity : null;
  }
  return null;
}

export function pricePnlPct(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
): number {
  if (!(entryPrice > 0) || !(exitPrice > 0)) return 0;
  return side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
}

/**
 * Lighter reports funding in percentage points per hour (for example 0.0012
 * means 0.0012%). Positive funding is paid by longs to shorts.
 *
 * This is deliberately an estimate: without a real position there is no
 * account funding ledger, so the shadow uses the mean observed entry/exit
 * rate over the holding interval.
 */
export function estimatedFundingPnlPct(
  side: 'long' | 'short',
  entryRatePctH: number,
  exitRatePctH: number,
  heldMs: number,
): number {
  if (!(heldMs > 0)) return 0;
  const meanRate = (entryRatePctH + exitRatePctH) / 2;
  const signedRate = side === 'long' ? -meanRate : meanRate;
  return signedRate * (heldMs / 3_600_000);
}

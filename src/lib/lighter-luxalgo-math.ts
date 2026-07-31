export type PriceLevel = readonly [price: number, size: number];

export const LUXALGO_SHADOW_NOTIONAL_USD = 1_000;
export const NATIVE_SHADOW_NOTIONAL_USD = 100;

/**
 * Native selection, prospective Shadow and the future isolated Real canary all
 * use the same $100 execution capacity. Legacy LuxAlgo alerts retain their
 * original $1,000 Shadow cohort.
 */
export function shadowExecutionNotionalUsd(isNative: boolean): number {
  return isNative ? NATIVE_SHADOW_NOTIONAL_USD : LUXALGO_SHADOW_NOTIONAL_USD;
}

export const NATIVE_FORWARD_GATE = {
  targetClosed: 20,
  minDurationDays: 7,
  minClosedPerSide: 3,
  minProfitFactor: 1.2,
  maxDrawdownPct: 5,
  maxCaptureErrorRatePct: 2,
  maxP95BookAgeMs: 2_000,
  // A profitable early cohort must not hide a later loss of edge. Once forty
  // closes exist, the latest twenty form a separate, frozen decay gate.
  recentDecayMinClosed: 40,
  recentClosedWindow: 20,
  minRecentSignalsForHealth: 20,
  recentSignalWindow: 100,
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
  /** Resolved captured/error rows from the latest frozen signal window. */
  recentSignalCount?: number;
  recentCaptureErrors?: number;
  recentBookAgesMs?: readonly number[];
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
  recentClosed: number;
  recentNetPct: number;
  recentProfitFactor: number | null;
  recentSignalCount: number;
  recentCaptureErrorRatePct: number;
  recentP95BookAgeMs: number | null;
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
  const recentPcts = netPcts.slice(-NATIVE_FORWARD_GATE.recentClosedWindow);
  const recentClosed = recentPcts.length;
  const recentNetPct = sum(recentPcts);
  const recentGrossWin = sum(recentPcts.filter((value) => value > 0));
  const recentGrossLoss = Math.abs(sum(recentPcts.filter((value) => value < 0)));
  const recentProfitFactor = recentGrossLoss > 0
    ? recentGrossWin / recentGrossLoss
    : recentClosed ? Infinity : null;
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
  const recentSignalCount = Math.max(0, Math.trunc(
    input.recentSignalCount
      ?? Math.min(signalCount, NATIVE_FORWARD_GATE.recentSignalWindow),
  ));
  const recentCaptureErrors = Math.min(
    recentSignalCount,
    Math.max(0, Math.trunc(input.recentCaptureErrors ?? captureErrors)),
  );
  const recentCaptureErrorRatePct = recentSignalCount > 0
    ? recentCaptureErrors / recentSignalCount * 100
    : 0;
  const recentBookAges = (input.recentBookAgesMs ?? validBookAges.slice(
    -NATIVE_FORWARD_GATE.recentSignalWindow,
  )).filter((value) => Number.isFinite(value) && value >= 0);
  const recentP95BookAgeMs = percentile95(recentBookAges);
  const longClosed = input.sides.filter((side) => side === 'long').length;
  const shortClosed = input.sides.filter((side) => side === 'short').length;
  const uniqueSymbols = new Set(input.symbols.filter(Boolean)).size;
  const validOpenedAt = input.openedAtMs.filter(Number.isFinite);
  const validClosedAt = input.closedAtMs.filter(Number.isFinite);
  const durationDays = validOpenedAt.length && validClosedAt.length
    ? (Math.max(...validClosedAt) - Math.min(...validOpenedAt)) / 86_400_000
    : 0;

  const base = {
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
    recentClosed,
    recentNetPct,
    recentProfitFactor,
    recentSignalCount,
    recentCaptureErrorRatePct,
    recentP95BookAgeMs,
  };

  // Execution health is recoverable and intentionally independent of PnL.
  // It may pause entries before twenty closes, but resumes automatically only
  // after bad rows age out of the latest 100 resolved-signal window. Exits are
  // outside this gate and remain executable.
  if (recentSignalCount >= NATIVE_FORWARD_GATE.minRecentSignalsForHealth) {
    const healthReasons: string[] = [];
    if (recentCaptureErrorRatePct > NATIVE_FORWARD_GATE.maxCaptureErrorRatePct) {
      healthReasons.push(
        `recent ${recentSignalCount} capture errors ${recentCaptureErrorRatePct.toFixed(2)}% > ${NATIVE_FORWARD_GATE.maxCaptureErrorRatePct.toFixed(1)}%`,
      );
    }
    const expectedBookAges = recentSignalCount - recentCaptureErrors;
    if (recentBookAges.length < expectedBookAges) {
      healthReasons.push(
        `recent book-age samples ${recentBookAges.length} < ${expectedBookAges}`,
      );
    } else if (
      recentP95BookAgeMs == null
      || recentP95BookAgeMs > NATIVE_FORWARD_GATE.maxP95BookAgeMs
    ) {
      healthReasons.push(
        `recent book age p95 ${recentP95BookAgeMs == null ? 'n/a' : `${recentP95BookAgeMs.toFixed(0)}ms`} > ${NATIVE_FORWARD_GATE.maxP95BookAgeMs}ms`,
      );
    }
    if (healthReasons.length) {
      return {
        status: 'failed',
        entryAllowed: false,
        ...base,
        reasons: healthReasons,
      };
    }
  }

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
      ...base,
      reasons: [reason],
    };
  }

  if (closed < NATIVE_FORWARD_GATE.targetClosed) {
    return {
      status: 'collecting',
      entryAllowed: true,
      ...base,
      reasons: [],
    };
  }

  const performanceReasons: string[] = [];
  if (!(netPct > 0)) performanceReasons.push(`net ${netPct.toFixed(3)}% <= 0%`);
  if (!(profitFactor != null && profitFactor >= NATIVE_FORWARD_GATE.minProfitFactor)) {
    performanceReasons.push(
      `PF ${profitFactor == null ? 'n/a' : profitFactor.toFixed(2)} < ${NATIVE_FORWARD_GATE.minProfitFactor.toFixed(2)}`,
    );
  }
  if (!(firstHalfPct > 0)) performanceReasons.push(`first half ${firstHalfPct.toFixed(3)}% <= 0%`);
  if (!(secondHalfPct > 0)) performanceReasons.push(`second half ${secondHalfPct.toFixed(3)}% <= 0%`);
  if (
    closed >= NATIVE_FORWARD_GATE.recentDecayMinClosed
    && (!(recentNetPct > 0)
      || !(recentProfitFactor != null && recentProfitFactor >= 1))
  ) {
    performanceReasons.push(
      `recent ${recentClosed} decay: net ${recentNetPct.toFixed(3)}%, PF ${recentProfitFactor == null ? 'n/a' : recentProfitFactor.toFixed(2)} < required positive / 1.00`,
    );
  }
  if (maxDrawdownPct > NATIVE_FORWARD_GATE.maxDrawdownPct) {
    performanceReasons.push(
      `drawdown ${maxDrawdownPct.toFixed(3)}% > ${NATIVE_FORWARD_GATE.maxDrawdownPct.toFixed(1)}%`,
    );
  }
  if (performanceReasons.length) {
    return {
      status: 'failed',
      entryAllowed: false,
      ...base,
      reasons: performanceReasons,
    };
  }

  const evidenceReasons: string[] = [];
  // Whole-cohort execution evidence is a Real-promotion requirement. When
  // the current 100-signal health window has recovered, old startup errors do
  // not keep Shadow disabled, but they still prevent promotion.
  if (captureErrorRatePct > NATIVE_FORWARD_GATE.maxCaptureErrorRatePct) {
    evidenceReasons.push(
      `capture errors ${captureErrorRatePct.toFixed(2)}% > ${NATIVE_FORWARD_GATE.maxCaptureErrorRatePct.toFixed(1)}%`,
    );
  }
  if (validCosts.length < closed) {
    evidenceReasons.push(`execution samples ${validCosts.length} < ${closed}`);
  }
  if (validBookAges.length < closed) {
    evidenceReasons.push(`book-age samples ${validBookAges.length} < ${closed}`);
  } else if (p95BookAgeMs == null || p95BookAgeMs > NATIVE_FORWARD_GATE.maxP95BookAgeMs) {
    evidenceReasons.push(
      `book age p95 ${p95BookAgeMs == null ? 'n/a' : `${p95BookAgeMs.toFixed(0)}ms`} > ${NATIVE_FORWARD_GATE.maxP95BookAgeMs}ms`,
    );
  }
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
      ...base,
      reasons: evidenceReasons,
    };
  }

  return {
    status: 'passed',
    entryAllowed: true,
    ...base,
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
  const recentResolved = signalRows
    .filter((row) => row.capture_status === 'captured' || row.capture_status === 'error')
    .slice(-NATIVE_FORWARD_GATE.recentSignalWindow);
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
    recentSignalCount: recentResolved.length,
    recentCaptureErrors: recentResolved.filter((row) => row.capture_status === 'error').length,
    recentBookAgesMs: recentResolved.flatMap((row) =>
      row.capture_status === 'captured' && row.book_age_ms != null ? [row.book_age_ms] : []),
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

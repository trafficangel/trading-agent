/**
 * SL distribution analysis — the math behind «can this strategy fit a
 * 5% safety stop without breaking?».
 *
 * Used by:
 *   - scripts/import-strategy.ts — auto-suggest slPct on new imports
 *   - scripts/audit-sl-distribution.ts — re-audit existing strategies
 *   - src/strategies/track-c-config.ts (validator) — startup sanity check
 *
 * # Methodology
 *
 * For each historical losing trade we compute the % loss against entry
 * price (not against $1000 notional — that scales but the SHAPE of the
 * distribution is what matters):
 *
 *   loss_pct = sideSign × (exitPrice − entryPrice) / entryPrice × 100
 *              (negate for losses so values are positive magnitudes)
 *
 * Then we sort and compute percentiles. The **percentile X** answers
 * the question: «what % loss is bigger than X% of observed losses?»
 *
 *   p50 = median loss
 *   p90 = «typical bad day» — only 10% of losses are worse
 *   p95 = «rare bad day» — only 5% of losses are worse
 *   p99 = «black swan» — only 1% of losses are worse
 *   worst = the actual worst loss in the data
 *
 * The «cut@cap» numbers tell us: if we'd placed a safety SL at `cap`,
 * how many of the historical losses would have been force-closed by
 * our SL instead of letting the strategy exit naturally?
 *
 *   cut@cap = count(losses where loss > cap) / count(all losses)
 *
 * # Decision rule
 *
 * - **compatible**: the strategy's natural loss distribution sits
 *   comfortably under the cap. Default rule: p90 ≤ cap AND cut@cap ≤ 10%.
 *   Recommend slPct = p90 × 1.2 (rounded), capped by maxSlPct.
 *
 * - **borderline**: the strategy *can* run under the cap, but it'll
 *   clip more than 10% of natural losses → some EV will be lost. Rule:
 *   10% < cut@cap ≤ 25%. Recommend slPct = maxSlPct itself, with a
 *   warning that backtest stats no longer apply.
 *
 * - **incompatible**: the strategy's natural loss space lives mostly
 *   ABOVE the cap. Tightening would break the strategy. Rule:
 *   cut@cap > 25%. Recommend disabling — pick a different LuxAlgo
 *   variant or different timeframe instead.
 */

export type AnalyzableTrade = {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
};

export type SlDistribution = {
  /** Total trades in the log (winners + losers + breakeven). */
  totalTrades: number;
  /** How many of those were net losers. */
  lossCount: number;
  /** Loss percentiles in % (positive magnitudes). */
  percentiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    worst: number;
  };
  /** For each cap value (in %), what fraction of historical losses
   *  would be force-closed by an SL at that cap. Key = cap as %
   *  (e.g. `5` for 5%), value = ratio 0..1. */
  cutRates: Record<number, number>;
  /** Operator-facing recommendation. `null` if the strategy doesn't
   *  fit the global cap (incompatible). */
  recommendedSlPct: number | null;
  /** Verdict for the operator. */
  verdict: 'compatible' | 'borderline' | 'incompatible';
  /** Human-readable summary; suitable for stdout or commit comments. */
  reasoning: string;
};

type AnalyzeOptions = {
  /** Hard ceiling — strategy's recommended SL won't exceed this.
   *  Defaults to 0.05 (matches MAX_SAFE_SL_PCT in track-c-config.ts). */
  maxSlPct?: number;
  /** Acceptable cut rate at the recommended SL (0..1). At 0.10 we tolerate
   *  10% of historical losses being clipped. */
  targetCutRate?: number;
  /** Caps to report cut% for (in percent units). */
  capsToReport?: number[];
};

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

/** Round UP to the nearest 0.5% (e.g. 3.21 → 3.5, 3.51 → 4.0).
 *  «Up» because we'd rather over-buffer than clip an extra loser. */
function roundUpHalfPct(pct: number): number {
  return Math.ceil(pct * 2) / 2;
}

export function analyzeSlDistribution(
  trades: AnalyzableTrade[],
  opts: AnalyzeOptions = {},
): SlDistribution {
  const maxSlPct = opts.maxSlPct ?? 0.05;
  const targetCutRate = opts.targetCutRate ?? 0.10;
  const capsToReport = opts.capsToReport ?? [3, 5, 7, 10, 15];

  // Per-trade % loss against entry price. Sign-correct for long vs short.
  const allPnl = trades.map((t) => {
    const sign = t.side === 'long' ? 1 : -1;
    return (sign * (t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
  });
  // Take losses, convert to positive magnitudes, sort ascending.
  const losses = allPnl.filter((p) => p < 0).map((p) => -p).sort((a, b) => a - b);

  if (losses.length === 0) {
    return {
      totalTrades: trades.length,
      lossCount: 0,
      percentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, worst: 0 },
      cutRates: Object.fromEntries(capsToReport.map((c) => [c, 0])),
      recommendedSlPct: null,
      verdict: 'incompatible',
      reasoning: 'No losses in the trade log — cannot calibrate SL. Need at least 10 historical losses for reliable analysis.',
    };
  }

  const p50 = percentile(losses, 0.50);
  const p75 = percentile(losses, 0.75);
  const p90 = percentile(losses, 0.90);
  const p95 = percentile(losses, 0.95);
  const p99 = percentile(losses, 0.99);
  const worst = losses[losses.length - 1]!;

  const cutRates: Record<number, number> = {};
  for (const cap of capsToReport) {
    cutRates[cap] = losses.filter((l) => l > cap).length / losses.length;
  }

  const maxCapPct = maxSlPct * 100;
  const cutAtMaxCap = losses.filter((l) => l > maxCapPct).length / losses.length;

  let recommendedSlPct: number | null;
  let verdict: SlDistribution['verdict'];
  let reasoning: string;

  if (p90 <= maxCapPct && cutAtMaxCap <= targetCutRate) {
    // Compatible: p90 fits AND the cap clips few enough losses.
    // Recommend p90 × 1.2 buffer, rounded up to 0.5%, capped at max.
    const suggested = Math.min(roundUpHalfPct(p90 * 1.2), maxCapPct);
    recommendedSlPct = suggested / 100;
    verdict = 'compatible';
    reasoning =
      `COMPATIBLE. p90 loss ${p90.toFixed(2)}% sits under cap ${maxCapPct.toFixed(0)}%. ` +
      `At ${maxCapPct.toFixed(0)}% SL only ${(cutAtMaxCap * 100).toFixed(1)}% of historical losses would be clipped. ` +
      `Recommended slPct = ${suggested.toFixed(1)}% (p90 × 1.2 buffer, rounded up to 0.5%).`;
  } else if (cutAtMaxCap <= 0.25) {
    // Borderline: max cap clips 10-25% of historical losses. The strategy
    // will lose some EV — backtest stats will no longer apply 1:1.
    recommendedSlPct = maxSlPct;
    verdict = 'borderline';
    reasoning =
      `BORDERLINE. p90 loss ${p90.toFixed(2)}% exceeds cap ${maxCapPct.toFixed(0)}%. ` +
      `Forcing slPct=${maxCapPct.toFixed(0)}% would clip ${(cutAtMaxCap * 100).toFixed(1)}% of historical losses ` +
      `— above the ${(targetCutRate * 100).toFixed(0)}% target. ` +
      `Strategy can still run, but expect realized PnL to differ from backtest (some natural losses become forced stops). ` +
      `Consider running a small live-trial first.`;
  } else {
    // Incompatible: cap would clip > 25% of losses → strategy is
    // fundamentally a wide-SL strategy. Don't enable under the cap.
    recommendedSlPct = null;
    verdict = 'incompatible';
    reasoning =
      `INCOMPATIBLE. ${(cutAtMaxCap * 100).toFixed(0)}% of historical losses exceed ${maxCapPct.toFixed(0)}%. ` +
      `Tightening to fit the cap would chop the strategy in half. ` +
      `Either find a different LuxAlgo variant with a tighter exit, ` +
      `pick a smaller timeframe, or skip this strategy entirely.`;
  }

  return {
    totalTrades: trades.length,
    lossCount: losses.length,
    percentiles: { p50, p75, p90, p95, p99, worst },
    cutRates,
    recommendedSlPct,
    verdict,
    reasoning,
  };
}

/** Format a SlDistribution as a stdout-friendly report. */
export function formatSlDistribution(d: SlDistribution): string {
  const { percentiles, cutRates, totalTrades, lossCount, verdict, reasoning } = d;
  const verdictBadge = verdict === 'compatible' ? '✅ COMPATIBLE'
    : verdict === 'borderline' ? '⚠ BORDERLINE'
    : '❌ INCOMPATIBLE';
  const recStr = d.recommendedSlPct == null
    ? '— (disable strategy)'
    : `${(d.recommendedSlPct * 100).toFixed(1)}%`;
  const cutLines = Object.entries(cutRates)
    .map(([cap, rate]) => `  ${cap.padStart(2, ' ')}% SL → cuts ${(rate * 100).toFixed(1).padStart(5, ' ')}% of losses`)
    .join('\n');
  return (
    `\n` +
    `${verdictBadge}  recommended slPct = ${recStr}\n` +
    `\n` +
    `${totalTrades} trades total, ${lossCount} losing\n` +
    `\n` +
    `Loss percentiles (% from entry):\n` +
    `  p50   = ${percentiles.p50.toFixed(2)}%\n` +
    `  p75   = ${percentiles.p75.toFixed(2)}%\n` +
    `  p90   = ${percentiles.p90.toFixed(2)}%\n` +
    `  p95   = ${percentiles.p95.toFixed(2)}%\n` +
    `  p99   = ${percentiles.p99.toFixed(2)}%\n` +
    `  worst = ${percentiles.worst.toFixed(2)}%\n` +
    `\n` +
    `Cut rates at candidate SL caps:\n` +
    cutLines + `\n` +
    `\n` +
    reasoning + `\n`
  );
}

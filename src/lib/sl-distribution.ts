/**
 * SL distribution analysis — the math behind «what's the right safety SL
 * for this strategy?».
 *
 * Phase Q (May 28, 2026) replaces a flawed cut-rate verdict with PnL
 * simulation. The old method counted what fraction of historical losses
 * exceeded the cap — but losses that exceeded the cap weren't all
 * equally damaging. Many would have recovered to small wins or smaller
 * losses than the cap, so «cutting» them HURT EV. Other losses would
 * have grown to −20% naturally, so the cap SAVED us. The cut-rate
 * conflated the two.
 *
 * The new method directly simulates the strategy's net PnL across a
 * range of SL caps using MAE data (max adverse excursion per trade).
 * For each candidate cap, for each trade:
 *   - if MAE >= cap → trade force-closed at −cap (we hit SL during life)
 *   - else          → trade exits naturally (realized PnL)
 * Sum across all trades. Compare to the no-cap baseline.
 *
 * The cap that maximises sim PnL within the operator's risk envelope
 * is the winner. Strategy is COMPATIBLE if sim PnL is positive and
 * close to the no-cap PnL. BORDERLINE if cap costs significant PnL but
 * strategy still profitable. INCOMPATIBLE if sim PnL goes negative.
 *
 * Used by:
 *   - scripts/import-strategy.ts — auto-suggest slPct on new imports
 *   - scripts/audit-sl-distribution.ts — re-audit existing strategies
 *   - src/strategies/track-c-config.ts (validator) — startup sanity check
 *
 * # Inputs
 *
 * For each trade: side (long/short), entryPrice, exitPrice, maePct
 * (positive magnitude of worst adverse excursion). Without maePct the
 * analysis falls back to realized loss, which under-counts cut rates.
 *
 * # Decision rule (new)
 *
 * Compute pnl_no_cap and pnl_at_cap for candidate caps in {3, 4, 5, 6,
 * 7, 8, 10, 15} %. Recommend the cap that maximises pnl_at_cap subject
 * to cap ≤ maxSlPct (operator's hard ceiling).
 *
 * Verdict:
 *   - COMPATIBLE: pnl_at_recommended > 0 AND ≥ 80% of pnl_no_cap
 *   - BORDERLINE: pnl_at_recommended > 0 AND 50-80% of pnl_no_cap
 *     (cap costs significant EV; strategy still profitable)
 *   - INCOMPATIBLE: pnl_at_recommended ≤ 0
 *     (cap kills the strategy — either find a tighter variant or skip)
 */

export type AnalyzableTrade = {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  /** Maximum Adverse Excursion — worst drawdown from entry during trade
   *  lifetime, as a positive % magnitude. Populated by
   *  `scripts/backfill-mae.ts` from Bybit kline data.
   *
   *  When present, this is the CORRECT input for SL-distribution analysis
   *  (would the SL have force-closed this trade at any point during its
   *  life?). When absent, we fall back to realized loss — which
   *  UNDERESTIMATES the cut rate because trades that drew down then
   *  recovered look like small losers. */
  maePct?: number;
};

export type SimulationResult = {
  /** Simulated net PnL in % of $1000 notional. */
  netPnlPct: number;
  /** Simulated profit factor. */
  profitFactor: number;
  /** Simulated win rate (0..1). */
  winRate: number;
  /** Max equity drawdown in %. */
  maxDrawdownPct: number;
  /** Worst single-trade PnL %. */
  worstTradePct: number;
  /** Trades force-closed by SL. */
  stoppedOut: number;
  /** Stop-outs that killed a would-be winner. */
  killedWinners: number;
  /** Stop-outs that saved us from a worse natural loss. */
  savedFromLargerLoss: number;
};

export type SlDistribution = {
  /** Which loss metric we used. 'mae' = max adverse excursion (worst
   *  drawdown during trade life, the right answer). 'realized' = exit
   *  loss only (underestimates because recovered trades hide their
   *  drawdown). */
  source: 'mae' | 'realized' | 'mixed';
  /** Coverage of MAE data when source != 'mae' — what fraction of
   *  trades had MAE; the rest fell back to realized loss. */
  maeCoverage: number;
  /** Total trades in the log (winners + losers + breakeven). */
  totalTrades: number;
  /** How many of those went underwater at any point (with MAE) or
   *  closed in the red (with realized). */
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
  /** For each cap value (in %), what fraction of underwater trades
   *  would be force-closed by an SL at that cap. Informational. */
  cutRates: Record<number, number>;
  /** Phase Q — full PnL simulation for each candidate cap. */
  simulations: Record<number, SimulationResult>;
  /** Same as simulations but for no-cap (∞) — the baseline. */
  noCapSimulation: SimulationResult;
  /** Operator-facing recommendation. `null` if no positive PnL cap
   *  exists within maxSlPct. */
  recommendedSlPct: number | null;
  /** Verdict for the operator. */
  verdict: 'compatible' | 'borderline' | 'incompatible';
  /** Human-readable summary; suitable for stdout or commit comments. */
  reasoning: string;
};

type AnalyzeOptions = {
  /** Hard ceiling — strategy's recommended SL won't exceed this.
   *  Defaults to 0.08 (matches MAX_SAFE_SL_PCT in track-c-config.ts). */
  maxSlPct?: number;
  /** Caps to report cut%+simulation for (in percent units). */
  capsToReport?: number[];
};

/** Bybit USDT-perp taker commission used in simulation. */
const COMMISSION_PER_SIDE = 0.00055;

/**
 * Simulate strategy net PnL assuming a safety SL fires at `capPct`
 * (fraction, e.g. 0.05 for 5%) whenever MAE meets/exceeds the cap.
 * Per-trade pnl is calculated in % of entry price; commission is paid
 * on both sides.
 */
export function simulateAtCap(trades: AnalyzableTrade[], capPct: number): SimulationResult {
  let totalPnlPct = 0;
  let cumulativePnl = 0;
  let peakEquity = 0;
  let maxDrawdownPct = 0;
  let stoppedOut = 0;
  let killedWinners = 0;
  let savedFromLargerLoss = 0;
  let worstTradePct = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;

  for (const t of trades) {
    const sideSign = t.side === 'long' ? 1 : -1;
    const realizedPct = sideSign * (t.exitPrice - t.entryPrice) / t.entryPrice;
    const maePct = t.maePct != null ? t.maePct / 100 : Math.max(0, -realizedPct);

    let effectivePct: number;
    if (capPct < 1 && maePct >= capPct) {
      effectivePct = -capPct;
      stoppedOut++;
      if (realizedPct > 0) killedWinners++;
      else if (realizedPct < -capPct) savedFromLargerLoss++;
    } else {
      effectivePct = realizedPct;
    }

    // Subtract commission both sides
    const commissionPct = COMMISSION_PER_SIDE * 2;
    const netPct = effectivePct - commissionPct;
    totalPnlPct += netPct;
    cumulativePnl += netPct;
    if (cumulativePnl > peakEquity) peakEquity = cumulativePnl;
    const dd = peakEquity - cumulativePnl;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    if (effectivePct < worstTradePct) worstTradePct = effectivePct;
    if (netPct > 0) { wins++; grossWin += netPct; }
    else if (netPct < 0) { losses++; grossLoss += -netPct; }
  }

  return {
    netPnlPct: Math.round(totalPnlPct * 10000) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : Infinity,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 100,
    worstTradePct: Math.round(worstTradePct * 10000) / 100,
    stoppedOut,
    killedWinners,
    savedFromLargerLoss,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}


export function analyzeSlDistribution(
  trades: AnalyzableTrade[],
  opts: AnalyzeOptions = {},
): SlDistribution {
  const maxSlPct = opts.maxSlPct ?? 0.08;
  const capsToReport = opts.capsToReport ?? [3, 4, 5, 6, 7, 8, 10, 15];

  // Per-trade adverse-excursion %. Prefer MAE (worst price during trade
  // life) when available — it's the only honest input for «would the SL
  // have force-closed?». Fall back to realized loss when MAE is missing
  // (older imports without backfill).
  const adverseExcursions: number[] = [];
  let maeUsed = 0;
  for (const t of trades) {
    if (typeof t.maePct === 'number' && Number.isFinite(t.maePct)) {
      if (t.maePct > 0) adverseExcursions.push(t.maePct);
      maeUsed++;
    } else {
      const sign = t.side === 'long' ? 1 : -1;
      const realized = (sign * (t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
      if (realized < 0) adverseExcursions.push(-realized);
    }
  }
  const losses = adverseExcursions.sort((a, b) => a - b);
  const source: SlDistribution['source'] =
    maeUsed === trades.length ? 'mae' :
    maeUsed === 0 ? 'realized' :
    'mixed';
  const maeCoverage = trades.length > 0 ? maeUsed / trades.length : 0;

  if (losses.length === 0) {
    return {
      source,
      maeCoverage,
      totalTrades: trades.length,
      lossCount: 0,
      percentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, worst: 0 },
      cutRates: Object.fromEntries(capsToReport.map((c) => [c, 0])),
      simulations: {},
      noCapSimulation: simulateAtCap(trades, 1.0),
      recommendedSlPct: null,
      verdict: 'incompatible',
      reasoning: 'No losses / adverse excursions in the trade log — cannot calibrate SL. Need at least 10 historical samples for reliable analysis.',
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

  // Phase Q: run PnL simulation for each candidate cap.
  const simulations: Record<number, SimulationResult> = {};
  for (const cap of capsToReport) {
    simulations[cap] = simulateAtCap(trades, cap / 100);
  }
  const noCapSimulation = simulateAtCap(trades, 1.0); // "no cap" baseline

  // Pick the cap in [3..maxSlPct] that maximises sim net PnL.
  const eligibleCaps = capsToReport.filter((c) => c <= maxSlPct * 100);
  let bestCap: number | null = null;
  let bestPnl = -Infinity;
  for (const cap of eligibleCaps) {
    if (simulations[cap]!.netPnlPct > bestPnl) {
      bestPnl = simulations[cap]!.netPnlPct;
      bestCap = cap;
    }
  }

  let recommendedSlPct: number | null = null;
  let verdict: SlDistribution['verdict'] = 'incompatible';
  let reasoning: string;

  const noCapPnl = noCapSimulation.netPnlPct;
  const bestSim = bestCap != null ? simulations[bestCap]! : null;
  const maxCapPct = maxSlPct * 100;

  if (bestSim == null || bestSim.netPnlPct <= 0) {
    verdict = 'incompatible';
    reasoning =
      `❌ INCOMPATIBLE. Best simulated PnL within ${maxCapPct.toFixed(0)}% cap is ${bestSim?.netPnlPct.toFixed(1) ?? '—'}% ` +
      `(needs to be > 0). Strategy needs SL wider than ${maxCapPct.toFixed(0)}% to be profitable. ` +
      `Either lift the global cap (MAX_SAFE_SL_PCT), find a tighter LuxAlgo variant, or skip.`;
  } else {
    recommendedSlPct = bestCap! / 100;
    const ratio = noCapPnl > 0 ? bestSim.netPnlPct / noCapPnl : 1;
    if (ratio >= 0.80 || noCapPnl <= 0) {
      verdict = 'compatible';
      reasoning =
        `✅ COMPATIBLE. Recommended slPct ${bestCap}% → simulated PnL +${bestSim.netPnlPct.toFixed(1)}% ` +
        `(PF ${bestSim.profitFactor.toFixed(2)}, max DD ${bestSim.maxDrawdownPct.toFixed(1)}%, worst trade ${bestSim.worstTradePct.toFixed(1)}%). ` +
        `${ratio >= 1 ? 'Cap IMPROVES results vs no-cap (saves from worst excursions).'
          : `Captures ${(ratio * 100).toFixed(0)}% of no-cap PnL (${noCapPnl.toFixed(1)}%).`}`;
    } else if (ratio >= 0.50) {
      verdict = 'borderline';
      reasoning =
        `⚠ BORDERLINE. Recommended slPct ${bestCap}% → PnL +${bestSim.netPnlPct.toFixed(1)}% ` +
        `(${(ratio * 100).toFixed(0)}% of no-cap PnL ${noCapPnl.toFixed(1)}%). ` +
        `Cap costs significant EV but strategy still profitable. ` +
        `PF ${bestSim.profitFactor.toFixed(2)}, max DD ${bestSim.maxDrawdownPct.toFixed(1)}%, worst trade ${bestSim.worstTradePct.toFixed(1)}%. ` +
        `Consider live-trial before promoting to paying tiers.`;
    } else {
      verdict = 'incompatible';
      reasoning =
        `❌ INCOMPATIBLE. Recommended slPct ${bestCap}% delivers only ${(ratio * 100).toFixed(0)}% ` +
        `of the natural PnL (${bestSim.netPnlPct.toFixed(1)}% of ${noCapPnl.toFixed(1)}%). ` +
        `The cap is too tight for this strategy — natural noise eats too much edge.`;
      recommendedSlPct = null;
    }
  }

  return {
    source,
    maeCoverage,
    totalTrades: trades.length,
    lossCount: losses.length,
    percentiles: { p50, p75, p90, p95, p99, worst },
    cutRates,
    simulations,
    noCapSimulation,
    recommendedSlPct,
    verdict,
    reasoning,
  };
}

/** Format a SlDistribution as a stdout-friendly report. */
export function formatSlDistribution(d: SlDistribution): string {
  const { percentiles, totalTrades, lossCount, verdict, reasoning, source, maeCoverage, simulations, noCapSimulation } = d;
  const verdictBadge = verdict === 'compatible' ? '✅ COMPATIBLE'
    : verdict === 'borderline' ? '⚠ BORDERLINE'
    : '❌ INCOMPATIBLE';
  const recStr = d.recommendedSlPct == null
    ? '— (disable strategy)'
    : `${(d.recommendedSlPct * 100).toFixed(1)}%`;
  const sourceLabel =
    source === 'mae'
      ? 'MAE (max adverse excursion — accurate)'
      : source === 'realized'
        ? '⚠ realized loss only — UNDERESTIMATES; run scripts/backfill-mae.ts first'
        : `mixed (${(maeCoverage * 100).toFixed(0)}% MAE, rest realized)`;

  // PnL simulation table — Phase Q primary output
  let simTable = `\nPnL simulation at candidate SL caps (% of $1000 notional, after commissions):\n`;
  simTable += `  cap  | net_PnL  |   PF   |  WR   | max_DD | worst  | stop | killW | savL\n`;
  simTable += `  -----|----------|--------|-------|--------|--------|------|-------|------\n`;
  for (const [cap, s] of Object.entries(simulations)) {
    const capStr = `${cap}%`.padStart(4);
    const pnl = `+${s.netPnlPct.toFixed(1)}%`.padStart(8);
    const pf = (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)).padStart(6);
    const wr = `${(s.winRate * 100).toFixed(1)}%`.padStart(5);
    const dd = `${s.maxDrawdownPct.toFixed(1)}%`.padStart(6);
    const worst = `${s.worstTradePct.toFixed(1)}%`.padStart(6);
    simTable += `  ${capStr} | ${pnl} | ${pf} | ${wr} | ${dd} | ${worst} | ${String(s.stoppedOut).padStart(4)} | ${String(s.killedWinners).padStart(5)} | ${String(s.savedFromLargerLoss).padStart(4)}\n`;
  }
  const ncpnl = `+${noCapSimulation.netPnlPct.toFixed(1)}%`.padStart(8);
  const ncpf = (noCapSimulation.profitFactor === Infinity ? '∞' : noCapSimulation.profitFactor.toFixed(2)).padStart(6);
  const ncwr = `${(noCapSimulation.winRate * 100).toFixed(1)}%`.padStart(5);
  const ncdd = `${noCapSimulation.maxDrawdownPct.toFixed(1)}%`.padStart(6);
  const ncworst = `${noCapSimulation.worstTradePct.toFixed(1)}%`.padStart(6);
  simTable += `   ∞%  | ${ncpnl} | ${ncpf} | ${ncwr} | ${ncdd} | ${ncworst} | (no cap baseline)\n`;

  return (
    `\n` +
    `${verdictBadge}  recommended slPct = ${recStr}\n` +
    `\n` +
    `Data source: ${sourceLabel}\n` +
    `${totalTrades} trades, ${lossCount} underwater at some point\n` +
    `\n` +
    `MAE percentiles (% from entry):\n` +
    `  p50=${percentiles.p50.toFixed(2)}%  p75=${percentiles.p75.toFixed(2)}%  ` +
    `p90=${percentiles.p90.toFixed(2)}%  p95=${percentiles.p95.toFixed(2)}%  ` +
    `worst=${percentiles.worst.toFixed(2)}%\n` +
    simTable +
    `\n` +
    reasoning + `\n`
  );
}

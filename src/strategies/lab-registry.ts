/**
 * THE LAB — strategy registry (pure data, NO web/db deps).
 *
 * Split out of lab.ts so the backtest script and the live runner can import
 * the strategy list without pulling in the page/route layer.
 *
 * ── OLD BOOK REMOVED (Jun 25 2026) ──────────────────────────────────────────
 * The slow 4h Bollinger-MR + Donchian/SMA-trend book (L01–L10) and the 1h
 * maker-MR book (M09–M14) were retired from the public lab per the operator's
 * pivot to FASTER strategies. The kill-battery-proven funding-flip edge is held
 * in reserve (forward-validation pending). Fast strategies are in development.
 * Git history preserves the old definitions and the lab()/labMaker() stamping
 * helpers — re-add them when promoting a new validated strategy here.
 *
 * Promotion gate (unchanged): a strategy forward-tests on paper here
 * (track='lab' / 'lab-maker', isolated) and needs ≥15–20 net-positive paper
 * trades matching its backtest before any promotion to the live book.
 */

import type { CustomStrategy } from '../backtest/strategy.js';

export type LabStrategy = CustomStrategy & {
  launchedAt: number;
  longDescription?: string;
  /** Execution track: 'lab' = market-order runner (default), 'lab-maker' =
   *  limit-order (maker) runner. Drives which runner trades it + which
   *  commission the stats subtract. */
  track?: string;
};

export const LAB_TRACK = 'lab';
export const LAB_MAKER_TRACK = 'lab-maker';
/** Maker round-trip commission used for the maker book's net PnL — HL maker
 *  ×2 as an honest cushion for fill-risk (real maker ≈ 0.02% RT). */
export const LAB_MAKER_COMMISSION_RT_PCT = 0.04;
/** Taker round-trip commission for the MARKET lab book (custom-runner places
 *  market orders). HL taker ≈ 0.07% RT — the lab is HL-oriented, so it nets at
 *  HL fees, NOT the Bybit 0.11% the live copytrading product pays. */
export const LAB_COMMISSION_RT_PCT = 0.07;

// Empty — old book retired, new fast strategies in development (see header).
export const LAB_STRATEGIES: LabStrategy[] = [];
export const MAKER_LAB_STRATEGIES: LabStrategy[] = [];

/** Backtest reference: net %/trade per (former) strategy — kept as a historical
 *  yardstick for the forward-gate (lib/lab-gate.ts). Empty until a new strategy
 *  is promoted into the registry above. */
export const BT_NET_PCT_PER_TRADE: Record<string, number> = {};

/** Backtest max-drawdown % per strategy — risk measure for risk-parity sizing. */
export const BT_MAXDD_PCT: Record<string, number> = {};

export const ALL_LAB_STRATEGIES: LabStrategy[] = [...LAB_STRATEGIES, ...MAKER_LAB_STRATEGIES];
export const LAB_BY_CODE = new Map(ALL_LAB_STRATEGIES.map((s) => [s.code, s]));
export const LAB_BY_ID = new Map(ALL_LAB_STRATEGIES.map((s) => [s.id, s]));

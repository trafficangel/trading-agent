/**
 * Phase U — custom strategy interface. A strategy is pure code: given the
 * candle history up to (and including) the current bar, it returns a
 * desired position. The SAME module drives both the backtest engine and
 * (later) the live 5-min runner — so backtest == live, zero divergence.
 *
 * Contract:
 *   - decide(candles, i) sees candles[0..i] ONLY. Reading candles[>i] is a
 *     look-ahead bug; the engine never passes future bars.
 *   - Return the DESIRED position after bar i closes:
 *       'long' | 'short' = be in that direction
 *       'flat'           = close any open position, stay out
 *       null             = no change (hold whatever is open)
 *   - The engine handles entry/exit/flip/SL/commission mechanics.
 *
 * This mirrors our reverse-signal Track C strategies (position flips on
 * the opposite signal; flat closes), so the existing risk layer, fan-out
 * and trades-log/audit pipeline all apply unchanged.
 */

import type { Candle } from './indicators.js';

export type Signal = 'long' | 'short' | 'flat' | null;

/**
 * Maker (limit) execution intent — used ONLY by the live maker-runner, not
 * the backtest engine. A mean-reversion strategy rests a limit at the band
 * instead of crossing the spread:
 *   - flat → {kind:'entry', side, limit} = rest an entry limit at `limit`.
 *   - in position → {kind:'exit', limit} = rest an exit limit at the mean.
 *   - null = no resting order (cancel any pending / hold).
 * The runner fills only when a bar's range touches `limit`, and pays maker
 * fees. This is what turns the (taker-negative) low-TF MR edges positive.
 */
export type MakerQuote =
  | { kind: 'entry'; side: 'long' | 'short'; limit: number }
  | { kind: 'exit'; limit: number }
  | null;

export type CustomStrategy = {
  /** Stable id — also the trades-log filename and STRATEGY_CONFIGS key. */
  id: string;
  /** Display code (STRAT-0XX). */
  code: string;
  name: string;
  symbol: string;
  /** Bybit kline interval in minutes ('5','15','60','240'). */
  timeframe: string;
  /** Safety stop, fraction of entry (e.g. 0.05). The engine enforces it. */
  slPct: number;
  /** One-line human description for the announce/landing. */
  description: string;
  /** Indices below this are warmup — engine skips entries there. */
  warmup: number;
  /** The signal function. Pure; sees only candles[0..i] and the current
   *  position side (or null). The live runner passes the real position,
   *  so stateful logic (enter oversold, exit at mean) works identically
   *  in backtest and live. */
  decide: (candles: Candle[], i: number, pos: 'long' | 'short' | null) => Signal;
  /** OPTIONAL — maker (limit) execution intent for the live maker-runner.
   *  Strategies that implement it can be run as maker (rest a limit at the
   *  band) instead of market. The backtest engine ignores this. */
  quote?: (candles: Candle[], i: number, pos: 'long' | 'short' | null) => MakerQuote;
};

export type { Candle } from './indicators.js';

/**
 * Track C — LuxAlgo AI Strategy Builder per-strategy configuration.
 *
 * Each entry in STRATEGY_CONFIGS maps a strategy_id (chosen by the user
 * in their LuxAlgo alert template) to its execution parameters. The
 * trader (src/strategies/strategy-trader.ts) reads this map on every
 * webhook to decide:
 *   - is the strategy enabled?
 *   - what safety SL% to use?
 *   - is the symbol allowed for this strategy?
 *
 * **Adding a new strategy is a code change**, not a runtime tweak:
 *   1. Configure the strategy in LuxAlgo AI Builder.
 *   2. Share the backtest stats with the operator.
 *   3. Operator picks slPct (typically avg-loss × 1.3-1.5 buffer).
 *   4. Add the StrategyConfig row here, set enabled=true, commit.
 *   5. Configure entry+exit webhooks in LuxAlgo with matching strategy_id.
 *   6. Deploy.
 *
 * **Position sizing** is unified at $1000 notional per Track C trade
 * (matches the POSITION_NOTIONAL_USD constant used in daily-wrap for
 * shadow PnL display). There is intentionally no per-strategy size knob
 * — that level of tuning is unnecessary in shadow mode.
 */

export type StrategyConfig = {
  /** Must match the `strategy_id` field in webhook payloads. ≤64 chars. */
  id: string;
  /** Human-readable description. Surfaced in Telegram entry post. */
  description: string;
  /** Optional symbol pin. If set, webhook with a different symbol is
   *  rejected ('symbol_mismatch'). Leave undefined to accept any symbol. */
  symbol?: string;
  /** Informational — surfaced in Telegram post. Doesn't affect routing. */
  timeframe: string;
  /** Master switch for this strategy. Disabled strategies still receive
   *  webhooks but no positions are opened. */
  enabled: boolean;
  /** Safety stop-loss as a fraction of entry price. NO default — must be
   *  set explicitly per strategy based on backtest analysis. Examples:
   *  0.02 = 2%, 0.025 = 2.5%, 0.015 = 1.5%. */
  slPct: number;
};

/**
 * Registry of Track C strategies. Empty at start — operator populates
 * each entry after analyzing the strategy's backtest in LuxAlgo.
 */
export const STRATEGY_CONFIGS: Record<string, StrategyConfig> = {
  // Example template (commented out):
  // 'ton-cntr-tt-mf50': {
  //   id: 'ton-cntr-tt-mf50',
  //   description: 'Contrarian Any Bearish + Trend Tracer Bearish + MF > 50',
  //   symbol: 'TONUSDT',
  //   timeframe: '15',
  //   enabled: true,
  //   slPct: 0.020,
  // },
};

/** Look up a strategy by id. Returns null for unknown or unregistered ids. */
export function getStrategyConfig(id: string): StrategyConfig | null {
  return STRATEGY_CONFIGS[id] ?? null;
}

/** Notional position size for ALL Track C trades, in USD. Mirrors
 *  POSITION_NOTIONAL_USD in daily-wrap so PnL display is consistent. */
export const TRACK_C_NOTIONAL_USD = 1000;

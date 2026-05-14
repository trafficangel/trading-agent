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

/** Backtest snapshot taken from TradingView Strategy Tester with
 *  realistic commissions + position size, used for the public landing
 *  page. ALL fields are honest backtest results (not optimistic
 *  forward-tests). Period is operator-controlled (usually 90 days
 *  prior to strategy launch). */
export type BacktestSnapshot = {
  /** e.g. "Feb 12 — May 14, 2026" */
  periodLabel: string;
  /** Days the backtest covers (90, 180, etc.) */
  periodDays: number;
  /** Initial account balance used. */
  initialCapital: number;
  /** Notional per trade (same constant for the live system). */
  notionalUsd: number;
  /** Commission per side (Bybit USDT-perp taker: 0.00055). */
  commissionPctPerSide: number;

  /** Net profit/loss in USDT and percent. */
  netPnlUsd: number;
  netPnlPct: number;
  /** Annualised CAGR. */
  cagrPct: number;

  /** Trade counts. */
  totalTrades: number;
  wins: number;
  losses: number;
  /** Win rate 0..1 (60% = 0.6). */
  winRate: number;

  /** Profit factor (gross profit / gross loss). */
  profitFactor: number;
  /** Total commission paid over the period. */
  commissionPaidUsd: number;

  /** Max equity drawdown. */
  maxDrawdownPct: number;
  maxDrawdownUsd: number;

  /** Per-trade averages. */
  avgWinUsd: number;
  avgWinPct: number;
  avgLossUsd: number;
  avgLossPct: number;
  largestWinUsd: number;
  largestLossUsd: number;

  /** Long/short breakdown. */
  longTrades: number;
  longPnlPct: number;
  shortTrades: number;
  shortPnlPct: number;
};

export type StrategyConfig = {
  /** Must match the `strategy_id` field in webhook payloads. ≤64 chars.
   *  Internal identifier — used as map key + in self-review aggregation. */
  id: string;
  /** Short sequential numeric tag, e.g. '001', '002'. Used as the prominent
   *  `[STRAT-001]` prefix in Telegram posts for quick visual scanning. */
  code: string;
  /** Human-readable description in the structured format
   *  `<SYMBOL> <TF>m | LONG: <conditions> | SHORT: <conditions> | EXIT: <conditions>`.
   *  Shown on every entry/exit post for context. */
  description: string;
  /** Long-form prose explanation, for the public landing page. Optional. */
  longDescription?: string;
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
  /** When the strategy went live (unix ms). Used by landing page to scope
   *  "live performance since launch" stats. */
  launchedAt: number;
  /** Backtest snapshot for landing-page presentation. Optional — strategies
   *  without a backtest just don't render that section. */
  backtest?: BacktestSnapshot;
};

/**
 * Registry of Track C strategies. Empty at start — operator populates
 * each entry after analyzing the strategy's backtest in LuxAlgo.
 */
export const STRATEGY_CONFIGS: Record<string, StrategyConfig> = {
  // First registered strategy (May 14, 2026).
  // Backtest data scraped from LuxAlgo AI Strategy Builder via
  // `pnpm tsx scripts/import-strategy.ts` against
  //   https://www.luxalgo.com/chat/xff5y4hjob6d2qitfo1lhbxa/
  //
  // Period Oct 19 2025 → May 14 2026 (207 days, the FULL backtest window
  // since LuxAlgo's evaluation start — replacing earlier 91-day snapshot).
  //   - 104 trades, 76W / 28L → 73.08% WR
  //   - Profit factor 3.02
  //   - Max DD 0.95% (103.56 USDT) — exceptionally tight
  //   - Net +864.65 USDT (+86.47% on $1000 notional), CAGR 15.96%
  //   - Long 47 trades +194.32 USDT, Short 57 trades +670.33 USDT
  //   - Avg loss -15.26 USDT (-1.53%), worst loss -49.60 USDT (-4.96%)
  //
  // slPct=0.025 (2.5%) deliberately kept TIGHTER than the importer's
  // suggested 6.5% (90th-pct loss × 1.2). Importer's number lets the
  // strategy hit its own worst-case excursions; 2.5% acts as a safety
  // governor that caps the tail. After 10-20 live trades we revisit
  // based on observed sl_hit ratio (>20% → widen; near zero → confirm).
  'bnb-cntr-tt-mf50': {
    id: 'bnb-cntr-tt-mf50',
    code: '001',
    description:
      'BNB 15m | LONG: CONT Any Br + TT Br + MF>50 | SHORT: CONT Any Bl + TT Bl + MF<50 | EXIT: CONT Built-in',
    longDescription:
      'Контр-трендовая стратегия на 15-минутном таймфрейме с фильтрами по среднесрочному тренду (Trend Tracer) и денежному потоку (Money Flow). ' +
      'LONG-вход срабатывает когда Contrarian Any выдаёт bearish-сигнал (контр-индикатор разворота вверх), Trend Tracer показывает bearish-тренд (зона перепроданности) и Money Flow выше 50 (давление покупателей преобладает). ' +
      'SHORT — зеркально. ' +
      'Выход полностью передан встроенным exits стратегии — без фиксированных TP. Safety SL 2.5% страхует от случаев когда стратегия не закроет позицию вовремя.',
    symbol: 'BNBUSDT',
    timeframe: '15',
    enabled: true,
    slPct: 0.025,
    launchedAt: Date.parse('2026-05-14T12:00:00Z'),
    backtest: {
      periodLabel: 'Oct 19, 2025 — May 14, 2026',
      periodDays: 207,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 864.65,
      netPnlPct: 86.47,
      cagrPct: 15.96,
      totalTrades: 104,
      wins: 76,
      losses: 28,
      winRate: 0.7308,
      profitFactor: 3.020,
      commissionPaidUsd: 114.40,
      maxDrawdownPct: 0.95,
      maxDrawdownUsd: 103.56,
      avgWinUsd: 17.00,
      avgWinPct: 1.70,
      avgLossUsd: -15.26,
      avgLossPct: -1.53,
      largestWinUsd: 136.61,
      largestLossUsd: -49.60,
      longTrades: 47,
      longPnlPct: 19.43,
      shortTrades: 57,
      shortPnlPct: 67.03,
    },
  },
};

/** Look up a strategy by id. Returns null for unknown or unregistered ids. */
export function getStrategyConfig(id: string): StrategyConfig | null {
  return STRATEGY_CONFIGS[id] ?? null;
}

/** Notional position size for ALL Track C trades, in USD. Mirrors
 *  POSITION_NOTIONAL_USD in daily-wrap so PnL display is consistent. */
export const TRACK_C_NOTIONAL_USD = 1000;

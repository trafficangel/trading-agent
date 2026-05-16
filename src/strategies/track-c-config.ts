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
  /** Operator-defined alert identifier matching the TradingView alert
   *  name. Surfaced verbatim in Telegram posts AND on the landing page
   *  so subscribers can match a post to a source. Example:
   *  `BNBUSD|15|LONG=CONTAnyBr&TTBr&MFa50|SHORT=CONTAnyBl&TTBl&MFb50|EXIT=CONTBltExt` */
  alertName?: string;
  /** URL of the original LuxAlgo AI Builder chat that produced this
   *  strategy. Shown next to the alertName on the landing page so users
   *  can verify the source. Auto-populated by scripts/import-strategy.ts. */
  sourceUrl?: string;
  /** Short human-readable name for posts (e.g. "BNB Contrarian").
   *  Surfaced in Telegram entry/exit posts as the strategy label
   *  instead of the cryptic `description` string. If not set, falls
   *  back to `symbol + " " + timeframe + "m"`. */
  name?: string;
  /** When true, an incoming entry webhook on the OPPOSITE side of the
   *  currently-open position triggers an immediate close-and-reopen:
   *  the current position is force-closed at the incoming price with
   *  `force_close_reason='reverse_signal'`, then a new position opens
   *  on the new side.
   *
   *  **Default: true** — defense-in-depth. Every Track C strategy
   *  benefits from accepting BOTH paths to close:
   *    1. Explicit exit webhook (if the strategy has EXIT condition)
   *    2. Reverse-signal flip (if (1) is lost or doesn't fire)
   *
   *  Race safety: `forceClose` is idempotent — if path (1) closes
   *  first and (2) tries to close again, the second one no-ops.
   *  And `handleStrategyExit` has a stale-exit side-guard that
   *  ignores exits whose side no longer matches the open position
   *  (handles out-of-order delivery).
   *
   *  Set false ONLY if the strategy has unusual semantics where a
   *  reverse-direction signal is NOT meant to close the prior position
   *  (almost no real strategy works that way). */
  exitOnReverseSignal?: boolean;
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
  // Second registered strategy (May 16, 2026).
  // Backtest scraped from
  //   https://www.luxalgo.com/chat/p19leyc5pzvt3s32mj36rnzn
  // Period Oct 20 2025 → May 06 2026 (198 days, full LuxAlgo window).
  // Recomputed on our standard $1000 notional + Bybit commission:
  //   - 101 trades, 66W / 35L → 65.35% WR
  //   - Profit factor 2.59
  //   - Net +$1214.18 (+121.42% on $1000 notional), CAGR 223.8%
  //   - Max DD 19.23% ($192.28) — MUCH higher than STRAT-001 (0.95%)
  //   - Largest loss -$138.14 (-13.81%) — also significantly worse
  //   - Avg loss -$21.85 (-2.19%), avg win +$29.99 (+3.00%)
  //   - Long 51 trades +38.27%, Short 50 trades +83.15%
  //
  // SAFETY-SL CALIBRATION:
  // Importer suggested 6.5% (90th-pct loss × 1.2 buffer). Operator
  // chose 2.5% to match STRAT-001 — deliberately TIGHTER than the
  // strategy's natural worst-case excursions. Trade-off: the safety SL
  // will fire on ~25-30% of the strategy's natural losers (those with
  // adverse excursion > 2.5%), capping each at -2.5% instead of letting
  // them run to -5-14%. Expected effect on live PnL: lower expectancy
  // per trade but tighter max DD. Revisit after 10-20 live trades based
  // on observed sl_hit ratio + comparison to ideal (strategy_exit) PnL.
  //
  // STRATEGY FORMULATION (different from STRAT-001):
  //   LONG  = Contrarian Any Bullish + Trend Catcher Bearish + MF>50
  //   SHORT = Contrarian Any Bearish + Trend Catcher Bullish + MF<50
  //   EXIT  = none (position closes on reverse signal — i.e. SHORT
  //                 entry fires while LONG is open and vice-versa)
  // Note this uses Trend CATCHER (TC) not Trend TRACER (TT) like
  // STRAT-001 — different LuxAlgo indicator, same general idea.
  'xrp-cntr-tc-mf50': {
    id: 'xrp-cntr-tc-mf50',
    code: '002',
    description:
      'XRP 15m | LONG: CONT Any Bl + TC Br + MF>50 | SHORT: CONT Any Br + TC Bl + MF<50 | EXIT: reverse signal',
    longDescription:
      'Контр-трендовая стратегия на 15-минутном таймфрейме с фильтрами по среднесрочному тренду (Trend Catcher) и денежному потоку (Money Flow). ' +
      'LONG-вход срабатывает когда Contrarian Any выдаёт bullish-сигнал, Trend Catcher показывает bearish-тренд (зона перепроданности) и Money Flow выше 50. ' +
      'SHORT — зеркально. ' +
      'У стратегии нет встроенного exit условия — позиции закрываются по обратному сигналу (LONG закроется когда придёт SHORT entry и наоборот). ' +
      'Safety SL 2.5% страхует от резких движений между сигналами; в бектесте без него worst trade был −13.8%.',
    symbol: 'XRPUSDT',
    timeframe: '15',
    enabled: true,
    slPct: 0.025,
    launchedAt: Date.parse('2026-05-16T19:00:00Z'),
    alertName: 'XRPUSD|15|LONG=CONTAnyBl&TCBr&MFa50|SHORT=CONTAnyBr&TCBl&MFb50|EXIT=null',
    sourceUrl: 'https://www.luxalgo.com/chat/p19leyc5pzvt3s32mj36rnzn/',
    name: 'XRP Contrarian',
    // exitOnReverseSignal: default true (see StrategyConfig docs). For
    // this strategy reverse-signal is the ONLY close path apart from
    // safety SL (no explicit exit alert). For other strategies the
    // default acts as a fallback when the explicit exit webhook is
    // lost / delayed.
    backtest: {
      periodLabel: 'Oct 20, 2025 — May 6, 2026',
      periodDays: 198,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 1214.18,
      netPnlPct: 121.42,
      cagrPct: 223.83,
      totalTrades: 101,
      wins: 66,
      losses: 35,
      winRate: 0.6535,
      profitFactor: 2.588,
      commissionPaidUsd: 111.10,
      maxDrawdownPct: 19.23,
      maxDrawdownUsd: 192.28,
      avgWinUsd: 29.99,
      avgWinPct: 3.00,
      avgLossUsd: -21.85,
      avgLossPct: -2.19,
      largestWinUsd: 152.41,
      largestLossUsd: -138.14,
      longTrades: 51,
      longPnlPct: 38.27,
      shortTrades: 50,
      shortPnlPct: 83.15,
    },
  },

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
    alertName: 'BNBUSD|15|LONG=CONTAnyBr&TTBr&MFa50|SHORT=CONTAnyBl&TTBl&MFb50|EXIT=CONTBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/xff5y4hjob6d2qitfo1lhbxa/',
    name: 'BNB Contrarian',
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

/**
 * Format a per-strategy trade number into the user-facing trade ID.
 *
 *   BNB Contrarian, trade #1   → "BNB#001"
 *   XRP Contrarian, trade #42  → "XRP#042"
 *   universal strategy (no symbol pin), trade #5 → "S003#005"
 *
 * The format dropped the legacy "T#" prefix in May 2026 — it stood for
 * "Track C" back when we also had Track A (LLM) and Track B (signal-
 * trader). Now that Track C is the only system, a self-describing
 * symbol prefix beats an opaque "T". Trade IDs are also globally
 * unique without needing a separate `STRAT-NNN` badge alongside them.
 */
export function formatStrategyTradeId(cfg: StrategyConfig, tradeNum: number): string {
  const padded = tradeNum.toString().padStart(3, '0');
  // Strip USDT / USDC / USD suffix; fall back to `S<code>` for
  // strategies without a symbol pin (rare — they accept any symbol
  // and we'd be guessing if we used the webhook's incoming ticker).
  const base = cfg.symbol
    ? cfg.symbol.replace(/USD[TC]?$/i, '')
    : `S${cfg.code}`;
  return `${base}#${padded}`;
}

/**
 * Boot-time validation — call once from server.ts before accepting webhooks.
 *
 * Catches the silent-killer scenario: operator copy-pastes a StrategyConfig
 * and forgets to set `slPct`. At runtime that would produce `slDist=NaN`
 * → `sl=NaN` → SQLite stores NULL → tpsl-monitor's `price <= null` is
 * always false → safety SL never fires. Track C is also exempt from
 * the 24h time-guard, so the position stays open until reverse-signal
 * or explicit exit — potentially forever.
 *
 * Better to crash loud at boot than to discover this in production.
 *
 * Throws on the first invalid config it sees. Validates only enabled
 * strategies (disabled ones can have placeholder values).
 */
export function validateStrategyConfigs(): void {
  const errors: string[] = [];
  for (const [id, cfg] of Object.entries(STRATEGY_CONFIGS)) {
    if (cfg.id !== id) {
      errors.push(`STRATEGY_CONFIGS["${id}"].id is "${cfg.id}" — must match the map key`);
    }
    if (!cfg.enabled) continue; // disabled configs can be sloppy

    if (typeof cfg.slPct !== 'number' || !Number.isFinite(cfg.slPct) || cfg.slPct <= 0) {
      errors.push(`STRAT-${cfg.code} (${id}): slPct must be a finite positive number, got ${String(cfg.slPct)}`);
    } else if (cfg.slPct > 0.20) {
      // >20% SL means an order this far from entry is no longer a
      // "safety net" — almost certainly a typo (e.g. wrote 0.25 meaning
      // 0.025). Fail loud rather than silently take 25% losses.
      errors.push(`STRAT-${cfg.code} (${id}): slPct ${cfg.slPct} exceeds 20% — probable typo (did you mean ${(cfg.slPct / 10).toFixed(3)}?)`);
    }
    if (!cfg.code || !/^\d+$/.test(cfg.code)) {
      errors.push(`STRAT-${cfg.code} (${id}): code must be a numeric string like "001"`);
    }
    if (!cfg.timeframe) {
      errors.push(`STRAT-${cfg.code} (${id}): timeframe is required`);
    }
    if (!cfg.description) {
      errors.push(`STRAT-${cfg.code} (${id}): description is required`);
    }
    if (typeof cfg.launchedAt !== 'number' || Number.isNaN(cfg.launchedAt)) {
      errors.push(`STRAT-${cfg.code} (${id}): launchedAt must be a unix-ms number (use Date.parse('YYYY-MM-DD'))`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Invalid STRATEGY_CONFIGS — fix before starting:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

/** Notional position size for ALL Track C trades, in USD. Mirrors
 *  POSITION_NOTIONAL_USD in daily-wrap so PnL display is consistent. */
export const TRACK_C_NOTIONAL_USD = 1000;

/** Public landing-page base URL. Surfaced in Telegram posts (entry +
 *  exit) as the deep link `${base}/strategies/${cfg.code}`. Override
 *  via env LANDING_BASE_URL if you operate a staging instance. */
export const LANDING_BASE_URL =
  process.env.LANDING_BASE_URL ?? 'https://robotclaude.biz';

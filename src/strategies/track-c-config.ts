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
  // SAFETY-SL CALIBRATION (revised 2026-05-18):
  // Originally set to 2.5% (matching STRAT-001 tight-cap philosophy).
  // Revised to 15% after auditing all 7 strategies against actual loss
  // distributions — see commit "safety-sl: raise above p95 historical
  // losses, lift validator cap to 35%". Old 2.5% fired on ~25% of
  // natural losers, actively truncating the strategy's mean reversion.
  // New 15% sits above the worst historical loss (-13.7%) and only
  // fires on catastrophe (lost exit-webhook / exchange freeze).
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
      'Safety SL 15% — выше всех 34 исторических убытков (худший −13.8%, остальные ≤ −5.5%). Срабатывает только если пропадёт reverse-signal или биржа застрянет, в живой торговле почти всегда «спящий».',
    symbol: 'XRPUSDT',
    timeframe: '15',
    enabled: true,
    slPct: 0.15,
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

  // Third registered strategy (May 17, 2026).
  // Source: https://www.luxalgo.com/chat/dwfkaafmqd0ce3io4vjirb79
  // Trades log assembled from operator screenshots (scraper TF
  // detection got confused on this chat — fed 118 trades manually).
  //
  // Confirmation Any + Trend Catcher + Trend Strength Trending on
  // UNIUSDT 1h — an exceptionally high-win-rate setup that hunts
  // strong trends with momentum-confirmation filters.
  //
  // BACKTEST (Feb 5 2024 → May 12 2026, 827 days, recomputed on
  // $1000 notional + Bybit commission):
  //   - 118 trades, 104W / 14L → 88.14% WR
  //   - Profit factor 4.38 (Long 5.99 / Short 3.04)
  //   - Net +$4112.90 (+411% on $1000 notional) · CAGR 181.5%
  //   - Max DD $243.66 (24.4%) — driven by a single -24% trade (#38)
  //   - Avg win +$51 (+5.12%), avg loss -$87 (-8.69%)
  //   - 5 worst losses: -24%, -17%, -16%, -13%, -9%
  //   - Long 56 trades +263.7%, Short 62 trades +147.6%
  //   - Avg trade duration: 79h (≈3.3 days), avg ~1.5 trades/week
  //
  // SAFETY-SL CALIBRATION:
  // Set 10% (vs the 2.5% we use for BNB/XRP) because:
  //   - Only 14 of 118 trades lose at all (12%)
  //   - Of those 14, only 4 exceed -10% (the 24/17/16/13 cluster)
  //   - Avg natural loss is -8.7%, so SL at 5% would chop in half
  //     and would likely cut winners drawing-down during hold
  //   - 10% acts as catastrophe protection ONLY — won't fire on
  //     normal strategy losses, will save us from any tail event
  //     similar to the -24% trade
  // Revisit after 10-20 live trades based on observed sl_hit ratio.
  'uni-cfm-tc-tst': {
    id: 'uni-cfm-tc-tst',
    code: '003',
    description:
      'UNI 1h | LONG: CFM Any Bl + TC Br + TST Trending | SHORT: CFM Any Br + TC Bl + TST Trending | EXIT: CFM Built-in',
    longDescription:
      'Трендовая стратегия на часовом таймфрейме UNIUSDT, сочетающая сигналы Confirmation Any с фильтрами Trend Catcher и Trend Strength Trending. ' +
      'LONG-вход срабатывает когда Confirmation Any выдаёт bullish сигнал, Trend Catcher показывает bearish (контр-разворотная зона), и Trend Strength фиксирует трендовое состояние. ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Стратегия отличается экстремально высоким winrate (88%) и средней длительностью сделки около 3 дней. ' +
      'Safety SL 30% — выше p95 убытков (24.3%) и худшего трейда (−24.3%) за 2 года истории. Идея: дать стратегии полную свободу досидеть до встроенного exit-сигнала, а SL держать как страховку от потери вебхука. На 1h контр-трендовых стратегиях нормально сидеть в просадке −15-20% перед разворотом.',
    symbol: 'UNIUSDT',
    timeframe: '60',
    enabled: true,
    slPct: 0.30,
    launchedAt: Date.parse('2026-05-17T10:30:00Z'),
    alertName: 'UNIUSDT|60|LONG=CFMAnyBl&TCBr&TSTTr|SHORT=CFMAnyBr&TCBl&TSTTr|EXIT=CFMBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/dwfkaafmqd0ce3io4vjirb79/',
    name: 'UNI Trend Strength',
    // exitOnReverseSignal: default true. CFM has Built-in Exits so
    // explicit exit webhooks WILL fire, but the reverse-signal path
    // catches any lost/delayed exit as fallback.
    backtest: {
      periodLabel: 'Feb 5, 2024 — May 12, 2026',
      periodDays: 827,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 4112.90,
      netPnlPct: 411.29,
      cagrPct: 181.52,
      totalTrades: 118,
      wins: 104,
      losses: 14,
      winRate: 0.8814,
      profitFactor: 4.382,
      commissionPaidUsd: 129.80,
      maxDrawdownPct: 24.37,
      maxDrawdownUsd: 243.66,
      avgWinUsd: 51.24,
      avgWinPct: 5.12,
      avgLossUsd: -86.87,
      avgLossPct: -8.69,
      largestWinUsd: 737.63,
      largestLossUsd: -243.66,
      longTrades: 56,
      longPnlPct: 263.70,
      shortTrades: 62,
      shortPnlPct: 147.59,
    },
  },

  // Fourth registered strategy (May 17, 2026).
  // Source: https://www.luxalgo.com/chat/dwfkaafmqd0ce3io4vjirb79
  // (Same chat as STRAT-003 — LuxAlgo's "Dive Deeper" generated a
  // separate strategy variant for TRXUSDT on 1h.)
  //
  // Confirmation Any + Trend Tracer + Weak Confluence on TRXUSDT 1h.
  // Unusual filter combo: Bullish entry requires Trend Tracer
  // BULLISH (with trend) + Weak Bearish Confluence (counter-momentum
  // hint) — looks for setups where trend is intact but momentum is
  // softening.
  //
  // BACKTEST (Feb 3 2024 → May 14 2026, 831 days, recomputed on
  // $1000 notional + Bybit commission):
  //   - 114 trades, 99W / 15L → 86.84% WR
  //   - Profit factor 2.87 (Long 5.99 / Short 2.07 in LuxAlgo's
  //     unit-size; OUR recompute on $1000 notional shows lower PF
  //     because commission scales with position — see below)
  //   - Net +$1118.72 (+111.87% on $1000) · CAGR 49.14%
  //   - Max DD $241.66 (24.17%) — driven by 1 trade (-13.90%)
  //   - Avg win +$17.34 (+1.73%), avg loss -$39.86 (-3.99%)
  //   - 5 worst losses: -13.90%, -11.50%, -8.24%, -3.53%, -3.39%
  //   - Median loss: -2.45% (most losses are small)
  //   - Long 69 trades +88.57%, Short 45 trades +23.30%
  //
  // COMMISSION NOTE: LuxAlgo reports PF 4.05 on their unit-size
  // backtest. We report 2.87. The difference is honest commission
  // accounting — Bybit charges 0.055% × 2 sides = 0.11% round-trip,
  // which on $1000 notional × 114 trades = $125.40 total. On LuxAlgo's
  // unit size (~$0.20/trade), commission is $0.025 total — negligible.
  // Our PF is what you'd actually see at Bybit. Don't be confused by
  // the gap.
  //
  // SAFETY-SL CALIBRATION:
  // Set 5% — tighter than UNI's 10% because TRX losses are smaller
  // and more concentrated (only 3 of 15 exceed -5%, vs UNI where 5
  // of 14 exceed -10%). 5% catches the 3 worst (-13.9, -11.5, -8.2)
  // while leaving the typical -2.5% natural losses alone.
  'trx-cfm-tt-wc': {
    id: 'trx-cfm-tt-wc',
    code: '004',
    description:
      'TRX 1h | LONG: CFM Any Bl + TT Bullish + Weak Br Confluence | SHORT: CFM Any Br + TT Bearish + Weak Bl Confluence | EXIT: CFM Built-in',
    longDescription:
      'Трендовая стратегия на TRXUSDT 1h с необычным фильтром Weak Confluence — ищет ситуации когда тренд (Trend Tracer) подтверждён, но моментум начинает ослабевать в противоположную сторону. ' +
      'LONG-вход: Confirmation Any bullish сигнал + Trend Tracer Bullish (восходящий тренд) + Weak Bearish Confluence (слабый медвежий моментум как фильтр входа). ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Win rate 87% при 114 сделках за 2 года, дисциплинированный выход стратегии минимизирует крупные просадки. ' +
      'Safety SL 15% — выше всех 15 исторических убытков (худший −13.9%). Срабатывает только при потере exit-вебхука или зависании биржи; обычные мелкие минусы стратегия закрывает сама.',
    symbol: 'TRXUSDT',
    timeframe: '60',
    enabled: true,
    slPct: 0.15,
    launchedAt: Date.parse('2026-05-17T10:35:00Z'),
    alertName: 'TRXUSDT|60|LONG=CFMAnyBl&TTBl&WkBrCfl|SHORT=CFMAnyBr&TTBr&WkBlCfl|EXIT=CFMBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/dwfkaafmqd0ce3io4vjirb79/',
    name: 'TRX Weak Confluence',
    backtest: {
      periodLabel: 'Feb 3, 2024 — May 14, 2026',
      periodDays: 831,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 1118.72,
      netPnlPct: 111.87,
      cagrPct: 49.14,
      totalTrades: 114,
      wins: 99,
      losses: 15,
      winRate: 0.8684,
      profitFactor: 2.871,
      commissionPaidUsd: 125.40,
      maxDrawdownPct: 24.17,
      maxDrawdownUsd: 241.66,
      avgWinUsd: 17.34,
      avgWinPct: 1.73,
      avgLossUsd: -39.86,
      avgLossPct: -3.99,
      largestWinUsd: 106.53,
      largestLossUsd: -140.13,
      longTrades: 69,
      longPnlPct: 88.57,
      shortTrades: 45,
      shortPnlPct: 23.30,
    },
  },

  // Fifth registered strategy (May 18, 2026).
  // Source: https://www.luxalgo.com/chat/hwuqef4lmptf74imngdysti5
  // Operator-curated TIER S strategy from a manual selection.
  //
  // Contrarian Normal + Confirmation Downtrend + Neo Cloud on
  // TONUSDT 1h. Reversal hunter — Long fires on Contrarian Normal
  // Bullish trigger while Confirmation is in Downtrend and Neo Cloud
  // shows Bearish state (counter-trend entries with momentum-flip
  // confirmation).
  //
  // BACKTEST (Aug 30 2024 → May 1 2026, 608 days, recomputed on
  // $1000 notional + Bybit commission):
  //   - 102 trades, 90W / 12L → 88.24% WR
  //   - Profit factor 2.50 (LuxAlgo reports 3.19 on unit-size;
  //     commission impact at $1000 brings it down — see notes)
  //   - Net +$1468.92 (+146.89% on $1000 notional) · CAGR 88%
  //   - Max DD $249.29 (24.93%) — one -22.72% tail trade
  //   - Avg win +$27.18 (+2.72%), avg loss -$81.43 (-8.14%)
  //   - Median loss -8.3% (concentrated cluster, not skewed)
  //   - 5 worst losses: -22.72%, -14.72%, -12.42%, -11.43%, -9.58%
  //   - Long 55 trades +70.2%, Short 47 trades +76.7%
  //
  // SAFETY-SL CALIBRATION:
  // Operator's initial suggestion was SL 0.8% — far too tight.
  // The strategy's NATURAL losses cluster around -8% (median).
  // A 1% SL would fire on every trade, killing it. Set 10% to
  // match UNI's profile: catch the catastrophic tail (-22% trade
  // capped, possibly -14%, -12% too) while leaving the normal
  // -8% operational losses to play out as the strategy intended.
  // The Confirmation Builtin-Exit handles those internally.
  'ton-cntr-cfm-neo': {
    id: 'ton-cntr-cfm-neo',
    code: '005',
    description:
      'TON 1h | LONG: CNTR Normal Bl + CFM Downtrend + Neo Cloud Br | SHORT: CNTR Normal Br + CFM Uptrend + Neo Cloud Bl | EXIT: CNTR Built-in',
    longDescription:
      'Контр-трендовая стратегия на TONUSDT 1h: ищет развороты тренда с подтверждением через Confirmation и Neo Cloud. ' +
      'LONG-вход: Contrarian Normal выдаёт бычий сигнал, при этом Confirmation в нисходящем тренде и Neo Cloud в bearish-состоянии — классическая reversal-сетап с momentum-flip фильтрами. ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Win rate 88% за 600+ дней истории, средняя длительность сделки ~92 часа (~4 дня). ' +
      'Safety SL 25% — выше p95 убытков (22.7%) и худшего трейда. Контр-трендовая 4-дневная сделка регулярно сидит в просадке −10-15% до разворота; SL держим только как страховку от потери exit-вебхука.',
    symbol: 'TONUSDT',
    timeframe: '60',
    enabled: true,
    slPct: 0.25,
    launchedAt: Date.parse('2026-05-18T11:00:00Z'),
    alertName: 'TONUSDT|60|LONG=CNTRNormBl&CFMDn&NeoCloudBr|SHORT=CNTRNormBr&CFMUp&NeoCloudBl|EXIT=CNTRBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/hwuqef4lmptf74imngdysti5/',
    name: 'TON Contrarian Neo',
    backtest: {
      periodLabel: 'Aug 30, 2024 — May 1, 2026',
      periodDays: 608,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 1468.92,
      netPnlPct: 146.89,
      cagrPct: 88.18,
      totalTrades: 102,
      wins: 90,
      losses: 12,
      winRate: 0.8824,
      profitFactor: 2.503,
      commissionPaidUsd: 112.20,
      maxDrawdownPct: 24.93,
      maxDrawdownUsd: 249.29,
      avgWinUsd: 27.18,
      avgWinPct: 2.72,
      avgLossUsd: -81.43,
      avgLossPct: -8.14,
      largestWinUsd: 127.37,
      largestLossUsd: -228.32,
      longTrades: 55,
      longPnlPct: 70.23,
      shortTrades: 47,
      shortPnlPct: 76.67,
    },
  },

  // Sixth registered strategy (May 18, 2026).
  // Source: https://www.luxalgo.com/chat/k4a2u1wnjp3jrjdcftz1rfl2
  // Operator-curated TIER S — highest CAGR in the portfolio.
  //
  // Contrarian Normal + Trend Strength Ranging + Strong Confluence
  // on HBARUSDT 1h. Hunts reversals during ranging market phases.
  // Note the CONTRARIAN trigger inverts: Long fires on Bearish
  // signal, Short on Bullish — classic mean-reversion logic with
  // Strong Confluence as the momentum filter.
  //
  // BACKTEST (Feb 4 2024 → May 15 2026, 831 days):
  //   - 117 trades, 79W / 38L → 67.52% WR (lowest in TIER S)
  //   - PF 3.27 (close to LuxAlgo's 3.02)
  //   - Net +$5363.41 (+536.34%) — highest absolute payoff
  //   - CAGR 235.58% — best in portfolio
  //   - Max DD $361.26 (36.13%) — also the highest
  //   - Avg win +$97.78 (+9.78%), avg loss -$62.14 (-6.21%)
  //   - Median loss: -4.62%
  //   - 5 worst: -26.64, -20.35, -16.67, -15.97, -10.19
  //   - Long 42 trades +335%, Short 75 trades +201%
  //   - Strategy is short-heavy (Long WR 54.76% vs Short 74.67%)
  //
  // R:R profile is the key — Avg win (+9.78%) > Avg loss (-6.21%)
  // means even with 67% WR the expectancy is strong positive.
  //
  // SAFETY-SL CALIBRATION:
  // Operator suggested 1.0% — would fire on every trade (median
  // loss is -4.62%). Set 10% to catch the catastrophic tail (5
  // trades exceed -10%, with -26% the worst). Same defensive
  // approach as UNI and TON — tail-event protection without
  // interfering with normal operational losses.
  'hbar-cntr-tsr-scfl': {
    id: 'hbar-cntr-tsr-scfl',
    code: '006',
    description:
      'HBAR 1h | LONG: CNTR Normal Br + TS Ranging + Strong Bl Cfl | SHORT: CNTR Normal Bl + TS Ranging + Strong Br Cfl | EXIT: CNTR Built-in',
    longDescription:
      'Контр-трендовая стратегия на HBARUSDT 1h, специализирующаяся на разворотах в боковых движениях рынка. ' +
      'LONG-вход срабатывает когда Contrarian Normal выдаёт МЕДВЕЖИЙ сигнал (как контр-индикатор разворота вверх), Trend Strength показывает Ranging (боковое движение), и Strong Bullish Confluence подтверждает накопление покупателей. ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Contrarian Builtin-Exits. ' +
      'Win rate 67.52% — ниже чем у других стратегий портфеля, но компенсируется отношением риск/прибыль: средний выигрыш +9.78% против среднего убытка −6.21%. ' +
      'Самая доходная стратегия портфеля: +536% за 831 день (CAGR 235%). ' +
      'Safety SL 28% — выше p95 (20.4%) и второго худшего трейда (−20.4%); единственный исторический выброс −26.6%. На таком соотношении R:R стратегия часто сидит в глубокой просадке перед разворотом — ранний выход safety-стопом превращает потенциальный winner в фиксированный убыток. Держим SL как страховку от пропажи exit-вебхука.',
    symbol: 'HBARUSDT',
    timeframe: '60',
    enabled: true,
    slPct: 0.28,
    launchedAt: Date.parse('2026-05-18T11:30:00Z'),
    alertName: 'HBARUSDT|60|LONG=CNTRNormBr&TSRng&StrongBlCfl|SHORT=CNTRNormBl&TSRng&StrongBrCfl|EXIT=CNTRBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/k4a2u1wnjp3jrjdcftz1rfl2/',
    name: 'HBAR Contrarian Ranging',
    backtest: {
      periodLabel: 'Feb 4, 2024 — May 15, 2026',
      periodDays: 831,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 5363.41,
      netPnlPct: 536.34,
      cagrPct: 235.58,
      totalTrades: 117,
      wins: 79,
      losses: 38,
      winRate: 0.6752,
      profitFactor: 3.272,
      commissionPaidUsd: 128.70,
      maxDrawdownPct: 36.13,
      maxDrawdownUsd: 361.26,
      avgWinUsd: 97.78,
      avgWinPct: 9.78,
      avgLossUsd: -62.14,
      avgLossPct: -6.21,
      largestWinUsd: 1157.02,
      largestLossUsd: -267.48,
      longTrades: 42,
      longPnlPct: 335.23,
      shortTrades: 75,
      shortPnlPct: 201.12,
    },
  },

  // Seventh registered strategy (May 18, 2026).
  // Source: https://www.luxalgo.com/chat/kc1ibd3cc9ubbr33z7k5sci5
  // Operator-curated TIER S — fast 5m timeframe, fresh backtest.
  //
  // ⚠ SHORT BACKTEST: only 69 days of history (vs 600-800 for others).
  // CAGR 117% is extrapolated from 2.3 months — treat as preliminary
  // until 3-6 more months accumulate.
  //
  // BACKTEST (Mar 8 2026 → May 16 2026, 69 days, $1000 notional):
  //   - 155 trades, 116W / 39L → 74.84% WR (our count differs from
  //     LuxAlgo's 83.87% — they treat break-even as wins, we count
  //     commission impact, so trades with raw +0% become -$1.10 losers)
  //   - PF 1.99 (LuxAlgo reports 3.02 on unit-size; commission eats
  //     nearly half the gross profit at $1000 notional — see notes)
  //   - Net +$222.12 (+22.21%) · CAGR 117.5%
  //   - Max DD $52.94 (5.29%)
  //   - Avg win +$3.86 (+0.39%), avg loss -$5.78 (-0.58%)
  //   - Median loss: -0.41% (very small typical moves)
  //   - 5 worst losses: -2.99%, -2.98%, -2.49%, -2.38%, -1.56%
  //   - Long 72 trades +14.8%, Short 83 trades +7.4%
  //   - Avg duration 66.92 bars (5.5 hours on 5m) — fast turnover
  //   - Avg 2.72 trades/day
  //
  // COMMISSION REALITY CHECK:
  // 155 trades × 0.11% round-trip = 17.05% paid in commission alone.
  // Gross profit ~39%, commission $170, net $222. This is a HIGH-FREQUENCY
  // strategy where Bybit's 0.055%×2 fee structure materially eats the edge.
  // LuxAlgo's unit-size backtest (~$0.025 total commission) shows PF 3.02.
  // Ours shows 1.99 — still profitable but visitors comparing to LuxAlgo
  // need to understand the gap.
  //
  // SAFETY-SL CALIBRATION (revised 2026-05-18):
  // Operator suggested 0.8% (too tight, fires on most normal trades).
  // Initially set to 2.5%, then revised to 4% during the 2026-05-18
  // portfolio-wide SL audit. Sits above all 22 historical losses
  // (worst -2.99%) so only fires on catastrophe — the strategy's
  // built-in exit handles normal moves in the -0.5% range.
  'bch-cntr-cfm-tc': {
    id: 'bch-cntr-cfm-tc',
    code: '007',
    description:
      'BCH 5m | LONG: CNTR Normal Bl + CFM Downtrend + TC Bl | SHORT: CNTR Normal Br + CFM Uptrend + TC Br | EXIT: CNTR Built-in',
    longDescription:
      'Высокочастотная контр-трендовая стратегия на BCHUSDT 5m: ищет краткосрочные развороты с подтверждением через Confirmation и Trend Catcher. ' +
      'LONG-вход: Contrarian Normal Bullish сигнал + Confirmation Downtrend (тренд вниз = зона перепроданности) + Trend Catcher Bullish (момент развернулся вверх). ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Contrarian Builtin-Exits. ' +
      'Win rate 75% на $1000 размере (LuxAlgo показывает 84% на unit-size без учёта комиссии). ' +
      'Средняя длительность сделки ~5.5 часов, средняя частота 2-3 сделки в день. ' +
      'ВАЖНО: 155 сделок за 2.3 месяца = $170 уплаченной комиссии (0.11% × 155 = 17% от капитала). На высокочастотной 5m стратегии комиссия съедает почти половину валовой прибыли — это честно отражено в наших цифрах. ' +
      'Safety SL 4% — выше всех 22 исторических убытков (худший −2.99%). Срабатывает только при пропаже exit-вебхука; обычные минусы стратегия закрывает сама в районе −0.5%. ' +
      'Бэктест короткий — всего 2.3 месяца. Цифры предварительные, ждём накопления реальной статистики.',
    symbol: 'BCHUSDT',
    timeframe: '5',
    enabled: true,
    slPct: 0.04,
    launchedAt: Date.parse('2026-05-18T12:00:00Z'),
    alertName: 'BCHUSDT|5|LONG=CNTRNormBl&CFMDn&TCBl|SHORT=CNTRNormBr&CFMUp&TCBr|EXIT=CNTRBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/kc1ibd3cc9ubbr33z7k5sci5/',
    name: 'BCH Contrarian Scalper',
    backtest: {
      periodLabel: 'Mar 8, 2026 — May 16, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 222.12,
      netPnlPct: 22.21,
      cagrPct: 117.50,
      totalTrades: 155,
      wins: 116,
      losses: 39,
      winRate: 0.7484,
      profitFactor: 1.985,
      commissionPaidUsd: 170.50,
      maxDrawdownPct: 5.29,
      maxDrawdownUsd: 52.94,
      avgWinUsd: 3.86,
      avgWinPct: 0.39,
      avgLossUsd: -5.78,
      avgLossPct: -0.58,
      largestWinUsd: 27.30,
      largestLossUsd: -31.00,
      longTrades: 72,
      longPnlPct: 14.83,
      shortTrades: 83,
      shortPnlPct: 7.38,
    },
  },

  // STRAT-008 — BTC 5m Confirmation Strong + Trend Strength Trending
  // ----------------------------------------------------------------
  // Operator's TIER S pick #4 (last in current batch). LuxAlgo's
  // unit-size backtest shows blockbuster numbers (PF 3.09, +25K USDT,
  // 85.29% WR, MaxDD 11.97%) over Mar 7 - May 15, 2026 (68 days).
  //
  // Recomputed on our standard $1000 notional + 0.11% Bybit round-trip:
  //   - 102 trades, 79W / 23L → 77.45% WR (lower than LuxAlgo because
  //     commission flips ~8 small breakeven wins into net losses)
  //   - Profit factor 2.18 (vs LuxAlgo 3.09)
  //   - Net +$222.87 (+22.29%) · CAGR 119.1%
  //   - Max DD $39.27 (3.93%) — much tighter than LuxAlgo's compounding-
  //     based 11.97%, since fixed notional doesn't amplify on drawdowns
  //   - Commission paid: $112.20 (50% of gross loss!)
  //   - Long 51 trades, 82.4% WR, +$182
  //   - Short 51 trades, 72.5% WR, +$41 (asymmetric — long edge dominates)
  //   - Avg duration 110 bars (~9 hours on 5m)
  //   - ~1.96 trades/day
  //
  // COMMISSION REALITY CHECK (same as BCH/STRAT-007):
  // 102 trades × 0.11% = 11.2% paid in commission. Less brutal than BCH
  // (155 trades) but still material. On 5m strategies with sub-1% median
  // moves, the spread + fee structure compresses Bybit edge significantly.
  //
  // SAFETY-SL CALIBRATION:
  // Loss distribution: median -0.40%, p95 -3.38%, worst -3.54%.
  // 21 of 23 losses are ≤ -2.07%; only 2 fat-tail trades exceed -3%.
  // Set 5% as catastrophe-only cap: well above all 23 historical
  // losses with ~40% buffer, so safety SL almost never fires unless
  // exit-webhook is genuinely lost.
  //
  // STRATEGY FORMULATION:
  //   LONG  = Confirmation Strong Bearish + Trend Strength Trending
  //   SHORT = Confirmation Strong Bullish + Trend Strength Trending
  //   EXIT  = Confirmation Built-in Exits
  //
  // Note "Confirmation Strong" (the stricter variant) instead of
  // "Confirmation Any" — fewer signals but higher per-trade quality.
  'btc-cfm-strong-tst': {
    id: 'btc-cfm-strong-tst',
    code: '008',
    description:
      'BTC 5m | LONG: CFM Strong Br + TST Trending | SHORT: CFM Strong Bl + TST Trending | EXIT: CFM Built-in',
    longDescription:
      'Трендовая стратегия на BTCUSDT 5m с фильтром по силе тренда (Trend Strength Trending). ' +
      'LONG-вход срабатывает когда Confirmation Strong выдаёт bearish-сигнал в трендовой фазе рынка (рынок чётко идёт куда-то, и сильный contrarian-сигнал говорит «здесь разворот»). ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Используется СТРОГИЙ вариант Confirmation Strong (не Any) — даёт меньше сигналов, но более качественных. ' +
      'Win rate 77% на $1000 размере (LuxAlgo показывает 85% на unit-size без учёта комиссии). ' +
      'Long-сторона значительно сильнее short (82% vs 72% WR), что характерно для BTC в бычьем рынке 2026. ' +
      'Средняя длительность сделки ~9 часов, средняя частота ~2 сделки в день. ' +
      'ВАЖНО: 102 сделки за 2.3 месяца = $112 уплаченной комиссии (11% от капитала). На 5m стратегиях с медианным движением сделки ~0.4% комиссия Bybit съедает существенную часть edge — это честно отражено в наших цифрах PF 2.18 (LuxAlgo 3.09 на unit-size). ' +
      'Safety SL 5% — выше всех 23 исторических убытков (худший −3.54%) с буфером ~40%. Срабатывает только при катастрофе; обычные минусы стратегия закрывает сама. ' +
      'Бэктест короткий — всего 2.3 месяца. Цифры предварительные, ждём накопления реальной статистики.',
    symbol: 'BTCUSDT',
    timeframe: '5',
    enabled: true,
    slPct: 0.05,
    launchedAt: Date.parse('2026-05-19T00:00:00Z'),
    alertName: 'BTCUSDT|5|LONG=CFMStrongBr&TSTTr|SHORT=CFMStrongBl&TSTTr|EXIT=CFMBltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/pqw04cy9q2unzkju7afj5ihh/',
    name: 'BTC Confirmation Strong',
    backtest: {
      periodLabel: 'Mar 7, 2026 — May 15, 2026',
      periodDays: 68,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 222.87,
      netPnlPct: 22.29,
      cagrPct: 119.13,
      totalTrades: 102,
      wins: 79,
      losses: 23,
      winRate: 0.7745,
      profitFactor: 2.181,
      commissionPaidUsd: 112.20,
      maxDrawdownPct: 3.93,
      maxDrawdownUsd: 39.27,
      avgWinUsd: 5.21,
      avgWinPct: 0.52,
      avgLossUsd: -8.20,
      avgLossPct: -0.82,
      largestWinUsd: 17.10,
      largestLossUsd: -35.44,
      longTrades: 51,
      longPnlPct: 18.21,
      shortTrades: 51,
      shortPnlPct: 4.08,
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
      'Выход полностью передан встроенным exits стратегии — без фиксированных TP. Safety SL 7.5% — выше всех 28 исторических убытков (худший −6.0%, медиана −1.1%). Срабатывает только в катастрофическом случае (потеря exit-вебхука / зависание биржи); обычные минусы стратегия закрывает сама.',
    symbol: 'BNBUSDT',
    timeframe: '15',
    enabled: true,
    slPct: 0.075,
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
    } else if (cfg.slPct > 0.35) {
      // >35% SL means an order this far from entry is no longer a
      // "safety net" — almost certainly a typo (e.g. wrote 0.4 meaning
      // 0.04). Fail loud rather than silently take 40% losses.
      //
      // Cap raised from 20% to 35% on 2026-05-18 after re-analyzing
      // 1h contrarian strategies (UNI/TON/HBAR) — they regularly hold
      // through 20-26% adverse excursions before reversing. A 20% cap
      // would force-close winning trades at the worst possible moment.
      // The safety SL should sit ABOVE the historical p95 loss, not
      // inside the strategy's natural noise band.
      errors.push(`STRAT-${cfg.code} (${id}): slPct ${cfg.slPct} exceeds 35% — probable typo (did you mean ${(cfg.slPct / 10).toFixed(3)}?)`);
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

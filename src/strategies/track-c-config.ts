import type { TierId } from './tier-config.js';

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
 *   4. Operator picks `minTier` — controls which paying tiers see it:
 *        - 'starter': low-band flagship (BNB/BTC/BCH/ETH-class)
 *        - 'standard'/'plus': validated medium-band
 *        - 'prof': extreme-band OR untested (manual users only)
 *        - null: never in any tier (operator-only)
 *      Adding to a tier propagates automatically — NO tier-config edits.
 *   5. Add the StrategyConfig row here, set enabled=true, commit.
 *   6. Configure entry+exit webhooks in LuxAlgo with matching strategy_id.
 *   7. Deploy.
 *
 * After deploy: `pnpm tsx scripts/announce-strategy.ts <code>` to push
 * an entry post to the @robotclaude channel.
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
  /** TRACK E (tier system) — risk band classification. Drives which
   *  tiers can include this strategy without operator-explicit listing.
   *    - low      → DD ≤ 6%   (BNB-class, very safe)
   *    - medium   → DD 6-15%  (XRP-class, moderate)
   *    - high     → DD 15-25% (TRX/UNI/TON-class, aggressive)
   *    - extreme  → DD > 25%  (HBAR-class, only for VIP / operator override) */
  riskBand?: 'low' | 'medium' | 'high' | 'extreme';
  /** TRACK E — whether this strategy is eligible for inclusion in
   *  public tier-packages. false = available only via VIP override
   *  (operator hand-picks for whale users). Default true. Used to
   *  exclude TON/UNI/HBAR (large SL = scary marketing) from tiers. */
  tierEligible?: boolean;
  /** TRACK E (May 25, 2026) — minimum tier where this strategy auto-
   *  appears. Strategy is included in this tier AND all higher tiers
   *  (TIER_ORDER ranks: starter < standard < plus < pro < vip < prof).
   *  Null = never in any tier (operator-only — webhook still works for
   *  testing, but tier-assignment skips this strategy).
   *
   *  When adding a new strategy, pick by risk band:
   *    - low band (DD ≤ 8%): 'starter' — flagship coin, all paying tiers
   *    - medium band (DD 8-15%): 'standard' or 'plus' depending on quality
   *    - high band (DD 15-25%): 'plus' or 'prof'
   *    - extreme band (DD > 25%): 'prof' — manual users only
   *    - any untested / experimental: 'prof' until ≥10 live trades validate
   *    - null: NEVER in any tier (testing / disabled / operator-only)
   *
   *  ONE field controls tier composition. Adding `minTier: 'standard'` to
   *  a new strategy makes it auto-appear in Standard/Plus/Pro/VIP/Prof
   *  next deploy — no tier-config edits, no copy updates needed. */
  minTier: TierId | null;
  /** TRACK E — maximum leverage that keeps the safety SL firing BEFORE
   *  Bybit-side liquidation. Computed once from slPct using:
   *    floor((1 - 0.30) / (slPct + 0.02))
   *  where 0.30 = margin safety buffer (funding/fees/maintenance), 0.02
   *  = slippage assumption between SL trigger and actual fill.
   *  If omitted, runtime falls back to default leverage from tier. */
  maxSafeLeverage?: number;
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

  /** Phase T — live-validation gate. `false` = shadow-only: the strategy
   *  trades the public shadow track but does NOT fan out to user Bybit
   *  accounts. New strategies MUST start at `false`; flip to `true` only
   *  after 15–20 closed shadow trades with positive net (incl. 0.11%
   *  commission). Exits/closes are never gated — flipping true→false
   *  with open user rows still lets fanOutExit close them. */
  fanOut: boolean;

  /** How the strategy exits — purely cosmetic, used by the announce post.
   *  'builtin' (default) = strategy has its own Builtin Exits.
   *  'reverse' = no builtin exit; position closes on the opposite signal
   *  (our reverse_signal flip). Does NOT change trading logic. */
  exitMode?: 'builtin' | 'reverse';
};

/**
 * Registry of Track C strategies. Empty at start — operator populates
 * each entry after analyzing the strategy's backtest in LuxAlgo.
 */
/**
 * Phase Q (May 28, 2026) — global hard cap on safety SL, raised to 8%.
 *
 * History:
 *   Phase P set the cap to 5% based on a CUT-RATE verdict (incompatible
 *   if >25% of historical losses exceed cap). That metric overestimated
 *   the damage: many "cut" trades would have recovered or closed at a
 *   smaller loss than the cap. Phase Q replaces it with a PnL-SIMULATION
 *   verdict: for each candidate cap, simulate what the strategy's net
 *   PnL would have been if SL had been active. Strategies are compatible
 *   if simulated PnL > 0 and ≥ 80% of the no-cap PnL.
 *
 *   Under the simulation lens, all 9 strategies turn out highly profitable
 *   at per-strategy SLs in the 5-8% range. UNI/TON/HBAR — previously
 *   disabled as "wide-SL strategies" — are massively profitable at 6-7%
 *   SL because the cap saves them from catastrophic 25-30% excursions
 *   while leaving the natural winners intact.
 *
 *   The 8% cap balances operator preference for ≤7-8% per-trade losses
 *   ("не допускала вот таких вот огромных просадок") with strategies'
 *   need for breathing room. Per-strategy slPct is set individually based
 *   on the simulation output — most sit at 6-8%, BCH/BTC at 7% since
 *   their natural worst MAEs are tiny.
 */
export const MAX_SAFE_SL_PCT = 0.08;

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
    // TRACK E — Phase Q (May 28, 2026): SL 5% → 8% based on PnL-simulation.
    // On TV-verified MAE data, simulated $1000-notional PnL across caps:
    //   3% SL: $720 (PF 1.66, DD 17%)
    //   5% SL: $762 (PF 1.64, DD 28%)
    //   7% SL: $807 (PF 1.70, DD 29%)
    //   8% SL: $1027 (PF 2.08, DD 18%)  ← best in operator's 5-8% range
    //   ∞:    $1214 (PF 2.59, DD 19%)
    // 8% cap delivers 85% of no-cap PnL while keeping worst trade at −8%.
    // Above 8% is outside operator's stated «до 7-8%» tolerance.
    riskBand: 'high',
    tierEligible: true,
    minTier: 'standard',
    maxSafeLeverage: 7,
    description:
      'XRP 15m | LONG: CONT Any Bl + TC Br + MF>50 | SHORT: CONT Any Br + TC Bl + MF<50 | EXIT: reverse signal',
    longDescription:
      'Контр-трендовая стратегия на 15-минутном таймфрейме с фильтрами по среднесрочному тренду (Trend Catcher) и денежному потоку (Money Flow). ' +
      'LONG-вход срабатывает когда Contrarian Any выдаёт bullish-сигнал, Trend Catcher показывает bearish-тренд (зона перепроданности) и Money Flow выше 50. ' +
      'SHORT — зеркально. ' +
      'У стратегии нет встроенного exit условия — позиции закрываются по обратному сигналу (LONG закроется когда придёт SHORT entry и наоборот). ' +
      'Safety SL 8% — выбран по PnL-симуляции: при 8% PF 2.08, max DD 17.6%, ожидаемый Net PnL +103% за 198 дней на $1000. В 78% сделок страховка не срабатывает — стратегия закрывается своим reverse-signal.',
    symbol: 'XRPUSDT',
    timeframe: '15',
    enabled: false,
    fanOut: true,
    slPct: 0.08,
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
    // TRACK E — Phase Q (May 28, 2026): re-enabled at slPct 7% (was
    // disabled in Phase P due to wide-SL verdict). PnL-simulation showed
    // catastrophic mistake in Phase P logic — at 7% cap:
    //   $2481 (+248% on $1000), PF 2.28, DD 26.1%, worst −7%
    // Cap saves the strategy from one −30% excursion (TV-verified) while
    // leaving its 75% win rate intact. minTier stays at 'prof' until live
    // performance validates — DD 26% is still bigger than starter tier
    // promise of «≤8%».
    riskBand: 'high',
    tierEligible: true,
    minTier: 'prof',
    maxSafeLeverage: 8,
    description:
      'UNI 1h | LONG: CFM Any Bl + TC Br + TST Trending | SHORT: CFM Any Br + TC Bl + TST Trending | EXIT: CFM Built-in',
    longDescription:
      'Трендовая стратегия на часовом таймфрейме UNIUSDT, сочетающая сигналы Confirmation Any с фильтрами Trend Catcher и Trend Strength Trending. ' +
      'LONG-вход срабатывает когда Confirmation Any выдаёт bullish сигнал, Trend Catcher показывает bearish (контр-разворотная зона), и Trend Strength фиксирует трендовое состояние. ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Стратегия отличается экстремально высоким winrate (88%) и средней длительностью сделки около 3 дней. ' +
      'Safety SL 7% — выбран по PnL-симуляции (Phase Q): +248% за 827 дней на $1000, PF 2.28, max DD 26%. Cap спасает от худших 25-30% экскурсий, оставляя 75% win-rate нетронутым.',
    symbol: 'UNIUSDT',
    timeframe: '60',
    // Phase R (May 29 2026): DISABLED — operator removed all 1h strategies
    // from the product. Config kept (history/landing detail still resolve);
    // enabled:false hides it from tiers, landing list and fan-out.
    enabled: false,
    fanOut: false,
    slPct: 0.07,
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
    // Phase Q: re-enabled at slPct 5% (best PnL in 5-8% range).
    // Simulation: $625 (+62%), PF 1.72, DD 15%, worst −5%.
    // Wider SL hurts: at 7% only $649 with DD 19.9% — diminishing returns.
    riskBand: 'medium',
    tierEligible: true,
    minTier: 'plus',
    maxSafeLeverage: 10,
    description:
      'TRX 1h | LONG: CFM Any Bl + TT Bullish + Weak Br Confluence | SHORT: CFM Any Br + TT Bearish + Weak Bl Confluence | EXIT: CFM Built-in',
    longDescription:
      'Трендовая стратегия на TRXUSDT 1h с необычным фильтром Weak Confluence — ищет ситуации когда тренд (Trend Tracer) подтверждён, но моментум начинает ослабевать в противоположную сторону. ' +
      'LONG-вход: Confirmation Any bullish сигнал + Trend Tracer Bullish (восходящий тренд) + Weak Bearish Confluence (слабый медвежий моментум как фильтр входа). ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Win rate 87% при 114 сделках за 2 года, дисциплинированный выход стратегии минимизирует крупные просадки. ' +
      'Safety SL 5% — выбран по PnL-симуляции (Phase Q): +63% на $1000, PF 1.72, max DD 15%, худшая сделка −5%. Тугой стоп оптимален для TRX — широкий SL не добавляет доходности.',
    symbol: 'TRXUSDT',
    timeframe: '60',
    // Phase R (May 29 2026): DISABLED — 1h strategies removed from product.
    enabled: false,
    fanOut: false,
    slPct: 0.05,
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
    // Phase Q: re-enabled at slPct 7%. Simulation: $1162 (+116%), PF 2.02,
    // DD 17.5%, worst −7%, win rate 83%. Cap IMPROVES results vs no-cap
    // ($1093, DD 60%) — saves from worst excursions.
    riskBand: 'high',
    tierEligible: true,
    minTier: 'prof',
    maxSafeLeverage: 8,
    description:
      'TON 1h | LONG: CNTR Normal Bl + CFM Downtrend + Neo Cloud Br | SHORT: CNTR Normal Br + CFM Uptrend + Neo Cloud Bl | EXIT: CNTR Built-in',
    longDescription:
      'Контр-трендовая стратегия на TONUSDT 1h: ищет развороты тренда с подтверждением через Confirmation и Neo Cloud. ' +
      'LONG-вход: Contrarian Normal выдаёт бычий сигнал, при этом Confirmation в нисходящем тренде и Neo Cloud в bearish-состоянии — классическая reversal-сетап с momentum-flip фильтрами. ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Confirmation Builtin-Exits. ' +
      'Win rate 88% за 600+ дней истории, средняя длительность сделки ~92 часа (~4 дня). ' +
      'Safety SL 7% — выбран по PnL-симуляции (Phase Q): +116% на $1000, PF 2.02, max DD 17.5%, win-rate 83%. Cap при 7% даже улучшает результат vs без стопа (срезает катастрофические экскурсии).',
    symbol: 'TONUSDT',
    timeframe: '60',
    // Phase R (May 29 2026): DISABLED — 1h strategies removed from product.
    enabled: false,
    fanOut: false,
    slPct: 0.07,
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
    // Phase Q: re-enabled at slPct 6% — single best PnL across all
    // strategies. Simulation: $4150 (+415%), PF 2.51, DD 24.8%, worst −6%.
    // Win rate 54%, average win 9.78% × notional. Cap saves from worst
    // 30% excursion while keeping fat-tail winners.
    riskBand: 'high',
    tierEligible: true,
    minTier: 'prof',
    maxSafeLeverage: 9,
    description:
      'HBAR 1h | LONG: CNTR Normal Br + TS Ranging + Strong Bl Cfl | SHORT: CNTR Normal Bl + TS Ranging + Strong Br Cfl | EXIT: CNTR Built-in',
    longDescription:
      'Контр-трендовая стратегия на HBARUSDT 1h, специализирующаяся на разворотах в боковых движениях рынка. ' +
      'LONG-вход срабатывает когда Contrarian Normal выдаёт МЕДВЕЖИЙ сигнал (как контр-индикатор разворота вверх), Trend Strength показывает Ranging (боковое движение), и Strong Bullish Confluence подтверждает накопление покупателей. ' +
      'SHORT — зеркально. ' +
      'Выход через встроенные Contrarian Builtin-Exits. ' +
      'Win rate 67.52% — ниже чем у других стратегий портфеля, но компенсируется отношением риск/прибыль: средний выигрыш +9.78% против среднего убытка −6.21%. ' +
      'Самая доходная стратегия портфеля: +536% за 831 день (CAGR 235%). ' +
      'Safety SL 6% — выбран по PnL-симуляции (Phase Q): самая доходная стратегия портфеля — +415% за 831 день на $1000, PF 2.51, max DD 25%, худшая сделка −6%. Cap сохраняет fat-tail winners, отрезая катастрофы.',
    symbol: 'HBARUSDT',
    timeframe: '60',
    // Phase R (May 29 2026): DISABLED — 1h strategies removed from product.
    enabled: false,
    fanOut: false,
    slPct: 0.06,
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
    // TRACK E — low band, eligible all tiers.
    // Phase R (May 29, 2026): SL 7% → 5%, leverage 8× → 10×. MAE audit
    // (155 trades) shows worst intra-trade excursion 6.43%, p95 3.78%.
    // 5% is the TIGHTEST cap that kills ZERO winners (4% starts cutting).
    // In the margin-based tier model PnL-per-margin = PnL%notional × lev:
    // 5%/10× (19.6% × 10 = 1.96) beats 7%/8× (22.2% × 8 = 1.78) by ~10%,
    // with slightly LOWER worst-case per-trade loss (5%×10=0.50 vs 7%×8=0.56 margin).
    riskBand: 'low',
    tierEligible: true,
    minTier: 'starter',
    maxSafeLeverage: 10,
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
      'Safety SL 5% при плече 10× — выбран по MAE-аудиту: 5% это самый тугой стоп, который не режет ни одного прибыльного трейда (worst MAE 6.43%, p95 3.78%). В margin-модели 5%/10× даёт больше прибыли на единицу маржи, чем широкий 7%/8×, при чуть меньшем риске на сделку. ' +
      'Бэктест короткий — всего 2.3 месяца. Цифры предварительные, ждём накопления реальной статистики.',
    symbol: 'BCHUSDT',
    timeframe: '5',
    enabled: false,
    fanOut: true,
    slPct: 0.05,
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
    // TRACK E — low band, eligible all tiers.
    // Phase R (May 29, 2026): SL 7% → 5%, leverage 8× → 10×. MAE audit
    // (102 trades) shows worst intra-trade excursion 6.18%, p95 4.27%.
    // 5% is the TIGHTEST cap that kills ZERO winners (4% starts cutting 2).
    // In the margin-based tier model PnL-per-margin = PnL%notional × lev:
    // 5%/10× (19.0% × 10 = 1.90) beats 7%/8× (22.3% × 8 = 1.78) by ~7%,
    // with slightly LOWER worst-case per-trade loss (5%×10=0.50 vs 7%×8=0.56 margin).
    riskBand: 'low',
    tierEligible: true,
    minTier: 'starter',
    maxSafeLeverage: 10,
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
      'Safety SL 5% при плече 10× — выбран по MAE-аудиту: 5% это самый тугой стоп, который не режет ни одного прибыльного трейда (worst MAE 6.18%, p95 4.27%). В margin-модели 5%/10× даёт больше прибыли на единицу маржи, чем широкий 7%/8×, при чуть меньшем риске на сделку. ' +
      'Бэктест короткий — всего 2.3 месяца. Цифры предварительные, ждём накопления реальной статистики.',
    symbol: 'BTCUSDT',
    timeframe: '5',
    enabled: false,
    fanOut: true,
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

  'eth-ob-tsr-mf50': {
    id: 'eth-ob-tsr-mf50',
    code: '009',
    // Found via LuxAlgo Strategy Hunter on May 19, 2026. Backtest:
    // PF 2.23, WR 51.82%, DD 7.29%, 110 trades, net +3070 USDT on
    // $1000 notional. Balanced profile — not curve-fit (DD reasonable,
    // WR near 50%, profit large enough to be statistically real).
    // ETH is the most liquid alt after BTC; fills clean, slippage low.
    //
    // slPct 0.07 (7%) — conservative starting point chosen by analogy
    // with BNB 15m (7.5% SL). Will tighten/loosen after 10-20 live
    // trades once we see the actual avg_loss distribution. Backtest
    // DD 7.29% suggests individual losses cluster around 3-5%; 7% SL
    // gives buffer for outliers without sitting too close to liquidation.
    //
    // riskBand 'low' — DD <8% on a major alt fits the BNB/BTC band.
    // tierEligible true → eligible for ALL tiers (including Starter)
    // since ETH is a portfolio cornerstone for any tier.
    //
    // Enabled FALSE on commit — operator turns it on once LuxAlgo
    // alerts are configured with this strategy_id.
    riskBand: 'low',
    tierEligible: true,
    minTier: 'starter',
    maxSafeLeverage: 8,
    description:
      'ETH 15m | LONG: OB Exit Bear + TS Ranging + MF<50 | SHORT: OB Exit Bull + TS Ranging + MF>50 | EXIT: Built-in',
    longDescription:
      'Контр-трендовая стратегия на 15-минутном ETH с фильтрами по структуре рынка. ' +
      'Вход срабатывает при выходе цены из зоны Order Block в боковом тренде (Trend Strength: Ranging) с подтверждением по Money Flow. ' +
      'LONG — после bearish-выхода из OB + MF ниже 50 (исчерпание продавцов). SHORT — зеркально. ' +
      'Выход полностью на встроенных Builtin Exits стратегии. Safety SL 7% — выбран по PnL-симуляции: при 7% Net PnL +71% за 207 дней, PF 1.63, max equity DD 54% (стратегия с самым низким win rate в портфеле — 44%, серии убыточных дают глубокий equity DD).',
    symbol: 'ETHUSDT',
    timeframe: '15',
    // Phase V (Jun 14 2026): DISABLED — live WR 22% (backtest said 52%),
    // net −111 over 9 trades. Worst performer. Challenger eth-cntr-st (5m)
    // is in shadow. Config kept for history.
    enabled: false,
    fanOut: false,
    slPct: 0.07,
    launchedAt: Date.parse('2026-05-25T00:00:00Z'),
    alertName: 'ETHUSDT|15|LONG=OBExBr&TSRng&MFb50|SHORT=OBExBl&TSRng&MFa50|EXIT=BltExt',
    sourceUrl: 'https://www.luxalgo.com/chat/beksft9pr261tps21uhtq9wl',
    name: 'ETH OB Exited',
    backtest: {
      // Source: LuxAlgo Strategy Builder backtest, Oct 23 2025 → May 17 2026
      // (207 days, 110 trades). Raw LuxAlgo numbers were generated on a
      // 1-ETH-per-trade sizing (~$2700 avg notional). All USD values below
      // are normalised to our live $1000 fixed notional (scale = 1000/2700
      // ≈ 0.37). Ratio-based fields (WR, PF, DD%, win/loss %) are notional-
      // invariant and used as-is. cagrPct is simple-annualised:
      // netPnlPct × (365 / periodDays), matching the HBAR convention.
      // Source LuxAlgo readout: Net +3070 USDT, PF 2.23, WR 51.82%,
      // DD 7.29% ($971), CAGR 61.19% — verifiable at the sourceUrl.
      periodLabel: 'Oct 23, 2025 — May 17, 2026',
      periodDays: 207,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 1135.79,
      netPnlPct: 113.58,
      cagrPct: 200.27,
      totalTrades: 110,
      wins: 57,
      losses: 53,
      winRate: 0.5182,
      profitFactor: 2.23,
      commissionPaidUsd: 121.00,
      maxDrawdownPct: 7.29,
      maxDrawdownUsd: 359.39,
      avgWinUsd: 36.19,
      avgWinPct: 3.62,
      avgLossUsd: -17.49,
      avgLossPct: -1.75,
      largestWinUsd: 275.97,
      largestLossUsd: -108.76,
      longTrades: 55,
      longPnlPct: 25.88,
      shortTrades: 55,
      shortPnlPct: 87.70,
    },
  },

  'sol-lg-mf50': {
    id: 'sol-lg-mf50',
    code: '010',
    // Imported from LuxAlgo May 29 2026 ("Liquidity Grab — Money Flow
    // Below 50", SOL 5m). No-exit reversal: closes on the OPPOSITE signal
    // (our reverse_signal flip handles this — entry long / entry short
    // webhooks, NO exit webhook). Always in market.
    //
    // MAE audit (148 trades, Mar 18 – May 25 2026): p95 4.33%, worst 6.09%.
    // SL 5% = the tightest cap with ZERO killed winners (4%/3% kill 2 each
    // + heavy whipsaw: 11/16 stops). Among killW=0 options 5% is also the
    // per-margin optimum: 51.3% × 10× = 5.13 (vs 6%→4.61, 7%→4.22).
    // Matches our other 5m strategies (BCH/BTC at 5%/10×).
    riskBand: 'low',
    tierEligible: true,
    // Prospective Lighter validation (Jul 25 2026): operator-only shadow.
    // The historic book is not being restarted on Bybit; fanOut=false is
    // the hard real-order gate while we measure Lighter's actual 300 ms
    // executable price, spread, slippage and funding.
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'SOL 5m | Liquidity Grab + Money Flow 50 | LONG: LG Bull + MF<50 | SHORT: LG Bear + MF>50 | EXIT: reverse signal (no builtin exit)',
    longDescription:
      'Разворотная стратегия на SOLUSDT 5m: ловит захват ликвидности (Liquidity Grab) с фильтром по Money Flow относительно 50. ' +
      'LONG — bullish liquidity grab при Money Flow ниже 50 (исчерпание продавцов). SHORT — зеркально. ' +
      'Своего exit-условия нет — позиция закрывается встречным сигналом (наш reverse_signal флип), стратегия всегда в рынке. ' +
      'Safety SL 5% при плече 10× — выбран по MAE-аудиту (148 сделок): 5% это самый тугой стоп, не режущий ни одного прибыльного трейда (worst MAE 6.09%, p95 4.33%), и максимум прибыли на единицу маржи. ' +
      'Бэктест ~2.3 месяца (18 мар — 25 мая 2026). Цифры предварительные, ждём накопления реальной статистики.',
    symbol: 'SOLUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.05,
    launchedAt: Date.parse('2026-05-29T00:00:00Z'),
    alertName: 'SOLUSDT|5|LONG=LGBl&MFb50|SHORT=LGBr&MFa50|EXIT=Reverse',
    sourceUrl: 'https://www.luxalgo.com/chat/lqik6f9n2d4itg3ta21gqomd',
    name: 'SOL Liquidity Grab',
    backtest: {
      // Recomputed from the scraped LuxAlgo Trades Log on our standard
      // $1000 fixed notional + 0.055%/side commission (native strategy
      // exits, no safety SL — the safety SL is our overlay). Verifiable
      // at sourceUrl. cagrPct = netPnlPct × 365 / periodDays.
      periodLabel: 'Mar 18, 2026 — May 25, 2026',
      periodDays: 68,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 528.17,
      netPnlPct: 52.82,
      cagrPct: 283.50,
      totalTrades: 148,
      wins: 96,
      losses: 52,
      winRate: 0.6486,
      profitFactor: 1.77,
      commissionPaidUsd: 162.80,
      maxDrawdownPct: 14.45,
      maxDrawdownUsd: 144.51,
      avgWinUsd: 12.69,
      avgWinPct: 1.27,
      avgLossUsd: -13.26,
      avgLossPct: -1.33,
      largestWinUsd: 71.49,
      largestLossUsd: -50.14,
      longTrades: 74,
      longPnlPct: 22.93,
      shortTrades: 74,
      shortPnlPct: 29.89,
    },
  },

  'doge-fvgm-st-tc': {
    id: 'doge-fvgm-st-tc',
    code: '011',
    // Phase T batch (Jun 12, 2026). Free coin — no symbol collision.
    // MAE audit (114 trades): p95 4.65%, worst 12.89%. SL 5% = tightest
    // killW=0 cap and the per-margin optimum (47.3% × 10× = 4.73 vs
    // 6%/8× = 3.69). DD 9.4% → low band.
    // SHADOW-VALIDATION: fanOut=false + minTier=null until 15-20 closed
    // shadow trades net-positive (Step 4.5 of the workflow), then flip
    // fanOut:true + set minTier.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'DOGE 5m | FVG Mitigated + Smart Trail + Trend Catcher | LONG: Bear FVG Mit + Bear ST + TC Bull | SHORT: зеркально | EXIT: reverse signal',
    longDescription:
      'Разворотная стратегия на DOGEUSDT 5m: вход на отработке (mitigation) Fair Value Gap против текущего Smart Trail с подтверждением разворота по Trend Catcher. ' +
      'LONG — медвежий FVG отработан + Smart Trail ещё медвежий + Trend Catcher уже развернулся вверх (ловим самое начало разворота). SHORT — зеркально. ' +
      'Своего exit-условия нет — позиция закрывается встречным сигналом (reverse_signal флип), стратегия всегда в рынке. ' +
      'Safety SL 5% при плече 10× — по MAE-аудиту (114 сделок): самый тугой кап без потери прибыльных трейдов (p95 MAE 4.65%), максимум прибыли на маржу. ' +
      'Бэктест ~2.3 месяца. Стратегия в shadow-обкатке: торгует публичный трек, на счета пользователей подключится после валидации 15-20 живых сделок.',
    symbol: 'DOGEUSDT',
    timeframe: '5',
    enabled: false,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.05,
    launchedAt: Date.parse('2026-06-12T00:00:00Z'),
    alertName: 'DOGEUSDT|5|LONG=FVGMitBr&STBr&TCBl|SHORT=FVGMitBl&STBl&TCBr|EXIT=Reverse',
    sourceUrl: 'https://www.luxalgo.com/chat/lc2u647lwn3b4e6wcdq1pvmp',
    name: 'DOGE FVG Reversal',
    backtest: {
      // Recomputed from the scraped LuxAlgo Trades Log on $1000 fixed
      // notional + 0.055%/side commission (native exits, no safety SL).
      periodLabel: 'Mar 17, 2026 — May 26, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 523.97,
      netPnlPct: 52.40,
      cagrPct: 277.18,
      totalTrades: 114,
      wins: 63,
      losses: 51,
      winRate: 0.5526,
      profitFactor: 1.93,
      commissionPaidUsd: 125.40,
      maxDrawdownPct: 9.11,
      maxDrawdownUsd: 91.06,
      avgWinUsd: 17.31,
      avgWinPct: 1.73,
      avgLossUsd: -11.10,
      avgLossPct: -1.11,
      largestWinUsd: 72.48,
      largestLossUsd: -42.65,
      longTrades: 57,
      longPnlPct: 27.40,
      shortTrades: 57,
      shortPnlPct: 25.00,
    },
  },

  'avax-nfvg-tc-hw': {
    id: 'avax-nfvg-tc-hw',
    code: '012',
    // Phase T batch (Jun 12, 2026). Free coin — no symbol collision.
    // MAE audit (142 trades): p95 4.57%, worst 5.64%. SL 5% = tightest
    // killW=0 cap, per-margin optimum (50.7% × 10× = 5.07 vs 6%/8× 4.45).
    // DD ~20% at 5% cap → medium band (deepest DD of the batch).
    // SHADOW-VALIDATION: fanOut=false + minTier=null until validated.
    riskBand: 'medium',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'AVAX 5m | New FVG + Trend Catcher + HyperWave 50 | LONG: New Bear FVG + TC Bull + HW<50 | SHORT: зеркально | EXIT: reverse signal',
    longDescription:
      'Разворотная стратегия на AVAXUSDT 5m: вход на появлении нового Fair Value Gap против направления Trend Catcher с фильтром по HyperWave относительно 50. ' +
      'LONG — новый медвежий FVG + Trend Catcher бычий + HyperWave ниже 50 (перепроданность). SHORT — зеркально. ' +
      'Своего exit-условия нет — позиция закрывается встречным сигналом (reverse_signal флип), стратегия всегда в рынке. ' +
      'Safety SL 5% при плече 10× — по MAE-аудиту (142 сделок): самый тугой кап без потери прибыльных трейдов (worst MAE 5.64%). ' +
      'Win rate ниже 50% — стратегия зарабатывает асимметрией (средний выигрыш вдвое больше среднего проигрыша), просадки глубже остальных (до ~17-20%). ' +
      'Бэктест ~2.3 месяца. Стратегия в shadow-обкатке: торгует публичный трек, на счета пользователей подключится после валидации 15-20 живых сделок.',
    symbol: 'AVAXUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.05,
    launchedAt: Date.parse('2026-06-12T00:00:00Z'),
    alertName: 'AVAXUSDT|5|LONG=NFVGBr&TCBl&HWb50|SHORT=NFVGBl&TCBr&HWa50|EXIT=Reverse',
    sourceUrl: 'https://www.luxalgo.com/chat/vvda1ck85nd4pc15og9rxtea',
    name: 'AVAX FVG HyperWave',
    backtest: {
      // Recomputed from the scraped LuxAlgo Trades Log on $1000 fixed
      // notional + 0.055%/side commission (native exits, no safety SL).
      periodLabel: 'Mar 17, 2026 — May 26, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 555.84,
      netPnlPct: 55.58,
      cagrPct: 294.03,
      totalTrades: 142,
      wins: 68,
      losses: 74,
      winRate: 0.4789,
      profitFactor: 1.81,
      commissionPaidUsd: 156.20,
      maxDrawdownPct: 17.26,
      maxDrawdownUsd: 172.57,
      avgWinUsd: 18.26,
      avgWinPct: 1.83,
      avgLossUsd: -9.27,
      avgLossPct: -0.93,
      largestWinUsd: 88.28,
      largestLossUsd: -43.87,
      longTrades: 71,
      longPnlPct: 23.88,
      shortTrades: 71,
      shortPnlPct: 31.70,
    },
  },

  'eth-cntr-st': {
    id: 'eth-cntr-st',
    code: '013',
    // Phase T batch (Jun 12, 2026). CHALLENGER to STRAT-009 (ETH 15m,
    // live WR 22% over 9 trades vs backtest 52%). Same coin — but
    // shadow-only strategies don't touch the exchange, so no One-Way
    // collision while fanOut=false. The swap decision happens after both
    // have comparable live samples; the two must NEVER fan out together.
    // MAE audit (144 trades): p95 2.85%, worst 9.13%. SL 4% = tightest
    // killW=0 cap with buffer over p95; captures 99% of no-cap PnL.
    // SHADOW-VALIDATION: fanOut=false + minTier=null.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 11,
    description:
      'ETH 5m | Contrarian Any + Smart Trail | LONG: CNTR Any Bull + ST | SHORT: зеркально | EXIT: reverse signal',
    longDescription:
      'Контр-трендовая разворотная стратегия на ETHUSDT 5m: сигналы Contrarian Any с фильтром по Smart Trail. ' +
      'Своего exit-условия нет — позиция закрывается встречным сигналом (reverse_signal флип), стратегия всегда в рынке. ' +
      'Safety SL 4% при плече 11× — по MAE-аудиту (144 сделок): самый тугой кап без потери прибыльных трейдов (p95 MAE 2.85%), захватывает 99% бескапового PnL. ' +
      'Кандидат на замену STRAT-009 (ETH 15m), чей live-результат разошёлся с бэктестом. Решение о замене — после сравнимой live-выборки обеих. ' +
      'Бэктест ~2.3 месяца. Стратегия в shadow-обкатке: торгует публичный трек, на счета пользователей не подключена.',
    symbol: 'ETHUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.04,
    launchedAt: Date.parse('2026-06-12T00:00:00Z'),
    alertName: 'ETHUSDT|5|LONG=CNTRAnyBl&ST|SHORT=CNTRAnyBr&ST|EXIT=Reverse',
    sourceUrl: 'https://www.luxalgo.com/chat/qo10jwvcgj845xjyrv5k0vr3',
    name: 'ETH Contrarian ST',
    backtest: {
      // Recomputed from the scraped LuxAlgo Trades Log on $1000 fixed
      // notional + 0.055%/side commission (native exits, no safety SL).
      periodLabel: 'Mar 15, 2026 — May 22, 2026',
      periodDays: 68,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 263.85,
      netPnlPct: 26.38,
      cagrPct: 141.63,
      totalTrades: 144,
      wins: 92,
      losses: 52,
      winRate: 0.6389,
      profitFactor: 1.67,
      commissionPaidUsd: 158.40,
      maxDrawdownPct: 8.37,
      maxDrawdownUsd: 83.67,
      avgWinUsd: 7.15,
      avgWinPct: 0.71,
      avgLossUsd: -7.57,
      avgLossPct: -0.76,
      largestWinUsd: 67.93,
      largestLossUsd: -47.69,
      longTrades: 69,
      longPnlPct: 15.91,
      shortTrades: 75,
      shortPnlPct: 10.48,
    },
  },

  'bnb-cntrn-hw-wc': {
    id: 'bnb-cntrn-hw-wc',
    code: '014',
    // Phase T batch (Jun 12, 2026). CHALLENGER to STRAT-001 (BNB 15m,
    // live -8.3pp over 7 trades, WR 29%). Shadow-only => no One-Way
    // collision while fanOut=false; swap decided on comparable live
    // samples; the two must NEVER fan out together.
    // MAE audit (117 trades): p95 2.94%, worst 4.44%. SL 4% = killW=0
    // with ~36% buffer over p95; per-margin 25.8% × 11× = 2.84.
    // Beat the alternative BNB 5m candidate (CFM Downtrend variant,
    // PF 1.61) on every axis — that one was discarded.
    // SHADOW-VALIDATION: fanOut=false + minTier=null.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 11,
    description:
      'BNB 5m | Contrarian Normal + HyperWave 50 + Weak Confluence | LONG: CNTR Norm Bull + HW<50 + WC | SHORT: зеркально | EXIT: reverse signal',
    longDescription:
      'Контр-трендовая разворотная стратегия на BNBUSDT 5m: сигналы Contrarian Normal с фильтром по HyperWave относительно 50 и слабой конфлюэнции. ' +
      'LONG — Contrarian Normal Bullish + HyperWave ниже 50 (перепроданность). SHORT — зеркально. ' +
      'Своего exit-условия нет — позиция закрывается встречным сигналом (reverse_signal флип), стратегия всегда в рынке. ' +
      'Safety SL 4% при плече 11× — по MAE-аудиту (117 сделок): худшая внутрисделочная просадка за всю историю 4.44%, p95 2.94% — стоп с запасом, не режет прибыльные трейды. ' +
      'Кандидат на замену STRAT-001 (BNB 15m), чей live-результат слабый. Решение о замене — после сравнимой live-выборки обеих. ' +
      'Бэктест ~2.3 месяца. Стратегия в shadow-обкатке: торгует публичный трек, на счета пользователей не подключена.',
    symbol: 'BNBUSDT',
    timeframe: '5',
    enabled: false,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.04,
    launchedAt: Date.parse('2026-06-12T00:00:00Z'),
    alertName: 'BNBUSDT|5|LONG=CNTRNormBl&HWb50&WC|SHORT=CNTRNormBr&HWa50&WC|EXIT=Reverse',
    sourceUrl: 'https://www.luxalgo.com/chat/ic4ta3rizktlyaea9bz9dby9',
    name: 'BNB Contrarian HyperWave',
    backtest: {
      // Recomputed from the scraped LuxAlgo Trades Log on $1000 fixed
      // notional + 0.055%/side commission (native exits, no safety SL).
      periodLabel: 'Mar 17, 2026 — May 26, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 266.44,
      netPnlPct: 26.64,
      cagrPct: 140.94,
      totalTrades: 117,
      wins: 69,
      losses: 48,
      winRate: 0.5897,
      profitFactor: 1.91,
      commissionPaidUsd: 128.70,
      maxDrawdownPct: 7.53,
      maxDrawdownUsd: 75.34,
      avgWinUsd: 8.08,
      avgWinPct: 0.81,
      avgLossUsd: -6.07,
      avgLossPct: -0.61,
      largestWinUsd: 50.98,
      largestLossUsd: -32.83,
      longTrades: 58,
      longPnlPct: 12.86,
      shortTrades: 59,
      shortPnlPct: 13.78,
    },
  },

  'bnb-cntr-tt-mf50': {
    id: 'bnb-cntr-tt-mf50',
    code: '001',
    // TRACK E — low band (DD 0.95%, the safest). Eligible all tiers.
    // Phase Q (May 28, 2026): SL → 8%. PnL simulation:
    //   5%: $725 (DD 11.2%, worst −5%)
    //   7%: $855 (DD 14.2%, worst −7%)
    //   8%: $923 (DD 14.2%, worst −8%)
    //  10%: $950 (DD 11.4%, no SL hits)
    // 8% is optimal within operator's 5-8% tolerance — captures
    // 97% of the no-cap potential while keeping worst trade bounded.
    riskBand: 'low',
    tierEligible: true,
    minTier: 'starter',
    maxSafeLeverage: 7,
    description:
      'BNB 15m | LONG: CONT Any Br + TT Br + MF>50 | SHORT: CONT Any Bl + TT Bl + MF<50 | EXIT: CONT Built-in',
    longDescription:
      'Контр-трендовая стратегия на 15-минутном таймфрейме с фильтрами по среднесрочному тренду (Trend Tracer) и денежному потоку (Money Flow). ' +
      'LONG-вход срабатывает когда Contrarian Any выдаёт bearish-сигнал (контр-индикатор разворота вверх), Trend Tracer показывает bearish-тренд (зона перепроданности) и Money Flow выше 50 (давление покупателей преобладает). ' +
      'SHORT — зеркально. ' +
      'Выход полностью передан встроенным exits стратегии — без фиксированных TP. Safety SL 8% — выбран по PnL-симуляции: PF 2.58, max DD 14.2%, Net PnL +92% за 207 дней на $1000. Тугие SL 5% теряли бы 20% доходности на recovery-сделках.',
    symbol: 'BNBUSDT',
    timeframe: '15',
    // Phase V (Jun 14 2026): DISABLED — live WR 29% (backtest said 75%),
    // net −90 over 7 trades. Challenger bnb-cntrn-hw-wc (5m) is in shadow.
    // Config kept for history.
    enabled: false,
    fanOut: false,
    slPct: 0.08,
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

  'btc-choch-cfm-tc': {
    id: 'btc-choch-cfm-tc',
    code: '015',
    // Fresh LuxAlgo 5m search on Jul 26 2026. This is NOT the rejected
    // STRAT-008 BTC setup. All 161 trades were re-normalised to fixed
    // $1000 notional instead of trusting LuxAlgo's unit-size headline:
    //   Lighter 0-fee: +42.59%, PF 1.92, WR 67.08%, max DD 5.60%
    //   halves: +21.15% / +21.43%; thirds: +14.79/+10.50/+17.30%
    //   long +20.41%, short +22.18%; top five wins = 44% of net.
    // At Bybit's 0.11% round-trip fee the same trades remain +24.88%
    // with PF 1.47. Lighter is the intended venue; fanOut=false is the
    // hard real-order gate while forward L2 execution is validated.
    //
    // MAE: p95 3.00%, max 6.56%. A 3.5% safety stop is the tightest
    // tested cap that kills zero historical winners; the conservative
    // stop simulation remains +38.16% at zero fees.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 12,
    description:
      'BTC 5m | CHoCH + Confirmation + Trend Catcher | LONG: Bearish CHoCH + Confirmation Downtrend + TC Bearish | SHORT: зеркально | EXIT: reverse signal',
    longDescription:
      'Разворотная стратегия на BTCUSDT 5m. LONG срабатывает на bearish CHoCH при нисходящем Confirmation и bearish Trend Catcher; SHORT — зеркально на bullish CHoCH, Confirmation Uptrend и bullish Trend Catcher. ' +
      'Своего exit-условия нет: позиция закрывается и переворачивается встречным сигналом. ' +
      'Все 161 сделки проверены на постоянном номинале $1000: обе половины, все три части периода, long и short положительны. ' +
      'Safety SL 3.5% — самый тугой проверенный кап, не обрезавший ни одной исторически прибыльной сделки. ' +
      'Стратегия работает только в Lighter shadow; реальные сделки и пользовательский fan-out отключены до 20 закрытых forward-сделок с положительным net, PF ≥1.20 и обеими положительными половинами.',
    symbol: 'BTCUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.035,
    launchedAt: Date.parse('2026-07-26T00:00:00Z'),
    alertName: 'BTCUSDT|5|LONG=CHoCHBr&CFMDown&TCBr|SHORT=CHoCHBl&CFMUp&TCBl|EXIT=Reverse',
    sourceUrl: 'https://app.luxalgo.com/backtesting/uzoiw34h2tvkagzixav37g9s',
    name: 'BTC CHoCH Confirmation',
    backtest: {
      // Track-C view is deliberately conservative and includes Bybit's
      // 0.055% taker fee per side. The dedicated Lighter lab shows the
      // venue-specific zero-fee result and measures spread/funding live.
      periodLabel: 'Apr 7, 2026 — Jun 15, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 248.79,
      netPnlPct: 24.88,
      cagrPct: 131.60,
      totalTrades: 161,
      wins: 101,
      losses: 60,
      winRate: 0.6273,
      profitFactor: 1.472,
      commissionPaidUsd: 177.10,
      maxDrawdownPct: 6.70,
      maxDrawdownUsd: 67.02,
      avgWinUsd: 7.68,
      avgWinPct: 0.77,
      avgLossUsd: -8.78,
      avgLossPct: -0.88,
      largestWinUsd: 51.17,
      largestLossUsd: -46.21,
      longTrades: 81,
      longPnlPct: 11.50,
      shortTrades: 80,
      shortPnlPct: 13.38,
    },
  },

  'ltc-tcs-smart-trail': {
    id: 'ltc-tcs-smart-trail',
    code: '016',
    // Fresh LuxAlgo 5m search on Jul 26 2026. All 181 trades were
    // re-normalised to fixed $1000 notional:
    //   Lighter 0-fee: +48.86%, PF 2.04, WR 70.17%, max DD 5.32%
    //   halves: +20.75% / +28.11%; thirds: +11.33/+7.00/+30.52%
    //   long +17.36%, short +31.50%; top five wins = 27.3% of net.
    // The conservative Bybit-fee view below remains +28.95%, PF 1.54.
    //
    // MAE p95 is 3.78%, max 7.19%. A 5% safety stop killed no
    // historical winners and retained +43.28%, PF 1.82 at zero fees.
    // fanOut=false is a hard real-order gate while forward Lighter L2
    // execution is validated.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'LTC 5m | Trend Catcher Switch + Smart Trail | LONG: TC Switch Bearish + Smart Trail Bearish | SHORT: зеркально | EXIT: reverse signal',
    longDescription:
      'Трендовая стратегия на LTCUSDT 5m. LONG срабатывает на bearish Trend Catcher Switch при bearish Smart Trail; SHORT — зеркально на bullish сигналах. ' +
      'Своего exit-условия нет: позиция закрывается и переворачивается встречным сигналом. ' +
      'Все 181 сделки проверены на постоянном номинале $1000: обе половины, все три части периода, long и short положительны; пять лучших сделок дают лишь 27.3% результата. ' +
      'Safety SL 5% не обрезал ни одной исторически прибыльной сделки и сохраняет PF 1.82 в zero-fee модели. ' +
      'Стратегия работает только в Lighter shadow; реальные сделки и пользовательский fan-out отключены до 20 закрытых forward-сделок с положительным net, PF ≥1.20 и обеими положительными половинами.',
    symbol: 'LTCUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'reverse',
    slPct: 0.05,
    launchedAt: Date.parse('2026-07-26T00:00:00Z'),
    alertName: 'LTCUSDT|5|LONG=TCSwitchBr&SmartTrailBr|SHORT=TCSwitchBl&SmartTrailBl|EXIT=Reverse',
    sourceUrl: 'https://app.luxalgo.com/backtesting/vtailuxj1xluf5hrsq3vw4xj',
    name: 'LTC Trend Catcher Smart Trail',
    backtest: {
      // Track-C view is deliberately conservative and includes Bybit's
      // 0.055% taker fee per side. The dedicated Lighter lab shows the
      // venue-specific zero-fee result and measures spread/funding live.
      periodLabel: 'Apr 7, 2026 — Jun 15, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 289.46,
      netPnlPct: 28.95,
      cagrPct: 283.75,
      totalTrades: 181,
      wins: 118,
      losses: 63,
      winRate: 0.6519,
      profitFactor: 1.539,
      commissionPaidUsd: 199.10,
      maxDrawdownPct: 6.92,
      maxDrawdownUsd: 69.16,
      avgWinUsd: 7.01,
      avgWinPct: 0.70,
      avgLossUsd: -8.53,
      avgLossPct: -0.85,
      largestWinUsd: 28.15,
      largestLossUsd: -46.89,
      longTrades: 91,
      longPnlPct: 7.35,
      shortTrades: 90,
      shortPnlPct: 21.60,
    },
  },

  'uni-cfm-smart-weak': {
    id: 'uni-cfm-smart-weak',
    code: '017',
    // Fresh LuxAlgo 5m search on Jul 26 2026. All 181 trades were
    // re-normalised to fixed $1000 notional:
    //   Lighter 0-fee: +60.73%, PF 2.04, WR 75.69%, max DD 10.89%
    //   halves: +15.63% / +45.11%; thirds: +14.41/+3.15/+43.17%
    //   long +26.05%, short +34.68%; top five wins = 21.8% of net.
    // The middle third is weak but positive (PF 1.11), while the latest
    // third strengthens materially. This makes the setup suitable for
    // prospective shadow, not live capital.
    //
    // MAE p95 is 3.94%, max 10.04%. A 5% safety stop killed no
    // historical winners and retained +60.27%, PF 2.02 at zero fees.
    // fanOut=false is a hard real-order gate.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'UNI 5m | Confirmation Any + Smart Trail + Weak Confluence | LONG: CFM Bullish + Smart Trail Bearish + Weak Bullish Confluence | SHORT: зеркально | EXIT: Confirmation built-in',
    longDescription:
      'Контртрендовая стратегия на UNIUSDT 5m. LONG срабатывает на bullish Confirmation Any при bearish Smart Trail и Weak Bullish Confluence; SHORT — зеркально. ' +
      'Выход использует встроенный Confirmation exit без фиксированного take-profit. ' +
      'Все 181 сделки проверены на постоянном номинале $1000: обе половины, все три части периода, long и short положительны; пять лучших сделок дают лишь 21.8% результата. ' +
      'Safety SL 5% не обрезал ни одной исторически прибыльной сделки и сохраняет PF 2.02 в zero-fee модели. ' +
      'Стратегия работает только в Lighter shadow; реальные сделки и пользовательский fan-out отключены до 20 закрытых forward-сделок с положительным net, PF ≥1.20 и обеими положительными половинами.',
    symbol: 'UNIUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'builtin',
    slPct: 0.05,
    launchedAt: Date.parse('2026-07-26T00:00:00Z'),
    alertName: 'UNIUSDT|5|LONG=CFMAnyBl&SmartTrailBr&WeakConfBl|SHORT=CFMAnyBr&SmartTrailBl&WeakConfBr|EXIT=CFMBuiltIn',
    sourceUrl: 'https://app.luxalgo.com/backtesting/p67qbkwbahmvp8ux5tfb302o',
    name: 'UNI Confirmation Smart Trail',
    backtest: {
      // Track-C view is deliberately conservative and includes Bybit's
      // 0.055% taker fee per side. The dedicated Lighter lab shows the
      // venue-specific zero-fee result and measures spread/funding live.
      periodLabel: 'Apr 7, 2026 — Jun 15, 2026',
      periodDays: 69,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 408.21,
      netPnlPct: 40.82,
      cagrPct: 511.54,
      totalTrades: 181,
      wins: 130,
      losses: 51,
      winRate: 0.7182,
      profitFactor: 1.640,
      commissionPaidUsd: 199.10,
      maxDrawdownPct: 14.35,
      maxDrawdownUsd: 143.54,
      avgWinUsd: 8.05,
      avgWinPct: 0.80,
      avgLossUsd: -12.51,
      avgLossPct: -1.25,
      largestWinUsd: 40.05,
      largestLossUsd: -81.63,
      longTrades: 93,
      longPnlPct: 15.82,
      shortTrades: 88,
      shortPnlPct: 25.00,
    },
  },

  'dot-cntr-tc-hw': {
    id: 'dot-cntr-tc-hw',
    code: '018',
    // Fresh LuxAlgo 5m search on Jul 26 2026. All 180 trades were
    // re-normalised to fixed $1000 notional:
    //   Lighter 0-fee: +47.66%, PF 1.92, WR 75.00%, max DD 12.20%
    //   halves: +23.51% / +24.14%; thirds: +9.38/+17.16/+21.12%
    //   long +18.32%, short +29.34%; top five wins = 41.7% of net.
    //
    // MAE p95 is 3.92%, max 9.84%. The mandatory 5% safety cap
    // cuts two historical winners but remains +30.95%, PF 1.47.
    // This is therefore shadow-only and fanOut=false is a hard gate.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'DOT 5m | Contrarian Normal + Trend Catcher + HyperWave | LONG: Contrarian Bullish + TC Bullish + HW<50 | SHORT: зеркально | EXIT: Contrarian built-in',
    longDescription:
      'Контртрендовая стратегия на DOTUSDT 5m. LONG срабатывает на bullish Contrarian Normal при bullish Trend Catcher и HyperWave ниже 50; SHORT — зеркально с HyperWave выше 50. ' +
      'Выход использует встроенный Contrarian exit без фиксированного take-profit. ' +
      'Все 180 сделок проверены на постоянном номинале $1000: обе половины, все три части периода, long и short положительны. ' +
      'Safety SL 5% обрезал две исторически прибыльные сделки, но ограниченная модель остаётся +30.95% и PF 1.47; поэтому стратегия допускается только в shadow. ' +
      'Реальные сделки и пользовательский fan-out отключены до 20 закрытых forward-сделок с положительным net, PF ≥1.20 и обеими положительными половинами.',
    symbol: 'DOTUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'builtin',
    slPct: 0.05,
    launchedAt: Date.parse('2026-07-26T00:00:00Z'),
    alertName: 'DOTUSDT|5|LONG=ContrarianNBl&TCBl&HWb50|SHORT=ContrarianNBr&TCBr&HWa50|EXIT=ContrarianBuiltIn',
    sourceUrl: 'https://app.luxalgo.com/backtesting/m8juc4gy92aui2i7b1yogsl9',
    name: 'DOT Contrarian Trend Catcher',
    backtest: {
      // Track-C view is deliberately conservative and includes Bybit's
      // 0.055% taker fee per side. The dedicated Lighter lab shows the
      // venue-specific zero-fee result and measures spread/funding live.
      periodLabel: 'Apr 8, 2026 — Jun 15, 2026',
      periodDays: 68,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 278.57,
      netPnlPct: 27.86,
      cagrPct: 273.98,
      totalTrades: 180,
      wins: 130,
      losses: 50,
      winRate: 0.7222,
      profitFactor: 1.488,
      commissionPaidUsd: 198.00,
      maxDrawdownPct: 13.08,
      maxDrawdownUsd: 130.80,
      avgWinUsd: 6.54,
      avgWinPct: 0.65,
      avgLossUsd: -11.43,
      avgLossPct: -1.14,
      largestWinUsd: 46.85,
      largestLossUsd: -62.71,
      longTrades: 83,
      longPnlPct: 9.19,
      shortTrades: 97,
      shortPnlPct: 18.67,
    },
  },

  'hbar-cfm-smart-weak': {
    id: 'hbar-cfm-smart-weak',
    code: '019',
    // Fresh LuxAlgo 5m search on Jul 26 2026. All 184 trades were
    // re-normalised to fixed $1000 notional:
    //   Lighter 0-fee: +55.51%, PF 2.15, WR 65.76%, max DD 5.68%
    //   halves: +22.08% / +33.42%; thirds: +21.98/+10.44/+23.08%
    //   long +25.18%, short +30.33%; top five wins = 27.0% of net.
    //
    // MAE p95 is 3.16%, max 5.62%. The mandatory 5% safety cap
    // cuts two historical winners but remains +42.94%, PF 1.73.
    // Live HBAR spread was about 0.10% at onboarding, so forward L2
    // validation is essential and fanOut=false is a hard gate.
    riskBand: 'low',
    tierEligible: true,
    minTier: null,
    maxSafeLeverage: 10,
    description:
      'HBAR 5m | Confirmation Any + Smart Trail + Weak Confluence | LONG: CFM Bearish + Smart Trail Bullish + Weak Bearish Confluence | SHORT: зеркально | EXIT: Confirmation built-in',
    longDescription:
      'Контртрендовая стратегия на HBARUSDT 5m. LONG срабатывает на bearish Confirmation Any при bullish Smart Trail и Weak Bearish Confluence; SHORT — зеркально. ' +
      'Выход использует встроенный Confirmation exit без фиксированного take-profit. ' +
      'Все 184 сделки проверены на постоянном номинале $1000: обе половины, все три части периода, long и short положительны; пять лучших сделок дают 27% результата. ' +
      'Safety SL 5% обрезал две исторически прибыльные сделки, но ограниченная модель остаётся +42.94% и PF 1.73. ' +
      'Стратегия работает только в Lighter shadow; реальные сделки и пользовательский fan-out отключены до 20 закрытых forward-сделок с положительным net, PF ≥1.20 и обеими положительными половинами.',
    symbol: 'HBARUSDT',
    timeframe: '5',
    enabled: true,
    fanOut: false,
    exitMode: 'builtin',
    slPct: 0.05,
    launchedAt: Date.parse('2026-07-26T00:00:00Z'),
    alertName: 'HBARUSDT|5|LONG=CFMAnyBr&SmartTrailBl&WeakConfBr|SHORT=CFMAnyBl&SmartTrailBr&WeakConfBl|EXIT=CFMBuiltIn',
    sourceUrl: 'https://app.luxalgo.com/backtesting/xgk7g71skjp8l5fal1hiw2xd',
    name: 'HBAR Confirmation Smart Trail',
    backtest: {
      // Track-C view is deliberately conservative and includes Bybit's
      // 0.055% taker fee per side. The dedicated Lighter lab shows the
      // venue-specific zero-fee result and measures spread/funding live.
      periodLabel: 'Apr 7, 2026 — Jun 14, 2026',
      periodDays: 68,
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: 352.67,
      netPnlPct: 35.27,
      cagrPct: 406.04,
      totalTrades: 184,
      wins: 110,
      losses: 74,
      winRate: 0.5978,
      profitFactor: 1.632,
      commissionPaidUsd: 202.40,
      maxDrawdownPct: 5.90,
      maxDrawdownUsd: 59.03,
      avgWinUsd: 8.28,
      avgWinPct: 0.83,
      avgLossUsd: -7.54,
      avgLossPct: -0.75,
      largestWinUsd: 47.10,
      largestLossUsd: -42.35,
      longTrades: 94,
      longPnlPct: 14.84,
      shortTrades: 90,
      shortPnlPct: 20.43,
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
    } else if (cfg.slPct > MAX_SAFE_SL_PCT) {
      // Phase P (May 28, 2026) — hard cap at 5% for all enabled strategies.
      // Operator decision after UNI#002 hit −10.96% mid-position made wide
      // SLs visually unacceptable. Strategies whose loss distribution
      // doesn't fit a 5% cap must be analyzed (loss-percentile audit) and
      // either tightened or disabled. See src/strategies/track-c-config.ts
      // header docs for the workflow.
      //
      // To disable a strategy that doesn't fit: set `enabled: false`.
      // To raise this cap globally: change MAX_SAFE_SL_PCT — but this
      // would re-enable wide drawdowns, contradicting the operator policy.
      errors.push(
        `STRAT-${cfg.code} (${id}): slPct ${cfg.slPct} exceeds the platform-wide ` +
        `cap of ${MAX_SAFE_SL_PCT * 100}%. Either tighten the SL, or set ` +
        `enabled:false on this strategy.`,
      );
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

/** Round-trip Bybit taker commission as % of notional (0.055% × 2).
 *  Shadow pnl_pct rows are GROSS (price-move only) — every aggregate we
 *  show or analyse must subtract this per closed trade. Phase T. */
export const TRACK_C_COMMISSION_RT_PCT = 0.11;

/** Public landing-page base URL. Surfaced in Telegram posts (entry +
 *  exit) as the deep link `${base}/strategies/${cfg.code}`. Override
 *  via env LANDING_BASE_URL if you operate a staging instance. */
export const LANDING_BASE_URL =
  process.env.LANDING_BASE_URL ?? 'https://robotclaude.biz';

/**
 * Operator's Bybit referral link. Surfaced wherever we tell users
 * "go to Bybit" — autotrading landing, API-key setup page, docs.
 *
 * Bonus: users who register Bybit through this link get +30 days
 * free autotrading. Verification is manual — the user messages
 * @dboykod with their Bybit UID and a screenshot showing they
 * registered via the ref, then the admin uses /admin/users/:id/extend
 * to grant the bonus.
 */
export const BYBIT_REF_URL = 'https://www.bybit.com/invite?ref=MY6W8R';

/** Bonus days awarded for registering Bybit via BYBIT_REF_URL. */
export const BYBIT_REF_BONUS_DAYS = 30;

// Track D leverage policy:
//   - DEFAULT_LEVERAGE = 10× (lives in src/user/strategies.ts) is applied
//     to every newly-enabled row regardless of strategy SL%. Users can
//     override per-row in the cabinet.
//   - The earlier `recommendedMaxLeverage(slPct)` heuristic was removed
//     — it produced very different ceilings per strategy (14× vs 2×)
//     which confused users. A flat default plus the user's own
//     adjustment proved cleaner during beta feedback.

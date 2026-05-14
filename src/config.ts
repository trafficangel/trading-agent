import 'dotenv/config';
import { z } from 'zod';

const Mode = z.enum(['telemetry', 'shadow', 'paper', 'semi_auto', 'full_auto']);

/**
 * Env-var boolean parser. CRITICAL: do NOT use z.coerce.boolean() — it
 * interprets EVERY non-empty string (including "false", "0", "no") as
 * `true` because it's just `Boolean(value)` under the hood. Caused us
 * a deploy bug 2026-05-13 where LLM_TRACK_ENABLED=false stayed on.
 *
 * Accepts: "true"/"1"/"yes"/"on" (case-insensitive) → true
 * Accepts: "false"/"0"/"no"/"off"/empty → false
 */
const envBool = (defaultValue: boolean) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off', ''].includes(s)) return false;
      return v; // let z.boolean fail validation for anything else
    },
    z.boolean().default(defaultValue),
  );

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  WEBHOOK_SECRET: z.string().min(32, 'WEBHOOK_SECRET must be ≥32 chars'),

  DB_PATH: z.string().default('./data/trading.sqlite'),

  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_CHANNEL_SIGNALS: z.string().min(1),
  TELEGRAM_CHANNEL_LOGS: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),

  BYBIT_API_KEY: z.string().optional(),
  BYBIT_API_SECRET: z.string().optional(),
  BYBIT_TESTNET: z.coerce.boolean().default(true),

  RISK_PCT_PER_TRADE: z.coerce.number().positive().default(0.5),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(3),
  DAILY_DD_LIMIT_PCT: z.coerce.number().positive().default(2.0),
  COOLDOWN_MIN_SAME_SYMBOL: z.coerce.number().int().nonnegative().default(15),

  /**
   * Master switch for Track A (LLM-driven decide + critique + monitor).
   * Default true (back-compat). Set false to run Track B alone — useful
   * when the A/B comparison is done and Track B is the chosen strategy,
   * or for cost-saving while observing pure-signal behaviour.
   *
   * When disabled, the 15-min decide-cron and the 5-min LLM monitor do
   * NOT start. tpsl-monitor still runs (rule-based, needed for Track B).
   * Self-review still runs (analyzes whichever track has data).
   */
  LLM_TRACK_ENABLED: envBool(true),

  /**
   * A/B test toggle for Track B (pure-LuxAlgo signal trader, no LLM).
   * When true, qualifying webhook events trigger immediate OPEN decisions
   * stored with track='signal'. Independent from the LLM cron flow.
   * Default off — turn on explicitly when ready to run the parallel test.
   */
  SIGNAL_TRADER_ENABLED: envBool(false),

  /**
   * Track C — LuxAlgo AI Strategy Builder webhook trader.
   * When true, webhooks with `"kind":"strategy"` get dispatched to
   * strategy-trader for entry/exit handling. Independent of Tracks A/B.
   * Default off — operator turns it on AFTER registering ≥1 strategy in
   * STRATEGY_CONFIGS (src/strategies/track-c-config.ts).
   */
  TRACK_C_ENABLED: envBool(false),

  /** Size (% of equity) per signal-track trade. Lower than LLM track by
   *  default because signal trades fire on every qualifying event (high
   *  frequency), so each individual bet should be small. */
  SIGNAL_TRADE_SIZE_PCT: z.coerce.number().positive().default(0.5),

  /** Minimum gap between signal-track OPENs on the SAME symbol, in min.
   *  Prevents back-to-back trades on the same bar when 2 signals fire in
   *  quick succession (e.g. bullish_plus on 15m + 5m almost simultaneously). */
  SIGNAL_COOLDOWN_MIN: z.coerce.number().int().nonnegative().default(30),

  MODE: Mode.default('telemetry'),

  CHROMIUM_PATH: z.string().optional(),

  /**
   * Optional: ID of a saved TradingView chart layout to pin charts to.
   * Without this, captureChart() opens the "default" chart, which can
   * lose its indicator overlays if the user accidentally modifies the
   * default layout in the TV UI. With this set, we always open the
   * specific named layout that has LuxAlgo indicators saved.
   *
   * To find it: open your TradingView chart with indicators set up, look
   * at the URL — it'll be `tradingview.com/chart/XXXXX/` where XXXXX is
   * the layout ID. Set TV_LAYOUT_ID=XXXXX in .env.
   */
  TV_LAYOUT_ID: z.string().optional(),


  /**
   * Symbols we actively MAKE DECISIONS on (decide-cron iterates this list).
   *
   * NOTE: This is NOT "symbols we look at". BTC is always pulled as macro
   * context (15m + 1H screenshots + sentiment + liquidations) in every
   * decide call regardless of subject — see `captureChartCached('BTCUSDT', ...)`
   * in src/jobs/decide.ts. So removing BTC from SYMBOLS does NOT remove
   * BTC context from analysis of other coins.
   *
   * Default 'TONUSDT' = we currently trade only TON. Adding more symbols
   * multiplies token cost (decide + critique per symbol per 15-min tick),
   * so keep this list tight to what you actually trade.
   */
  SYMBOLS: z
    .string()
    .default('TONUSDT')
    .transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
});

export type Config = z.infer<typeof Schema>;

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config: Config = parsed.data;

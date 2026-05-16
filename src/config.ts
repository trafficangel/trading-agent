import 'dotenv/config';
import { z } from 'zod';

const Mode = z.enum(['telemetry', 'shadow', 'paper', 'semi_auto', 'full_auto']);

/**
 * Env-var boolean parser. CRITICAL: do NOT use z.coerce.boolean() — it
 * interprets EVERY non-empty string (including "false", "0", "no") as
 * `true` because it's just `Boolean(value)` under the hood. Caused us
 * a deploy bug 2026-05-13 where TRACK_C_ENABLED=false stayed on.
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

  /**
   * Track C — LuxAlgo AI Strategy Builder webhook trader.
   * When true, webhooks with `"kind":"strategy"` get dispatched to
   * strategy-trader for entry/exit handling. Default off — operator turns
   * it on AFTER registering ≥1 strategy in STRATEGY_CONFIGS
   * (src/strategies/track-c-config.ts).
   */
  TRACK_C_ENABLED: envBool(false),

  MODE: Mode.default('telemetry'),
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

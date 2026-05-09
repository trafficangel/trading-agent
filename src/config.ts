import 'dotenv/config';
import { z } from 'zod';

const Mode = z.enum(['telemetry', 'shadow', 'paper', 'semi_auto', 'full_auto']);

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

  MODE: Mode.default('telemetry'),

  CHROMIUM_PATH: z.string().optional(),


  SYMBOLS: z
    .string()
    .default('BTCUSDT,ETHUSDT,SOLUSDT')
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

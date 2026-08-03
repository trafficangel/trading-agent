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
  /** Master switch for outbound Bot API notifications (signals + operator
   * logs + photos). Does not disable Telegram Gateway login codes. */
  TELEGRAM_NOTIFY: envBool(true),

  /**
   * Track D — SaaS copytrading.
   *
   * Master secret for AES-256-GCM encryption of client Bybit API keys.
   * Must be exactly 64 hex chars (32 bytes). Generate once with:
   *   openssl rand -hex 32
   *
   * Without this var the server refuses to start — see src/auth/crypto.ts.
   * Losing this secret = losing all stored API keys (no recovery path).
   * Back it up offline somewhere safe BEFORE the first client connects.
   */
  API_KEY_MASTER_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'API_KEY_MASTER_SECRET must be 64 hex chars (32 bytes)'),

  /** Pepper for OTP code hashing in verification_attempts.code. Without
   *  this the OTP would be stored as plaintext — a DB leak before the
   *  user types the code would let an attacker walk in.
   *  Generate once with: openssl rand -hex 32 */
  OTP_PEPPER: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'OTP_PEPPER must be 64 hex chars (32 bytes)'),

  /** HMAC secret for CSRF tokens. Tokens are issued at session creation
   *  and verified on every state-changing POST.
   *  Generate once with: openssl rand -hex 32 */
  CSRF_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CSRF_SECRET must be 64 hex chars (32 bytes)'),

  /** Trial length for new registrations (Track D), in days. */
  TRACK_D_TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(14),

  /** Use Bybit testnet for client API calls. Set true during dev /
   *  staging; production is testnet=false (mainnet). The base URL
   *  selection lives in src/exchange/bybit-private.ts. */
  BYBIT_USE_TESTNET: envBool(true),

  /** Operator's OWN Bybit key for the lab→live bridge (src/strategies/lab-live.ts).
   *  Separate from the subscriber fan-out (user_api_keys). Optional — only needed
   *  when LAB_LIVE.mode is 'testnet'/'live'. Endpoint follows BYBIT_USE_TESTNET. */
  BYBIT_OPERATOR_API_KEY: z.string().optional(),
  BYBIT_OPERATOR_API_SECRET: z.string().optional(),

  /** Hyperliquid execution for the lab→live bridge (Bybit blocks derivatives for
   *  the operator's region — code 10024). HL is permissionless / not geo-blocked.
   *  HL_API_WALLET_KEY = private key that SIGNS (an HL agent/API wallet is safest —
   *  it can trade but NOT withdraw; never the main wallet if avoidable). Only needed
   *  when LAB_LIVE.mode is 'testnet'/'live'. HL_ACCOUNT_ADDRESS = the MAIN account
   *  to query/attribute (defaults to the signer's own address for a non-agent key). */
  HL_API_WALLET_KEY: z.string().optional(),
  HL_ACCOUNT_ADDRESS: z.string().optional(),
  HL_USE_TESTNET: envBool(true),
  /* HL_VAULT_ADDRESS = if set, runners trade ON BEHALF OF this vault (orders carry vaultAddress, reads
   *  query the vault's positions/orders) instead of the main account. The path to scaling capital:
   *  our own deposit + depositors, with a public on-chain track. Inert if unset → main-account trading. */
  HL_VAULT_ADDRESS: z.string().optional(),

  /** Telegram notifications from the LEGACY Bybit/LuxAlgo tracks (hourly webhook-watchdog silence alerts,
   *  daily wrap, balance/tpsl/subscription alerts, restart banner). Default OFF since Jul 3 2026 — the
   *  operator runs the HL live book and its trade notifications must not drown in dead-track noise.
   *  The legacy JOBS keep running (DB bookkeeping unaffected); only their Telegram sends are dropped. */
  LEGACY_NOTIFY: envBool(false),

  /**
   * Track C — LuxAlgo AI Strategy Builder webhook trader.
   * When true, webhooks with `"kind":"strategy"` get dispatched to
   * strategy-trader for entry/exit handling. Default off — operator turns
   * it on AFTER registering ≥1 strategy in STRATEGY_CONFIGS
   * (src/strategies/track-c-config.ts).
   */
  TRACK_C_ENABLED: envBool(false),

  /** Master switch for DEX-only in-process runtimes. This gates Lighter
   * Shadow/Native Quant and Hyperliquid collectors/runners without affecting
   * the Bybit SaaS, HTTP routes or persisted research evidence. */
  DEX_TRACK_ENABLED: envBool(true),

  /** Comma-separated user_id list whose orphan-position alerts should be
   *  silently dropped by the recovery-monitor. Use for the operator's own
   *  account (we manually open positions on Bybit there all the time —
   *  every one would falsely trigger an «ORPHAN POSITION DETECTED» alarm).
   *  Example: ORPHAN_ALERT_SKIP_USER_IDS=2,5 */
  ORPHAN_ALERT_SKIP_USER_IDS: z.string().default(''),

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

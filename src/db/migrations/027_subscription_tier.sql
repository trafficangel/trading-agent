-- 027_subscription_tier.sql — TRACK E auto-tier system.
--
-- Adds tier metadata + per-user overrides to user_subscriptions.
-- Default tier is 'starter' so existing rows match the lowest-balance
-- automation tier. Operator + Eldar rows get migrated to plan='vip'
-- with explicit override fields (see migration follow-up via admin
-- script — there's no global UPDATE here because override values are
-- per-user JSON not a constant).

ALTER TABLE user_subscriptions ADD COLUMN tier_id TEXT NOT NULL DEFAULT 'starter';

-- JSON array of strategy_ids. NULL = use tier defaults. Non-null = VIP
-- override (operator may pick custom strategy set).
ALTER TABLE user_subscriptions ADD COLUMN tier_override_strategies TEXT;

-- USD margin per trade. NULL = use tier default. Non-null = VIP override.
ALTER TABLE user_subscriptions ADD COLUMN tier_override_margin REAL;

-- JSON map { strategy_id: leverage }. NULL = use per-strategy
-- maxSafeLeverage from STRATEGY_CONFIGS. Non-null = VIP override.
ALTER TABLE user_subscriptions ADD COLUMN tier_override_leverage TEXT;

-- Lookup by tier (for admin stats / cron sweeper).
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_tier ON user_subscriptions(tier_id);

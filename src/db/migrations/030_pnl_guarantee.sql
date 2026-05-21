-- TRACK E Phase E2 — Money-back guarantee.
--
-- If a paying user's calendar-month PnL across closed user-decisions is
-- negative, their next month's subscription is free (we extend access_until
-- by ~30 days). Eligibility kicks in after the first FULL paid month —
-- trials and Bybit-referral bonuses don't trigger the guarantee.
--
-- Columns:
--   paid_started_at — set to Date.now() the first time an admin extends
--     the subscription as a paid renewal (admin flag in extend endpoint).
--     NULL until then; cron skips users with NULL.
--   last_pnl_guarantee_at — Date.now() when the guarantee was last applied.
--   last_pnl_guarantee_month — YYYY-MM string of the evaluated month. Used
--     as a one-time-per-month idempotency key so we never double-apply.
--   last_pnl_guarantee_pnl_usd — recorded PnL value (negative) for audit.

ALTER TABLE user_subscriptions ADD COLUMN paid_started_at INTEGER;
ALTER TABLE user_subscriptions ADD COLUMN last_pnl_guarantee_at INTEGER;
ALTER TABLE user_subscriptions ADD COLUMN last_pnl_guarantee_month TEXT;
ALTER TABLE user_subscriptions ADD COLUMN last_pnl_guarantee_pnl_usd REAL;

-- Index for the monthly sweep — cheap lookup of "paid users".
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_paid_started
  ON user_subscriptions(paid_started_at)
  WHERE paid_started_at IS NOT NULL;

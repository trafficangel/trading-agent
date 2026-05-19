-- Trading pause flag — user-controlled.
--
-- Separate from subscription lifecycle: a user with active subscription
-- and connected key can still pause their trading temporarily (vacation,
-- volatile market, risk-off). When paused:
--   - listEligibleTargets() excludes them → no new fan-out entries fire
--   - Open positions continue to their natural exit signal
--   - Cabinet shows the "trading paused" banner
--
-- NULL = trading active, INTEGER = paused-at unix-ms timestamp.
-- Stored on user_subscriptions (same row that already represents the
-- user's trading-access state) to keep state machine in one place.

ALTER TABLE user_subscriptions ADD COLUMN trading_paused_at INTEGER;
CREATE INDEX idx_user_subscriptions_paused
  ON user_subscriptions(trading_paused_at)
  WHERE trading_paused_at IS NOT NULL;

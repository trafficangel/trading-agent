-- Track D — subscription PLAN dimension (separate from lifecycle status).
--
-- Existing `status` column is the LIFECYCLE: trial → active → expired/cancelled.
-- This new `plan` column is the TIER: standard | vip.
--
-- Why split:
--   - status answers "does this user have access RIGHT NOW?"
--   - plan answers "WHAT KIND of access does this user have?"
--
-- VIP semantics:
--   - No trial countdown — VIP shows as permanent in cabinet UI
--   - access_until is set far in the future (year 2099) on promotion;
--     hasActiveAccess() short-circuits to true for plan='vip' regardless
--   - Granted manually by the operator OR auto-promoted from an allowlist
--     at registration time (see src/auth/vip-allowlist.ts)
--   - Demoting VIP back to standard restores normal access_until
--     evaluation against now()
--
-- Default 'standard' for all existing + future rows. Eldar (the first
-- beta tester) gets auto-promoted on his first registration via the
-- VIP_PHONES allowlist.

ALTER TABLE user_subscriptions ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard';
CREATE INDEX idx_user_subscriptions_plan ON user_subscriptions(plan);

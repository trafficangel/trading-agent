-- 028_tier_transition_state.sql — anti-flap state for tier transitions.
--
-- balance-monitor sees balance change every 5 min; without a grace
-- period a yo-yoing balance ($799 → $801 → $799) would flap tier
-- continuously, churning user_strategies rows. We track:
--   tier_transition_target_id: which tier balance has been pointing at
--   tier_transition_first_seen_at: unix ms when the suggestion first
--     started matching consistently
--
-- Downgrade applied after 72h continuous below current-tier min.
-- Upgrade prompt shown after 7 days continuous above current-tier max
-- (upgrade itself requires user confirmation, not auto-applied).

ALTER TABLE user_subscriptions ADD COLUMN tier_transition_target_id TEXT;
ALTER TABLE user_subscriptions ADD COLUMN tier_transition_first_seen_at INTEGER;

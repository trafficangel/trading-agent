-- Phase G — decouple tier choice from tier activation.
--
-- Until now tier_id (default 'standard' from ensureTrialFor) doubled as
-- both "what tier this user is currently on" AND "what tier they want".
-- That conflation made it impossible to let a user PICK a tier before
-- they have enough Bybit balance to activate it.
--
-- New column selected_tier_id stores the user's choice independently:
--   - NULL → user hasn't visited the tier picker yet
--   - 'starter' | 'standard' | 'plus' | 'pro' | 'vip' → user's choice
--
-- tier_id (existing) keeps its meaning: the ACTIVE tier (set by
-- assignTier when user_strategies rows are written). Onboarding logic
-- gates on whichever fits:
--   - "Выбор тарифа" step is done when selected_tier_id IS NOT NULL
--   - "Стратегии работают" step is done when user_strategies exist
--     AND there's at least one open/closed trade

ALTER TABLE user_subscriptions ADD COLUMN selected_tier_id TEXT;

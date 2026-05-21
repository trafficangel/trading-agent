-- 029_user_tier_history.sql — audit log for tier transitions.
--
-- Every assignTier / applyDowngrade / applyUpgrade writes a row here.
-- Used by:
--   - admin stats: «recent transitions» feed
--   - support: when user complains «почему мой пакет изменился» we
--     can show them exactly what happened and why
--   - cohort analysis: how often users downgrade vs upgrade
--
-- Reason is free-text: 'initial_assign', 'auto_downgrade_72h_grace',
-- 'manual_upgrade_user_confirmed', 'operator_override', 'qty_step_strategy_skipped'.

CREATE TABLE IF NOT EXISTS user_tier_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES registrations(id),
  from_tier TEXT,
  to_tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  balance_at_change_usdt REAL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_tier_history_user
  ON user_tier_history(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_tier_history_recent
  ON user_tier_history(created_at DESC);

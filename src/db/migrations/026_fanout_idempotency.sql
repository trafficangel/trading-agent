-- 026_fanout_idempotency.sql — audit C2
--
-- Hard backstop against duplicate user fan-out rows. Track D fan-out
-- pre-flight (findUserDecisionByParent) avoids the Bybit call when a
-- (parent_decision_id, user_id) row already exists; this partial
-- unique index makes the database refuse the INSERT in the unlikely
-- case the pre-flight raced with another in-flight execution.
--
-- Partial WHERE: shadow rows (user_id IS NULL) and rows where no parent
-- is set are intentionally excluded — the constraint only matters for
-- user-rows tied to a shadow webhook.
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_user_parent_unique
  ON decisions(parent_decision_id, user_id)
  WHERE user_id IS NOT NULL AND parent_decision_id IS NOT NULL;

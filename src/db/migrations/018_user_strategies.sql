-- Track D — SaaS copytrading: per-user strategy selection + sizing.
--
-- A user toggles individual strategies on/off and sets the notional
-- (USDT amount) used for each entry of that strategy. The notional is
-- the user's choice — they decide how much capital to allocate.
--
-- Why notional_usd per (user, strategy) and not a single global budget:
--   - Different strategies have different SL distances → different
--     max-loss profiles. Letting the user pick per-strategy gives them
--     fine control without us needing to compute risk-weights.
--   - Easy mental model: "100$ on STRAT-001, 500$ on STRAT-006" is
--     immediately understandable.
--
-- enabled=0 + enabled_at < disabled_at means the strategy was once on.
-- We keep history so a user re-enabling later doesn't lose audit trail.
-- The strategy fan-out only considers rows with enabled=1.
--
-- Constraints:
--   - notional_usd >= 10 enforced at the application layer (Bybit's
--     minimum notional per symbol varies; 10 USDT is a safe floor)
--   - max notional_usd capped at the user's account balance at apply time

CREATE TABLE user_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES registrations(id),
  strategy_id TEXT NOT NULL,             -- key into STRATEGY_CONFIGS
  enabled INTEGER NOT NULL DEFAULT 1,    -- 0/1
  notional_usd REAL NOT NULL,            -- USDT per entry
  enabled_at INTEGER NOT NULL,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, strategy_id)
);
CREATE INDEX idx_user_strategies_strategy_active
  ON user_strategies(strategy_id) WHERE enabled = 1;
CREATE INDEX idx_user_strategies_user ON user_strategies(user_id);

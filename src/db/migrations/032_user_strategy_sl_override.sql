-- Phase N — per-user-per-strategy SL override (Prof tier).
--
-- Until now Prof users could customise notional + leverage per strategy
-- (`user_strategies.notional_usd`, `user_strategies.leverage`) but the
-- safety stop-loss was always taken from STRATEGY_CONFIGS[sid].slPct —
-- platform-controlled. Some Prof users want tighter SLs (e.g. take BCH
-- from 3.5% down to 2%) on their own responsibility.
--
-- New column `sl_pct_override` is nullable:
--   NULL  → use STRATEGY_CONFIGS[sid].slPct (default behaviour, all
--           non-prof tiers stay here)
--   ≠NULL → use this value as the slPct in user-fan-out SL placement.
--           Stored as a decimal (e.g. 0.025 = 2.5%). UI enforces a
--           range of [0.005, 0.25] = 0.5%–25%.
--
-- Existing rows get NULL via SQLite's column-add default. No data
-- migration needed.

ALTER TABLE user_strategies ADD COLUMN sl_pct_override REAL;

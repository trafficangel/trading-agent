-- 044_hl_momentum_kelly_sizing.sql
-- Store the sizing decision for Momentum v2 signal research.

ALTER TABLE hl_momentum_signal_journal ADD COLUMN notional_usd REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN kelly_fraction REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN equity_usd REAL;

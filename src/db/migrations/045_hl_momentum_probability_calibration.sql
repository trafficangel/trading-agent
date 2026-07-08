-- 045_hl_momentum_probability_calibration.sql
-- Store calibrated probability fields for Momentum v2 signal research.

ALTER TABLE hl_momentum_signal_journal ADD COLUMN model_prob REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN calibrated_prob REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN prob_confidence REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN kelly_confidence REAL;

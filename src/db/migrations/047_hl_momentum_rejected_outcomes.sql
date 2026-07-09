-- 047_hl_momentum_rejected_outcomes.sql
-- Counterfactual outcomes for rejected Momentum signals. These are not real
-- trades; they let the Doctor learn whether SKIP gates saved money or missed
-- profitable entries.

ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_exit_px REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_closed_at INTEGER;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_pnl_pct REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_reason TEXT;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_mfe_pct REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_mae_pct REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN counterfactual_horizon_min INTEGER;

CREATE INDEX IF NOT EXISTS idx_hl_mom_sig_counterfactual
  ON hl_momentum_signal_journal(decision, counterfactual_closed_at);

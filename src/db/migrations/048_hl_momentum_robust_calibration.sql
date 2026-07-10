-- Store predictions before any learned bias so calibration can target an
-- absolute residual instead of repeatedly adding errors from prior windows.
ALTER TABLE hl_momentum_signal_journal ADD COLUMN raw_prob REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN raw_expected_pnl REAL;
ALTER TABLE hl_momentum_signal_journal ADD COLUMN calibration_version TEXT;

CREATE INDEX idx_hl_mom_sig_calibration
  ON hl_momentum_signal_journal(calibration_version, decision, ts);

CREATE TABLE hl_momentum_calibration_history (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at            INTEGER NOT NULL,
  calibration_version   TEXT    NOT NULL,
  sample_n              INTEGER NOT NULL,
  last_closed_id        INTEGER NOT NULL,
  actual_wr             REAL    NOT NULL,
  raw_pred_wr           REAL    NOT NULL,
  actual_avg_pnl_pct    REAL    NOT NULL,
  raw_pred_ev_pct       REAL    NOT NULL,
  robust_ev_residual    REAL    NOT NULL,
  residual_cap          REAL    NOT NULL,
  target_prob_bias      REAL    NOT NULL,
  target_ev_bias_pct    REAL    NOT NULL,
  old_prob_bias         REAL    NOT NULL,
  new_prob_bias         REAL    NOT NULL,
  old_ev_bias_pct       REAL    NOT NULL,
  new_ev_bias_pct       REAL    NOT NULL
);

CREATE INDEX idx_hl_mom_cal_history_created
  ON hl_momentum_calibration_history(created_at DESC);

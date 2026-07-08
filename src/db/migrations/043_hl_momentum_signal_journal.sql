-- 043_hl_momentum_signal_journal.sql
-- Research journal for Momentum v2. Records every qualifying signal candidate
-- and the gate decision, including skipped candidates, so the Doctor can learn
-- from both trades and non-trades.

CREATE TABLE IF NOT EXISTS hl_momentum_signal_journal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  coin            TEXT    NOT NULL,
  side            TEXT    NOT NULL,
  layer           TEXT    NOT NULL, -- 'fast' | 'confirm'
  score           REAL    NOT NULL,
  expected_pnl    REAL    NOT NULL,
  decision        TEXT    NOT NULL, -- 'paper' | 'live-open' | 'skip'
  reason          TEXT    NOT NULL,
  ref_px          REAL,
  signal_px       REAL,
  r30             REAL,
  r90             REAL,
  r3              REAL,
  r12             REAL,
  from_last       REAL,
  vol_ratio       REAL,
  spread_pct      REAL,
  side_depth_usd  REAL,
  open_total      INTEGER NOT NULL DEFAULT 0,
  open_same_side  INTEGER NOT NULL DEFAULT 0,
  signal          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hl_mom_sig_ts
  ON hl_momentum_signal_journal(ts);
CREATE INDEX IF NOT EXISTS idx_hl_mom_sig_coin_ts
  ON hl_momentum_signal_journal(coin, ts);
CREATE INDEX IF NOT EXISTS idx_hl_mom_sig_decision_ts
  ON hl_momentum_signal_journal(decision, ts);

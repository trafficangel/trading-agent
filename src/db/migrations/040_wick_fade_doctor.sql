-- 040_wick_fade_doctor.sql
-- Persistent protective pauses produced by the wick-fade doctor.
-- The doctor is allowed to REMOVE risk (pause weak coin/side quoting) but not
-- increase size, leverage, or loosen stops automatically.

CREATE TABLE IF NOT EXISTS wick_fade_doctor_pause (
  coin               TEXT    NOT NULL,
  side               TEXT    NOT NULL, -- 'long' | 'short'
  paused_until        INTEGER NOT NULL,
  reason             TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  last_seen_trade_id  INTEGER NOT NULL,
  PRIMARY KEY (coin, side)
);

CREATE INDEX IF NOT EXISTS idx_wf_doctor_pause_until
  ON wick_fade_doctor_pause(paused_until);

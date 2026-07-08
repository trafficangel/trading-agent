-- 042_hl_momentum_live.sql
-- Real-money version of the HL momentum-follow candidate. It shares the same
-- account as wick-fade, so it also owns a per-coin lock table. Wick-fade checks
-- that lock and pulls/skips its traps for the locked coin.

CREATE TABLE IF NOT EXISTS hl_momentum_live_pos (
  coin       TEXT    PRIMARY KEY,
  side       TEXT    NOT NULL, -- 'long' | 'short'
  entry_px   REAL    NOT NULL,
  qty        REAL    NOT NULL,
  opened_at  INTEGER NOT NULL,
  signal     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS hl_momentum_live_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coin         TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  entry_px     REAL    NOT NULL,
  qty          REAL    NOT NULL,
  opened_at    INTEGER NOT NULL,
  signal       TEXT    NOT NULL,
  exit_px      REAL,
  closed_at    INTEGER,
  pnl_pct      REAL, -- net of estimated taker RT cost
  close_reason TEXT  -- 'target' | 'stop' | 'time-stop' | 'reconciled-flat'
);

CREATE TABLE IF NOT EXISTS hl_momentum_live_lock (
  coin         TEXT    PRIMARY KEY,
  locked_until INTEGER NOT NULL,
  reason       TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hl_mom_live_log_closed
  ON hl_momentum_live_log(closed_at);
CREATE INDEX IF NOT EXISTS idx_hl_mom_live_log_coin
  ON hl_momentum_live_log(coin, opened_at);
CREATE INDEX IF NOT EXISTS idx_hl_mom_live_lock_until
  ON hl_momentum_live_lock(locked_until);

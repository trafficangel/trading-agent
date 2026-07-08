-- 041_hl_momentum_shadow.sql
-- Paper-only Hyperliquid momentum-follow strategy. It watches native HL 5m
-- candles and writes simulated entries/exits, but never sends exchange orders.

CREATE TABLE IF NOT EXISTS hl_momentum_shadow_pos (
  coin       TEXT    PRIMARY KEY,
  side       TEXT    NOT NULL, -- 'long' | 'short'
  entry_px   REAL    NOT NULL,
  qty        REAL    NOT NULL,
  opened_at  INTEGER NOT NULL,
  signal     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS hl_momentum_shadow_log (
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
  close_reason TEXT  -- 'target' | 'stop' | 'time-stop'
);

CREATE INDEX IF NOT EXISTS idx_hl_mom_log_closed
  ON hl_momentum_shadow_log(closed_at);
CREATE INDEX IF NOT EXISTS idx_hl_mom_log_coin
  ON hl_momentum_shadow_log(coin, opened_at);

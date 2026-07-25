CREATE TABLE IF NOT EXISTS lighter_lux_signals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key             TEXT NOT NULL UNIQUE,
  strategy_id           TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  side                  TEXT NOT NULL CHECK(side IN ('long', 'short')),
  strategy_event        TEXT NOT NULL,
  bar_time              INTEGER NOT NULL,
  received_at           INTEGER NOT NULL,
  capture_due_at        INTEGER NOT NULL,
  captured_at           INTEGER,
  capture_status        TEXT NOT NULL DEFAULT 'pending',
  capture_error         TEXT,
  book_exchange_at      INTEGER,
  book_age_ms           INTEGER,
  bid                   REAL,
  ask                   REAL,
  buy_vwap_1000         REAL,
  sell_vwap_1000        REAL,
  spread_pct            REAL,
  buy_slippage_pct      REAL,
  sell_slippage_pct     REAL,
  funding_rate_pct_h    REAL,
  index_price           REAL,
  mark_price            REAL
);

CREATE TABLE IF NOT EXISTS lighter_lux_trades (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id           TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  side                  TEXT NOT NULL CHECK(side IN ('long', 'short')),
  entry_signal_id       INTEGER NOT NULL UNIQUE REFERENCES lighter_lux_signals(id),
  exit_signal_id        INTEGER REFERENCES lighter_lux_signals(id),
  opened_at             INTEGER NOT NULL,
  closed_at             INTEGER,
  entry_price           REAL NOT NULL,
  exit_price            REAL,
  entry_funding_pct_h   REAL NOT NULL DEFAULT 0,
  exit_funding_pct_h    REAL,
  gross_pnl_pct         REAL,
  funding_pnl_pct       REAL,
  net_pnl_pct           REAL,
  notional_usd          REAL NOT NULL DEFAULT 1000,
  close_reason          TEXT
);

CREATE UNIQUE INDEX idx_lighter_lux_one_open
  ON lighter_lux_trades(strategy_id)
  WHERE closed_at IS NULL;
CREATE INDEX idx_lighter_lux_signal_received
  ON lighter_lux_signals(strategy_id, received_at);
CREATE INDEX idx_lighter_lux_trade_closed
  ON lighter_lux_trades(strategy_id, closed_at);

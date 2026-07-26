CREATE TABLE IF NOT EXISTS lighter_lux_live_state (
  id                    INTEGER PRIMARY KEY CHECK(id = 1),
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  last_signal_id        INTEGER,
  started_at            INTEGER,
  heartbeat_at          INTEGER,
  status                TEXT NOT NULL DEFAULT 'idle',
  last_error             TEXT
);

INSERT OR IGNORE INTO lighter_lux_live_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS lighter_lux_live_decisions (
  signal_id             INTEGER PRIMARY KEY REFERENCES lighter_lux_signals(id),
  decided_at            INTEGER NOT NULL,
  decision              TEXT NOT NULL,
  reason                TEXT NOT NULL,
  trade_id              INTEGER
);

CREATE TABLE IF NOT EXISTS lighter_lux_live_trades (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id           TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  market_id             INTEGER NOT NULL,
  side                  TEXT NOT NULL CHECK(side IN ('long', 'short')),
  entry_signal_id       INTEGER NOT NULL UNIQUE REFERENCES lighter_lux_signals(id),
  exit_signal_id        INTEGER REFERENCES lighter_lux_signals(id),
  opened_at             INTEGER NOT NULL,
  closed_at             INTEGER,
  requested_notional_usd REAL NOT NULL,
  filled_notional_usd   REAL,
  leverage              INTEGER NOT NULL,
  quantity              REAL,
  entry_price           REAL,
  stop_pct              REAL NOT NULL,
  stop_price            REAL,
  exit_price            REAL,
  gross_pnl_usd         REAL,
  funding_pnl_usd       REAL NOT NULL DEFAULT 0,
  fee_usd               REAL NOT NULL DEFAULT 0,
  net_pnl_usd           REAL,
  net_pnl_pct           REAL,
  entry_order_index     INTEGER NOT NULL,
  stop_order_index      INTEGER,
  exit_order_index      INTEGER,
  close_reason          TEXT,
  status                TEXT NOT NULL DEFAULT 'opening'
    CHECK(status IN ('opening', 'open', 'closing', 'closed', 'error')),
  error                 TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_lux_live_one_open
  ON lighter_lux_live_trades((1))
  WHERE status IN ('opening', 'open', 'closing');

CREATE INDEX IF NOT EXISTS idx_lighter_lux_live_closed
  ON lighter_lux_live_trades(closed_at);

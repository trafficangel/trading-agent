ALTER TABLE lighter_lux_live_state
  ADD COLUMN cumulative_net_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE lighter_lux_live_state
  ADD COLUMN equity_peak_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE lighter_lux_live_state
  ADD COLUMN current_drawdown_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE lighter_lux_live_state
  ADD COLUMN max_drawdown_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE lighter_lux_live_state
  ADD COLUMN portfolio_paused_at INTEGER;

ALTER TABLE lighter_lux_live_state
  ADD COLUMN portfolio_pause_reason TEXT;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_reference_source REAL;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_reference_l2 REAL;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_slippage_pct REAL;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_book_age_ms INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_reference_source REAL;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_reference_l2 REAL;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_slippage_pct REAL;

UPDATE lighter_lux_live_trades
SET entry_reference_source = (
      SELECT source_price FROM lighter_lux_signals
      WHERE id = lighter_lux_live_trades.entry_signal_id
    ),
    entry_reference_l2 = (
      SELECT CASE
        WHEN lighter_lux_live_trades.side = 'long' THEN buy_vwap_1000
        ELSE sell_vwap_1000
      END
      FROM lighter_lux_signals
      WHERE id = lighter_lux_live_trades.entry_signal_id
    ),
    entry_book_age_ms = (
      SELECT book_age_ms FROM lighter_lux_signals
      WHERE id = lighter_lux_live_trades.entry_signal_id
    );

UPDATE lighter_lux_live_trades
SET entry_slippage_pct = CASE
      WHEN entry_price IS NULL OR entry_reference_l2 IS NULL THEN NULL
      WHEN side = 'long'
        THEN (entry_price - entry_reference_l2) / entry_reference_l2 * 100
      ELSE (entry_reference_l2 - entry_price) / entry_reference_l2 * 100
    END,
    exit_reference_source = (
      SELECT source_price FROM lighter_lux_signals
      WHERE id = lighter_lux_live_trades.exit_signal_id
    ),
    exit_reference_l2 = (
      SELECT CASE
        WHEN lighter_lux_live_trades.side = 'long' THEN sell_vwap_1000
        ELSE buy_vwap_1000
      END
      FROM lighter_lux_signals
      WHERE id = lighter_lux_live_trades.exit_signal_id
    );

UPDATE lighter_lux_live_trades
SET exit_slippage_pct = CASE
      WHEN exit_price IS NULL OR exit_reference_l2 IS NULL THEN NULL
      WHEN side = 'long'
        THEN (exit_reference_l2 - exit_price) / exit_reference_l2 * 100
      ELSE (exit_price - exit_reference_l2) / exit_reference_l2 * 100
    END;

CREATE TABLE lighter_lux_live_strategy_state (
  strategy_id           TEXT PRIMARY KEY,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  closed_trades         INTEGER NOT NULL DEFAULT 0,
  net_pnl_usd           REAL NOT NULL DEFAULT 0,
  profit_factor         REAL,
  first_half_net_usd    REAL NOT NULL DEFAULT 0,
  second_half_net_usd   REAL NOT NULL DEFAULT 0,
  max_drawdown_usd      REAL NOT NULL DEFAULT 0,
  gate_status           TEXT NOT NULL DEFAULT 'collecting'
    CHECK(gate_status IN ('collecting', 'watch', 'passed', 'paused')),
  paused_at             INTEGER,
  pause_reason          TEXT,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_lighter_lux_live_strategy_gate
  ON lighter_lux_live_strategy_state(enabled, gate_status);

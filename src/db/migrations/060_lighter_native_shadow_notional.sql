ALTER TABLE lighter_lux_signals
  ADD COLUMN execution_notional_usd REAL NOT NULL DEFAULT 1000;

CREATE INDEX idx_lighter_lux_signal_notional
  ON lighter_lux_signals(strategy_id, execution_notional_usd, received_at);

CREATE INDEX idx_lighter_lux_trade_notional
  ON lighter_lux_trades(strategy_id, notional_usd, closed_at);

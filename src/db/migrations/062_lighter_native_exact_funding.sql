ALTER TABLE lighter_lux_trades
  ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'entry_exit_estimate'
  CHECK(funding_source IN ('entry_exit_estimate', 'lighter_api_settlements'));

ALTER TABLE lighter_lux_trades
  ADD COLUMN funding_reconciled_at INTEGER;

CREATE INDEX idx_lighter_lux_trade_funding_reconcile
  ON lighter_lux_trades(notional_usd, funding_source, closed_at);

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_fill_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_fill_count INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_fill_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_fill_count INTEGER;

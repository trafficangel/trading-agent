ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_started_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_order_sent_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_order_accepted_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN entry_position_seen_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN stop_order_sent_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN protected_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_order_sent_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_order_accepted_at INTEGER;

ALTER TABLE lighter_lux_live_trades
  ADD COLUMN exit_position_gone_at INTEGER;

UPDATE lighter_lux_live_trades
SET entry_started_at = opened_at
WHERE entry_started_at IS NULL;

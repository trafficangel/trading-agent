-- Remove the original portfolio-wide single-position lock. Lighter is one-way
-- per market, so independent strategies may trade concurrently while a market
-- can still have only one opening/open/closing owner in our journal.
DROP INDEX IF EXISTS idx_lighter_lux_live_one_open;

CREATE UNIQUE INDEX idx_lighter_lux_live_one_open_per_market
  ON lighter_lux_live_trades(market_id)
  WHERE status IN ('opening', 'open', 'closing');

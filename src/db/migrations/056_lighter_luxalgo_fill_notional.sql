UPDATE lighter_lux_live_trades
SET filled_notional_usd = ABS(quantity) * entry_price
WHERE quantity IS NOT NULL
  AND entry_price IS NOT NULL
  AND entry_price > 0;

UPDATE lighter_lux_live_trades
SET net_pnl_pct = net_pnl_usd / filled_notional_usd * 100
WHERE net_pnl_usd IS NOT NULL
  AND filled_notional_usd IS NOT NULL
  AND filled_notional_usd > 0;

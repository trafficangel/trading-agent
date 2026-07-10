ALTER TABLE wick_fade_log ADD COLUMN entry_notional_usd REAL;
ALTER TABLE wick_fade_log ADD COLUMN exit_notional_usd REAL;
ALTER TABLE wick_fade_log ADD COLUMN gross_pnl_usd REAL;
ALTER TABLE wick_fade_log ADD COLUMN fee_usd REAL;
ALTER TABLE wick_fade_log ADD COLUMN funding_usd REAL;
ALTER TABLE wick_fade_log ADD COLUMN net_pnl_usd REAL;
ALTER TABLE wick_fade_log ADD COLUMN accounting_fill_count INTEGER;
ALTER TABLE wick_fade_log ADD COLUMN pnl_source TEXT;

CREATE INDEX idx_wick_log_accounting
  ON wick_fade_log(mode, pnl_source, closed_at);

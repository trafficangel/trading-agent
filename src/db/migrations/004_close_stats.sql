-- When a position is closed (TP hit / SL hit / LLM close / manual), record
-- the actual exit details on the parent OPEN row so we can show real results
-- in posts and aggregate win-rate / R-multiple stats accurately.
ALTER TABLE decisions ADD COLUMN close_price REAL;
ALTER TABLE decisions ADD COLUMN close_reason TEXT;  -- 'tp_hit' | 'sl_hit' | 'llm_close' | 'manual'
ALTER TABLE decisions ADD COLUMN pnl_pct REAL;        -- side-adjusted realized PnL percent
ALTER TABLE decisions ADD COLUMN pnl_r REAL;          -- in R-multiples (entry-to-SL = 1R)

CREATE INDEX IF NOT EXISTS idx_decisions_close_reason ON decisions(close_reason);

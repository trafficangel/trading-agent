-- Per-strategy trade number.
--
-- The global decision.id (e.g. 202) is not useful for subscribers — it
-- mixes Track A / B / C records and gives no sense of "how many trades
-- has THIS strategy done". We want posts to show "T#1, T#2, T#3, ..."
-- per strategy so newcomers can immediately gauge sample size.
--
-- Stored at row insert (cheaper than recomputing on every render);
-- backfilled here for the one existing pre-migration row.

ALTER TABLE decisions ADD COLUMN strategy_trade_num INTEGER;

-- Backfill: for each strategy_id, number trades 1..N by created_at order.
-- Uses a correlated subquery (SQLite has no ROW_NUMBER window function on
-- old versions but supports COUNT(*) subqueries fine).
UPDATE decisions
SET strategy_trade_num = (
  SELECT COUNT(*)
  FROM decisions AS d2
  WHERE d2.track = 'strategy'
    AND d2.strategy_id = decisions.strategy_id
    AND d2.created_at <= decisions.created_at
)
WHERE track = 'strategy' AND strategy_id IS NOT NULL;

-- Helpful index for the "max + 1" lookup on next insert.
CREATE INDEX IF NOT EXISTS idx_decisions_strategy_trade_num
  ON decisions(strategy_id, strategy_trade_num DESC)
  WHERE strategy_id IS NOT NULL;

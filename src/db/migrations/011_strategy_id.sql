-- Track C — LuxAlgo Strategy Builder webhook trader.
--
-- Each Track C decision row carries the strategy_id (e.g.
-- 'ton-cntr-tt-mf50'), which lets us:
--   - find the open position fast on the exit-webhook path:
--     findActiveByStrategy(symbol, strategy_id)
--   - aggregate per-strategy stats in self-review and daily-wrap
--   - audit which configured strategy produced which trade
--
-- Nullable for backwards compatibility: existing track='llm' / 'signal'
-- rows stay NULL. NOT NULL is enforced in code (strategy-trader.ts) only
-- for track='strategy' inserts — keeps the schema flexible if we ever
-- shift the per-strategy model.

ALTER TABLE decisions ADD COLUMN strategy_id TEXT;

-- Hot path: exit webhook handler queries (symbol, strategy_id) with status='active'.
-- Partial index keeps it small — only Track C rows pay the indexing cost.
CREATE INDEX IF NOT EXISTS idx_decisions_strategy_active
  ON decisions(symbol, strategy_id, status)
  WHERE strategy_id IS NOT NULL;

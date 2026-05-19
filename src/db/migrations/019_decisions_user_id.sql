-- Track D — SaaS copytrading: link decisions to users + real Bybit orders.
--
-- Pre-Track-D: every row in `decisions` is the operator's shadow trade
-- (paper-only, no exchange interaction). user_id IS NULL.
--
-- Post-Track-D: when a strategy fires, we write ONE shadow row (user_id
-- NULL, for the public landing trade-log) PLUS N user rows (user_id set,
-- one per eligible subscriber). The user rows carry exchange_order_id
-- from the real Bybit fill.
--
-- parent_decision_id (already exists) is repurposed for Track D: the
-- N user rows reference the shadow row, so:
--   - /strategies landing keeps reading shadow rows (user_id IS NULL)
--     and the public trade-log stays untouched
--   - /account/trades filters by user_id
--   - admin can join user rows ← parent_decision_id → shadow row for
--     diagnostics ("everyone got this same signal, here are their fills")
--
-- exchange_order_id: Bybit's orderId for the market entry. Used for
-- reconcile (fetchOrderStatus) and for displaying "real" fill info in
-- the user's trade history.
--
-- exchange_sl_order_id: Bybit's orderId for the safety stop. Bybit V5
-- position-based SL has its own orderId returned by /v5/position/trading-stop.
-- We track it so we can verify the SL is still attached on each tpsl tick.
--
-- bybit_qty / bybit_avg_price: actual filled quantity and average price
-- from Bybit's fill (may differ from our entry price due to slippage).
-- These are the SOURCE OF TRUTH for PnL calculation on user rows.

ALTER TABLE decisions ADD COLUMN user_id INTEGER REFERENCES registrations(id);
ALTER TABLE decisions ADD COLUMN exchange_order_id TEXT;
ALTER TABLE decisions ADD COLUMN exchange_sl_order_id TEXT;
ALTER TABLE decisions ADD COLUMN bybit_qty REAL;
ALTER TABLE decisions ADD COLUMN bybit_avg_price REAL;
ALTER TABLE decisions ADD COLUMN bybit_close_avg_price REAL;
ALTER TABLE decisions ADD COLUMN order_error TEXT;  -- populated if Bybit rejected the order

-- For the fan-out occupancy guard ("does this user already have an
-- open position on this strategy?"). Without WHERE clause to avoid
-- partial-index issues when user_id is NULL.
CREATE INDEX idx_decisions_user_strategy_active
  ON decisions(user_id, strategy_id, status)
  WHERE user_id IS NOT NULL AND status = 'active';
CREATE INDEX idx_decisions_user_created
  ON decisions(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

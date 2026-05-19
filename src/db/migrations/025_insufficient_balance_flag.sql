-- Insufficient-balance flag on user_api_keys.
--
-- Set whenever Bybit rejects an order with retCode 110007 or 110012
-- ("insufficient balance"). The user has spent everything and can't
-- open more positions.
--
-- While set:
--   - listEligibleTargets() filters this user out → no new fan-out
--     until they top up. Avoids hammering Bybit with rejected orders.
--   - Cabinet banner asks them to top up + verify.
--   - Manual «Проверить связь» click in cabinet auto-clears the flag
--     (we trust the user to know they topped up; if not, the next
--     signal will re-set it).
--
-- Open positions are unaffected — Bybit handles closure regardless of
-- spot balance.

ALTER TABLE user_api_keys ADD COLUMN insufficient_balance_at INTEGER;
CREATE INDEX idx_user_api_keys_insufficient
  ON user_api_keys(insufficient_balance_at)
  WHERE insufficient_balance_at IS NOT NULL;

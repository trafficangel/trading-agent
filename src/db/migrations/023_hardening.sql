-- Hardening migration (post-Track-D launch, May 2026).
-- Bundles 5 unrelated column/table additions into one file because
-- each is small and they all support the audit-driven hardening sprint
-- (see docs/AUDIT-RECOMMENDATIONS.md).

-- 1. Balance cache in DB (was in-memory Map, vanished on restart).
--    Updated on every successful fetchBalanceUsdt call.
ALTER TABLE user_api_keys ADD COLUMN last_balance_usdt REAL;
ALTER TABLE user_api_keys ADD COLUMN last_balance_at INTEGER;

-- 2. Webhook idempotency. TradingView retries on 5xx/network errors;
--    without a dedup key we'd open N more positions on every retry.
--    Key = sha256(strategy_id|symbol|side|bar_time) computed in the
--    webhook handler. Unique constraint enforces idempotency at the
--    DB layer regardless of timing.
ALTER TABLE decisions ADD COLUMN webhook_dedup_key TEXT;
CREATE UNIQUE INDEX idx_decisions_webhook_dedup
  ON decisions(webhook_dedup_key)
  WHERE webhook_dedup_key IS NOT NULL;

-- 3. Trial-expiry notification flag. Set when we sent a "trial expires
--    soon" Telegram notice, prevents duplicate notifications across
--    multiple cron ticks.
ALTER TABLE user_subscriptions ADD COLUMN expiry_notified_at INTEGER;

-- 4. Admin audit log. Every privileged action (VIP toggle, subscription
--    extend, key revoke, etc.) gets a row here. Survives log rotation.
CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  admin_email TEXT NOT NULL,
  target_user_id INTEGER REFERENCES registrations(id),
  action TEXT NOT NULL,           -- 'set_plan' | 'extend_subscription' | 'revoke_key' | ...
  before_json TEXT,               -- state snapshot before mutation
  after_json TEXT,                -- state snapshot after mutation
  note TEXT,                      -- admin's free-form reason
  ip TEXT
);
CREATE INDEX idx_admin_audit_ts ON admin_audit_log(ts DESC);
CREATE INDEX idx_admin_audit_user ON admin_audit_log(target_user_id);

-- 5. OTP code is now hashed (sha256(code + pepper)) instead of plaintext.
--    We DON'T rename the column — same writer/reader change is enough,
--    and the 1h purge in recordVerificationAttempt cleans legacy
--    plaintext rows naturally within an hour of this deploy.

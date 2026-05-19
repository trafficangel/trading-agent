-- Track D — SaaS copytrading: encrypted client API keys.
--
-- Each registered user can attach one Bybit API key (trade-only, no
-- withdraw, IP-whitelisted to our VPS). The plaintext API key + secret
-- NEVER hit the disk — we store AES-256-GCM ciphertext with per-row
-- random IV and authentication tag. The 32-byte master key lives in
-- process.env.API_KEY_MASTER_SECRET (see src/auth/crypto.ts).
--
-- Threat model:
--   - VPS compromise → attacker reads .env → keys decryptable. Mitigated
--     by Bybit-side IP-whitelist + trade-only permission (no withdraw,
--     no transfer). Worst case: attacker opens junk trades, can't drain.
--   - SQLite leak alone (e.g. backup theft) → ciphertext useless without
--     the master key.
--   - Rotating master key: re-encrypt all rows in a one-off migration.
--
-- Why UNIQUE(user_id, exchange): one key per (user, exchange). Adding
-- a second exchange (e.g. Binance) just inserts another row.
--
-- revoked_at semantics: soft-delete. Old open positions stay open and
-- get reconciled normally; the strategy fan-out skips revoked rows when
-- selecting eligible users for new entries.

CREATE TABLE user_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES registrations(id),
  exchange TEXT NOT NULL DEFAULT 'bybit',
  api_key_encrypted TEXT NOT NULL,    -- base64(ciphertext)
  api_secret_encrypted TEXT NOT NULL, -- base64(ciphertext)
  iv TEXT NOT NULL,                   -- hex(12 bytes nonce)
  auth_tag TEXT NOT NULL,             -- hex(16 bytes GCM tag)
  created_at INTEGER NOT NULL,
  last_verified_at INTEGER,           -- last successful /v5/account/info call
  last_verify_error TEXT,             -- diagnostic if verify failed
  revoked_at INTEGER,                 -- soft-delete
  UNIQUE(user_id, exchange)
);
CREATE INDEX idx_user_api_keys_active ON user_api_keys(user_id) WHERE revoked_at IS NULL;

-- Telegram Gateway-based phone verification + persistent session.
--
-- Flow:
--   POST /auth/start { phone }       → server calls Gateway sendVerificationMessage
--                                      → Gateway delivers a code to the phone's
--                                        Telegram account.
--                                      → server returns request_id (stored in
--                                        short-lived pending_auth cookie).
--   POST /auth/verify { code }       → server calls Gateway checkVerificationStatus
--                                      → if valid: INSERT INTO registrations,
--                                        Set-Cookie session_id (90 days).
--
-- Privacy: we hash the phone number (SHA-256) before storing — never keep
-- the plaintext. The Gateway service has it briefly to deliver the code
-- but we don't.
--
-- Anti-abuse:
--   - verification_attempts table tracks recent /auth/start calls per IP
--   - registrations.ip_first audit-trails original signup origin
--   - rate-limit applied at the route layer (not in schema)

CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hash TEXT NOT NULL,
  tg_user_id INTEGER,
  session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_first TEXT,
  user_agent_first TEXT
);
CREATE INDEX idx_registrations_phone_hash ON registrations(phone_hash);
CREATE INDEX idx_registrations_session ON registrations(session_id);
CREATE INDEX idx_registrations_created_at ON registrations(created_at);

-- In-flight verifications (TTL ~10 min, cleaned by cron or on-the-fly).
CREATE TABLE verification_attempts (
  request_id TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_verif_phone_hash ON verification_attempts(phone_hash);
CREATE INDEX idx_verif_created_at ON verification_attempts(created_at);

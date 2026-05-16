-- Server-generated verification code.
--
-- Initial implementation (migration 013) was based on Gateway-generated
-- codes verified via checkVerificationStatus. After discovering that
-- gateway.telegram.org/api/* always returns "Bad request" and the
-- correct base URL is gatewayapi.telegram.org/ — we switched to the
-- simpler "server generates code, passes to Gateway" pattern.
--
-- Now we store the actual 6-digit code we asked Gateway to deliver,
-- and verify by direct string compare on the user's submission.
-- Removes one HTTPS round-trip per login.

ALTER TABLE verification_attempts ADD COLUMN code TEXT;

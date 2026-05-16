-- Store the plaintext phone alongside the hash.
--
-- Initial design (migration 013) hashed phones for privacy. But the
-- operator needs an admin dashboard to see who's registered (date,
-- time, phone) so they can:
--   - Manually contact users about issues
--   - Spot abuse patterns
--   - Verify suspicious registrations against actual Telegram users
--
-- Trade-off: we no longer claim "plaintext never stored" — the gate
-- form copy is updated accordingly. Phone is still NOT shared with
-- third parties; used only for verification + operator support.

ALTER TABLE registrations ADD COLUMN phone TEXT;
ALTER TABLE verification_attempts ADD COLUMN phone TEXT;

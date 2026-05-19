-- Track D — capture user's display name at registration.
--
-- The cabinet greets the user by name instead of a masked phone number.
-- Name is also surfaced in the admin dashboard alongside the phone, so
-- the operator can recognise users in support chats without having to
-- translate "+994 *** ** 5888" → "Эльдар" in their head.
--
-- The phone-OTP flow stays unchanged for the security boundary (phone
-- still proves identity). Name is informational, not used for auth.
--
-- verification_attempts gets the same column so the name typed at
-- /auth/start travels to /auth/verify and lands on the registrations
-- row in one transaction.
--
-- NULL for legacy rows registered before this migration. The cabinet
-- falls back to a generic "Привет!" without the phone for those.

ALTER TABLE registrations ADD COLUMN display_name TEXT;
ALTER TABLE verification_attempts ADD COLUMN display_name TEXT;

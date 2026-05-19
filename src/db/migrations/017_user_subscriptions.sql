-- Track D — SaaS copytrading: per-user subscription state.
--
-- On the first phone-OTP registration, a row is auto-inserted with
-- status='trial' and access_until = created_at + 14 days. The user can
-- attach API keys and pick strategies immediately — but orders fan-out
-- only fires while access_until > now().
--
-- Status transitions (current MVP, all manual via admin until billing
-- is wired):
--   trial    → active     (admin extends after payment received)
--   trial    → expired    (auto, when access_until passes)
--   active   → expired    (auto, when access_until passes)
--   expired  → active     (admin extends after renewal payment)
--   any      → cancelled  (user clicks "отключить" — closes positions,
--                          revokes new entries; data retained)
--
-- access_until is the source of truth; status is a denormalised label
-- for display. A background job (added later) flips status='expired'
-- once access_until < now().
--
-- manually_extended_by audits every admin action — never delete rows,
-- write a new updated_at + the admin's email each time.

CREATE TABLE user_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES registrations(id),
  status TEXT NOT NULL,                -- 'trial' | 'active' | 'expired' | 'cancelled'
  trial_started_at INTEGER NOT NULL,
  access_until INTEGER NOT NULL,
  manually_extended_by TEXT,           -- admin email; NULL if auto-issued trial
  manual_extension_note TEXT,          -- free-form admin note
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_user_subscriptions_access ON user_subscriptions(access_until);
CREATE INDEX idx_user_subscriptions_status ON user_subscriptions(status);

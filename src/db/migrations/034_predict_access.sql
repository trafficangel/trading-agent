-- 034_predict_access.sql
-- Per-user entitlement for the gated /predict section. Granted MANUALLY by an
-- admin (via /admin) — "доступ только через поддержку". Independent of the
-- trading subscription (user_subscriptions): /predict is a separate gated
-- section, not autotrading. Default 0 = no access.
ALTER TABLE registrations ADD COLUMN predict_access INTEGER NOT NULL DEFAULT 0;

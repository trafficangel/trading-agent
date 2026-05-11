-- Pending limit orders flow.
--
-- Before this migration, OPEN decisions with entry_type='limit' were marked
-- status='active' immediately and counted as real trades from creation,
-- even though semantically a limit order is PENDING until price actually
-- touches the entry level. With this change:
--
--   status='pending'    — limit placed, not filled yet, NOT a real trade
--   status='active'     — actually filled (market entry OR limit fill)
--   status='closed'     — TP/SL/CLOSE hit
--   status='cancelled'  — limit expired without fill
--
-- New columns:
--   pending_until — wall-clock cutoff (ms). After this, an unfilled limit
--                   becomes 'cancelled'. Null for market entries.
--   filled_at     — when the limit actually filled (price touched entry).
--                   Null for unfilled limits and market entries (those
--                   are filled at created_at by definition).

ALTER TABLE decisions ADD COLUMN pending_until INTEGER;
ALTER TABLE decisions ADD COLUMN filled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_decisions_pending
  ON decisions(status, pending_until)
  WHERE status = 'pending';

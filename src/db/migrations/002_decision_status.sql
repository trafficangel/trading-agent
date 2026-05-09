-- Track decision lifecycle: SKIP/CLOSE/MODIFY are 'final', OPEN starts 'active'
-- and becomes 'closed' once a CLOSE decision references it.
ALTER TABLE decisions ADD COLUMN status TEXT NOT NULL DEFAULT 'final';
ALTER TABLE decisions ADD COLUMN parent_decision_id INTEGER REFERENCES decisions(id);
ALTER TABLE decisions ADD COLUMN closed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_decisions_status_symbol
  ON decisions(status, symbol);
CREATE INDEX IF NOT EXISTS idx_decisions_parent
  ON decisions(parent_decision_id);

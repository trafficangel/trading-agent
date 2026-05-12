-- Runtime-tunable parameters that can change WITHOUT a deploy.
--
-- Initially built for self-review auto-tuning (see src/jobs/self-review.ts):
-- the scalp confidence floor adjusts itself by ±0.05 every 12h based on
-- recent sizing-floor SKIPs and scalp loss rate. Storing in DB rather
-- than environment variables means the value persists across restarts
-- and is visible in audit (every change writes a `self_review_actions` row).
--
-- KEY conventions:
--   `scalp.confidence_floor` — number in [0.40, 0.55], step 0.05
--
-- Read pattern: getRuntimeConfig(key) returns parsed number/string or
-- null if not set. Callers fall back to a hardcoded default when null.
-- This way removing a row is safe — code goes back to compiled-in defaults.

CREATE TABLE IF NOT EXISTS runtime_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  reason     TEXT
);

-- Audit trail of every auto-tune action taken by self-review. Useful for
-- "why did the bot raise the floor at 03:00?" investigations and for the
-- next self-review which checks its own past adjustments.
CREATE TABLE IF NOT EXISTS self_review_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  review_id  INTEGER NOT NULL,  -- the self_reviews row that produced this action
  param_key  TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT NOT NULL,
  reason     TEXT NOT NULL
);

-- Master log of every self-review run. The report text goes here so we
-- can read history. Next review can also reference previous suggestions
-- to avoid repeating itself.
CREATE TABLE IF NOT EXISTS self_reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  window_start    INTEGER NOT NULL,
  window_end      INTEGER NOT NULL,
  total_decisions INTEGER NOT NULL,
  open_count      INTEGER NOT NULL,
  skip_count      INTEGER NOT NULL,
  close_count     INTEGER NOT NULL,
  modify_count    INTEGER NOT NULL,
  llm_input_tokens INTEGER,
  llm_output_tokens INTEGER,
  report_md       TEXT NOT NULL,  -- full markdown report posted to Logs
  llm_raw         TEXT             -- raw LLM response for audit
);

CREATE INDEX IF NOT EXISTS idx_self_reviews_created
  ON self_reviews(created_at DESC);

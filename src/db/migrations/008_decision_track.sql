-- A/B tracking column.
--
-- We're running two independent decision tracks in parallel for comparison:
--   'llm'    = the existing 15-min cron + Claude decide + critique flow
--   'signal' = rule-based pure-LuxAlgo trader (no LLM), triggered by webhook
--
-- Both write into the same `decisions` table so SQL can do apples-to-apples
-- comparison (win rate, avg R, PnL). Existing rows default to 'llm' for
-- backwards compatibility — they ARE LLM decisions, just from before the split.
--
-- Position-occupancy checks (findActiveOrPendingPosition) take a track param
-- so the two tracks don't block each other. In shadow mode this is harmless;
-- in real trading it'd need account-mode handling (hedge or sub-accounts).

ALTER TABLE decisions ADD COLUMN track TEXT NOT NULL DEFAULT 'llm';

CREATE INDEX IF NOT EXISTS idx_decisions_track_status
  ON decisions(track, status);

CREATE INDEX IF NOT EXISTS idx_decisions_track_symbol_status
  ON decisions(track, symbol, status);

-- 036_funding_flip.sql
-- State + forward-PnL log for the funding-flip TEST runner (jobs/funding-flip-runner.ts).
-- The one kill-battery + placebo-verified HL edge, launched in HL TESTNET to accumulate
-- live out-of-sample evidence (15–20 net-positive → live, per CLAUDE.md lifecycle).
-- Open positions = one row per coin in funding_flip_pos; closed trades append to _log.

CREATE TABLE IF NOT EXISTS funding_flip_pos (
  coin             TEXT    PRIMARY KEY,        -- one open position per deployed coin
  side             TEXT    NOT NULL,           -- 'long' | 'short'
  entry_px         REAL    NOT NULL,
  qty              REAL    NOT NULL,
  funding_at_entry REAL,
  signal_hr        INTEGER NOT NULL,           -- the funding hour-bucket the flip fired on (dedup guard)
  opened_at        INTEGER NOT NULL            -- ms; time-stop measured from here (24h)
);

CREATE TABLE IF NOT EXISTS funding_flip_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coin         TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  entry_px     REAL    NOT NULL,
  qty          REAL    NOT NULL,
  signal_hr    INTEGER,                         -- closed funding hour-bucket the flip fired on
  opened_at    INTEGER NOT NULL,
  reason       TEXT,                            -- ENTRY type, set ONCE at insert, NEVER overwritten:
                                                --   'open' = a real flip entry (the dedup high-water mark reads MAX(signal_hr) WHERE reason='open')
                                                --   'adopted' = an orphan exchange position reconciled in (signal_hr NULL, excluded from dedup)
  exit_px      REAL,
  closed_at    INTEGER,                         -- NULL = active position; set on close (active = closed_at IS NULL)
  pnl_pct      REAL,                            -- net of HL taker RT (0.07%); NULL if exit price unknown
  close_reason TEXT,                            -- 'time-stop' | 'reconciled-flat' | 'superseded' (set at close; does NOT touch `reason`)
  mode         TEXT    NOT NULL                 -- 'testnet' | 'live'
);
CREATE INDEX IF NOT EXISTS idx_ff_log_coin ON funding_flip_log(coin, opened_at);

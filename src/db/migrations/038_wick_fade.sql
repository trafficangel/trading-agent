-- 038_wick_fade.sql
-- State + forward-PnL log for the DEEP-WICK ANOMALY-FADE runner (jobs/wick-fade-runner.ts) — the
-- SECOND validated edge (see [[hl-micro-layer]]): rest a post-only deep limit X% from mid; a flash /
-- over-extension fills it (maker, no speed needed); fade back to the pre-wick mid. Broad on retail
-- alts (DOGE/XRP/ICP/NEAR/TON/ATOM/CRV/ENA/TIA/kPEPE), cross-window + null + controls-fail validated.
--
-- Resting orders are NOT tracked in the DB — the EXCHANGE openOrders is the source of truth for them.
-- The exit target is DERIVED from the fill price (bid = mid₀·(1−X) ⇒ target mid₀ = entry/(1−X)); we
-- store the coin's X at entry so a later config change can't move an open position's target/stop.

CREATE TABLE IF NOT EXISTS wick_fade_pos (
  coin       TEXT    PRIMARY KEY,        -- one managed position per coin
  side       TEXT    NOT NULL,           -- 'long' (a bid filled) | 'short' (an ask filled)
  entry_px   REAL    NOT NULL,           -- the REAL fill price from the exchange
  qty        REAL    NOT NULL,
  x          REAL    NOT NULL,           -- depth at entry: target = entry/(1∓x), stop = entry·(1∓STOP)
  opened_at  INTEGER NOT NULL,           -- ms; time-stop measured from here
  reason     TEXT    NOT NULL            -- 'fill' (a real wick) | 'adopted' (orphan reconciled in)
);

CREATE TABLE IF NOT EXISTS wick_fade_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coin         TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  entry_px     REAL    NOT NULL,
  qty          REAL    NOT NULL,
  x            REAL,
  opened_at    INTEGER NOT NULL,
  reason       TEXT,                      -- entry type (immutable): 'fill' | 'adopted'
  exit_px      REAL,
  closed_at    INTEGER,                   -- NULL = active (active = closed_at IS NULL)
  pnl_pct      REAL,                      -- net of est. RT cost (maker entry + taker exit ≈ 0.05%)
  close_reason TEXT,                      -- 'target' | 'time-stop' | 'catastrophe' | 'reconciled-flat'
  mode         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wick_log_coin ON wick_fade_log(coin, opened_at);

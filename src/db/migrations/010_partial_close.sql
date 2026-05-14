-- Multi-TP support: partial close tracking.
--
-- Track B v2 introduces the 50/50 split:
--   TP1 (+1R) → close 50% of the position, move SL to entry (BE)
--   TP2 (+2R) → close remaining 50%
-- An SL touch after TP1 gives 50%×+1R + 50%×0R = +0.5R (still profit).
-- An SL touch before TP1 gives the usual -1R.
--
-- New columns on `decisions`:
--   partial_closed_pct  — how much of the position has been closed (0, 50, 100)
--   partial_close_price — fill price of the partial close (= TP1 when set)
--   partial_closed_at   — unix ms when the partial close happened
--   tp1_price           — TP1 level (snapshot at open time)
--
-- The legacy `tp_json` column stays — it holds [tp1, tp2] now (array). For
-- backwards compat with single-TP rows (track='llm' historical), tp_json
-- with one element is still a valid one-TP position.
--
-- Final-close PnL is the weighted sum:
--   if partial_closed_pct = 50 and final at TP2:  0.5×(TP1 R) + 0.5×(TP2 R)
--   if partial_closed_pct = 50 and final at SL (BE): 0.5×(+1R) + 0.5×(0R) = +0.5R
--   if partial_closed_pct = 0  and final at SL: -1R (unchanged)
--   if partial_closed_pct = 0  and final at TP1 (single-TP legacy): +1R or wherever tp[0] is

ALTER TABLE decisions ADD COLUMN partial_closed_pct REAL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN partial_close_price REAL;
ALTER TABLE decisions ADD COLUMN partial_closed_at INTEGER;
ALTER TABLE decisions ADD COLUMN tp1_price REAL;

-- Force-close (early exit) audit columns. Reason values:
--   'counter_structural' — opposing CHoCH/BOS on same-or-higher TF arrived
--   'counter_signal'     — opposing bullish_plus/bearish_plus on higher TF
--   'time_guard'         — position older than max age without reaching TP1
ALTER TABLE decisions ADD COLUMN force_close_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_partial_active
  ON decisions(status, partial_closed_pct)
  WHERE status = 'active';

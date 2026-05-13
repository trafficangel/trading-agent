-- Preserve the ORIGINAL SL at trade-open time, even after BE move overwrites
-- the `sl` column. Without this, the R-multiple calculation after a BE
-- move + TP hit divides by zero (sl == entry → slDist == 0).
--
-- Bug observed: S#0195 closed by TP for +2.03% but pnl_r recorded as 0.0
-- because tpsl-monitor used current sl (which had been moved to entry).
--
-- Going forward:
--   - INSERT a new decision → original_sl = sl (set in repo)
--   - BE move → updates `sl`, leaves `original_sl` untouched
--   - close-with-stats → calcPnl uses ORIGINAL_SL for R-multiple math
--
-- Backfill existing rows: original_sl := sl (best guess; for any rows
-- that had a BE move already, this is wrong, but they're audit-only).
-- Specifically retroactively fixed in a follow-up UPDATE after migration.

ALTER TABLE decisions ADD COLUMN original_sl REAL;

-- Backfill with current sl. For S#0195 we'll set the true original by
-- hand below (BE move had overwritten it).
UPDATE decisions SET original_sl = sl WHERE original_sl IS NULL;

-- S#0195: real original SL was 2.2668 (1.02% above entry 2.244).
-- BE move overwrote it to 2.244, then TP hit → R-calc divided by zero.
UPDATE decisions
   SET original_sl = 2.2668,
       pnl_r = 2.0   -- TP at 2.1984 was 2× original SL distance → +2R
 WHERE id = 195 AND symbol = 'TONUSDT' AND sl = 2.244;

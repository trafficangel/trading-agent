-- 037_bybit_micro.sql
-- BYBIT cross-venue microstructure history — the second leg for the OI-gate (A)
-- and HL↔Bybit funding-divergence (B) research, the two angles the 2026
-- microstructure literature converges on (OI + funding + liquidations).
--
-- WHY a second table (not hl_micro): HL exposes OI/orderbook only as live
-- snapshots (NO REST history) so hl_micro.oi is forward-collected and only ~11d
-- deep — useless for a backtest. Bybit, by contrast, serves OI history (~365d
-- @ 1h) and funding history (~700d @ 8h) over REST, both covering the
-- funding-flip validation window. Backfilled ONCE by scripts/backfill-bybit.ts.
--
-- Grid: hourly `ts` (unix ms, hour-aligned). OI fills every hour; funding only
-- at Bybit's 8h settlement stamps (00:00/08:00/16:00 UTC) — null on other hours,
-- forward-filled (the prevailing rate is constant within the window) at query
-- time. Causal by construction: every row is a settled historical snapshot.
CREATE TABLE IF NOT EXISTS bybit_micro (
  coin     TEXT    NOT NULL,
  ts       INTEGER NOT NULL,   -- hour bucket (OI) or 8h funding stamp, unix ms
  oi       REAL,               -- open interest, base contracts (1h snapshot)
  funding  REAL,               -- 8h funding rate at the stamp hour (null elsewhere)
  PRIMARY KEY (coin, ts)
);
CREATE INDEX IF NOT EXISTS idx_bybit_micro_coin_ts ON bybit_micro(coin, ts DESC);

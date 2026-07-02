-- 039_hl_candles.sql
-- Forward-collected NATIVE Hyperliquid 5m candles (jobs/hl-candle-collector.ts). HL's candleSnapshot
-- serves only the most recent ~5000 bars (~17 days of 5m) and older ranges return EMPTY — so the venue
-- we actually trade has no deep history for backtests. We archive our own: after a month+ of collection,
-- wick-fade coins can be RE-validated on native HL data (closing the Bybit-proxy gap) instead of trusting
-- cross-venue transfer. Includes majors as CONTROLS coins for the artifact check.

CREATE TABLE IF NOT EXISTS hl_candles (
  coin TEXT    NOT NULL,
  t    INTEGER NOT NULL,   -- bar open time, ms (5m grid)
  o    REAL    NOT NULL,
  h    REAL    NOT NULL,
  l    REAL    NOT NULL,
  c    REAL    NOT NULL,
  v    REAL    NOT NULL,   -- base-coin volume
  PRIMARY KEY (coin, t)
) WITHOUT ROWID;

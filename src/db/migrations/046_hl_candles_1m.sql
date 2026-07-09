-- 046_hl_candles_1m.sql
-- Native Hyperliquid 1m candles for the Momentum Follow signal layer.
-- The 5m hl_candles archive remains the slower volatility/context archive used
-- by wick-fade and legacy analytics. This table is separate so 1m bars never
-- collide with the 5m primary key grid.

CREATE TABLE IF NOT EXISTS hl_candles_1m (
  coin   TEXT    NOT NULL,
  t      INTEGER NOT NULL, -- bar open time, ms (1m grid)
  o      REAL    NOT NULL,
  h      REAL    NOT NULL,
  l      REAL    NOT NULL,
  c      REAL    NOT NULL,
  v      REAL    NOT NULL DEFAULT 0, -- base-coin volume; 0 when built from allMids
  source TEXT    NOT NULL DEFAULT 'rest',
  PRIMARY KEY (coin, t)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_hl_candles_1m_t
  ON hl_candles_1m(t);

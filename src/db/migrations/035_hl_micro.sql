-- 035_hl_micro.sql
-- Hyperliquid MICROSTRUCTURE data layer. Forward-collected 24/7 by
-- jobs/hl-collector.ts. HL exposes OI / orderbook / trade-tape only as live
-- snapshots/streams (NO REST history) — so we accumulate them going forward;
-- funding alone is backfillable. One row per (coin, minute bucket, unix ms).
--   - trade-flow cols (CVD) come from the WS `trades` stream (aggressor side);
--   - snapshot cols (oi/funding/mark/book) from per-minute info polls.
-- The two writers UPSERT the same row, so order doesn't matter. Aggregate to
-- 15m/30m at query time for backtests. This is the data the "needs-data" 15/30m
-- ideas (CVD-divergence, OI-quadrant, funding-extreme, book-imbalance) require.
CREATE TABLE IF NOT EXISTS hl_micro (
  coin        TEXT    NOT NULL,
  ts          INTEGER NOT NULL,            -- minute bucket start, unix ms
  -- ── trade flow (WS trades, aggressor-classified by `side`) ──
  buy_vol     REAL    NOT NULL DEFAULT 0,  -- aggressive buy base volume (side 'B')
  sell_vol    REAL    NOT NULL DEFAULT 0,  -- aggressive sell base volume (side 'A')
  cvd_delta   REAL    NOT NULL DEFAULT 0,  -- buy_vol - sell_vol for the minute
  trades      INTEGER NOT NULL DEFAULT 0,
  liq_vol     REAL    NOT NULL DEFAULT 0,  -- liquidation base volume (best-effort, 0 for now)
  -- ── snapshot (info poll at minute close) ──
  oi          REAL,                        -- open interest (base units)
  funding     REAL,                        -- current hourly funding rate
  mark        REAL,
  oracle      REAL,
  premium     REAL,                        -- mark/oracle premium
  mid         REAL,
  -- ── top-of-book (l2Book poll, sum of top-5 levels each side) ──
  book_bid    REAL,
  book_ask    REAL,
  book_imb    REAL,                        -- (bid-ask)/(bid+ask) in [-1,1]
  PRIMARY KEY (coin, ts)
);
CREATE INDEX IF NOT EXISTS idx_hl_micro_coin_ts ON hl_micro(coin, ts DESC);

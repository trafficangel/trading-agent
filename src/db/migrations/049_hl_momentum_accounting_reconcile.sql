-- Exact exchange accounting for honest live statistics. pnl_pct remains the
-- public normalized metric; the USD components preserve the original ledger.
ALTER TABLE hl_momentum_live_log ADD COLUMN entry_notional_usd REAL;
ALTER TABLE hl_momentum_live_log ADD COLUMN exit_notional_usd REAL;
ALTER TABLE hl_momentum_live_log ADD COLUMN gross_pnl_usd REAL;
ALTER TABLE hl_momentum_live_log ADD COLUMN fee_usd REAL;
ALTER TABLE hl_momentum_live_log ADD COLUMN funding_usd REAL;
ALTER TABLE hl_momentum_live_log ADD COLUMN net_pnl_usd REAL;
ALTER TABLE hl_momentum_live_log ADD COLUMN accounting_fill_count INTEGER;
ALTER TABLE hl_momentum_live_log ADD COLUMN pnl_source TEXT;

-- Persist intent before a market order. A restart after an accepted/fill
-- response can then adopt the exchange position without guessing ownership.
CREATE TABLE hl_momentum_order_intent (
  id                     TEXT PRIMARY KEY,
  strategy               TEXT    NOT NULL,
  coin                   TEXT    NOT NULL,
  side                   TEXT    NOT NULL,
  action                 TEXT    NOT NULL,
  status                 TEXT    NOT NULL,
  requested_qty          REAL    NOT NULL,
  requested_notional_usd REAL    NOT NULL,
  signal                 TEXT    NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  exchange_ref           TEXT,
  error                  TEXT
);

CREATE INDEX idx_hl_mom_intent_status_created
  ON hl_momentum_order_intent(status, created_at DESC);
CREATE INDEX idx_hl_mom_intent_coin_created
  ON hl_momentum_order_intent(coin, created_at DESC);

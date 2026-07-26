ALTER TABLE lighter_lux_signals ADD COLUMN source_price REAL;
ALTER TABLE lighter_lux_signals ADD COLUMN action TEXT NOT NULL DEFAULT 'entry'
  CHECK(action IN ('entry', 'exit'));

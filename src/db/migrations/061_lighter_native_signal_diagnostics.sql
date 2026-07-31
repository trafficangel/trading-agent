ALTER TABLE lighter_lux_signals
  ADD COLUMN native_er60 REAL
  CHECK(native_er60 IS NULL OR (native_er60 >= 0 AND native_er60 <= 1));

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  direction TEXT,
  price REAL,
  bar_time INTEGER,
  raw_payload TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON signals(symbol, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_received ON signals(received_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  confluence_score REAL NOT NULL,
  signal_ids TEXT NOT NULL,
  screenshot_path TEXT,
  llm_input_tokens INTEGER,
  llm_output_tokens INTEGER,
  decision TEXT NOT NULL,
  side TEXT,
  entry REAL, sl REAL, tp_json TEXT, size_pct REAL,
  confidence REAL,
  reasoning_short TEXT,
  reasoning_full TEXT,
  raw_response TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER REFERENCES decisions(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  sl_order_id TEXT,
  tp_order_ids TEXT,
  status TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  pnl_usd REAL,
  pnl_r REAL,
  exit_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER REFERENCES positions(id),
  exchange_order_id TEXT NOT NULL,
  type TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL,
  status TEXT NOT NULL,
  filled_at INTEGER,
  raw_response TEXT
);

CREATE TABLE IF NOT EXISTS telegram_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER REFERENCES positions(id),
  channel TEXT NOT NULL,
  root_message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

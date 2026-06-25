#!/usr/bin/env python3
"""
Import the in-region CVD backfill (hl_cvd.sqlite, produced by backfill_hl_cvd_ec2.py on
CloudShell/EC2) into the prod hl_micro table. Run on the VPS, repo root, as trader:

  sudo -u trader python3 scripts/import_cvd_backfill.py /path/to/hl_cvd.sqlite

UPSERT on (coin,ts): fills the buy_vol/sell_vol/cvd_delta/trades columns, leaving any
other hl_micro columns (oi/funding/book/...) on the same minute untouched. Idempotent.
"""
import sys, sqlite3, os

SRC = sys.argv[1] if len(sys.argv) > 1 else "hl_cvd.sqlite"
DB = os.environ.get("HL_DB", "data/trading.sqlite")
if not os.path.exists(SRC):
    sys.exit(f"source not found: {SRC}")

db = sqlite3.connect(DB, timeout=60)
db.execute("PRAGMA busy_timeout=30000")
before = db.execute("SELECT COUNT(*) FROM hl_micro WHERE cvd_delta IS NOT NULL").fetchone()[0]
n_src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True).execute("SELECT COUNT(*) FROM hl_cvd").fetchone()[0]
rng = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True).execute(
    "SELECT MIN(date(ts/1000,'unixepoch')), MAX(date(ts/1000,'unixepoch')), COUNT(DISTINCT date(ts/1000,'unixepoch')) FROM hl_cvd").fetchone()
print(f"source {SRC}: {n_src} rows, {rng[2]} days {rng[0]}..{rng[1]} → importing into {DB} (had {before} CVD rows)")

db.execute(f"ATTACH '{SRC}' AS src")
with db:
    db.execute(
        "INSERT INTO hl_micro (coin,ts,buy_vol,sell_vol,cvd_delta,trades) "
        "SELECT coin,ts,buy_vol,sell_vol,cvd_delta,trades FROM src.hl_cvd WHERE true "
        "ON CONFLICT(coin,ts) DO UPDATE SET buy_vol=excluded.buy_vol,sell_vol=excluded.sell_vol,"
        "cvd_delta=excluded.cvd_delta,trades=excluded.trades")
db.execute("DETACH src")
after = db.execute("SELECT COUNT(*) FROM hl_micro WHERE cvd_delta IS NOT NULL").fetchone()[0]
cov = db.execute(
    "SELECT coin, COUNT(DISTINCT date(ts/1000,'unixepoch')) FROM hl_micro WHERE trades>0 GROUP BY coin ORDER BY coin").fetchall()
print(f"done. hl_micro CVD rows {before} → {after} (+{after-before}). CVD-days now: " + " ".join(f"{c}:{d}" for c, d in cov))
db.close()

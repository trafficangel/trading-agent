#!/usr/bin/env python3
"""
Backfill Hyperliquid PERP trades from CoinAPI Flat Files (S3) into hl_micro as CVD.

CoinAPI Flat Files layout (discovered): HOURLY partitions
  T-TRADES/D-{YYYYMMDDHH}/E-HYPERLIQUID/IDDI-..+SC-HYPERLIQUID_PERP_{COIN}_USDC+S-..csv.gz
CSV: ';'-delimited, cols time_exchange;time_coinapi;guid;price;base_amount;taker_side;...
(use E-HYPERLIQUID, NOT E-HYPERLIQUIDL4 — same trades, L4 is wider/larger.)

Credit-based billing → COST-AWARE: defaults to a 1-coin 1-day TEST and prints MB
downloaded so we extrapolate $ before scaling. Trades → per-minute buy/sell vol
→ cvd_delta, UPSERT into the SAME hl_micro the live collector writes (full-day
Flat Files data is authoritative over the collector's partial live capture).

Run on the VPS, repo root, as trader:
  python3 scripts/backfill_hl_coinapi.py [COINS] [START_YYYYMMDD] [END_YYYYMMDD]
  test:  python3 scripts/backfill_hl_coinapi.py BTC 20260614 20260614
  bulk:  python3 scripts/backfill_hl_coinapi.py BTC,ETH,SOL,LINK 20260101 20260615
"""
import sys, gzip, csv, io, sqlite3, datetime as dt

ENDPOINT = "https://s3.flatfiles.coinapi.io"
BUCKET, SECRET, EXCH, DB = "coinapi", "coinapi", "HYPERLIQUID", "data/trading.sqlite"

def load_key():
    for line in open(".env", encoding="utf-8", errors="ignore"):
        if line.startswith("COINAPI_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("COINAPI_KEY not in .env")

def daterange(a, b):
    d = dt.datetime.strptime(a, "%Y%m%d").date(); end = dt.datetime.strptime(b, "%Y%m%d").date()
    while d <= end:
        yield d.strftime("%Y%m%d"); d += dt.timedelta(days=1)

def parse_into(text, buckets):
    sample = text[:2000]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    rdr = csv.DictReader(io.StringIO(text), delimiter=delim)
    cols = {c.lower(): c for c in (rdr.fieldnames or [])}
    def find(*names):
        for n in names:
            for lc, orig in cols.items():
                if n in lc: return orig
        return None
    c_t, c_s, c_side = find("time_exchange", "time"), find("base_amount", "size", "amount"), find("taker_side", "side")
    if not (c_t and c_s and c_side):
        sys.exit(f"column map failed; header={rdr.fieldnames}")
    n = 0
    for row in rdr:
        try:
            ms = int(dt.datetime.fromisoformat(row[c_t].replace("Z", "+00:00")).timestamp() * 1000)
            sz = float(row[c_s])
        except Exception:
            continue
        mt = (ms // 60000) * 60000
        b = buckets.setdefault(mt, [0.0, 0.0, 0])
        if (row[c_side] or "").upper().startswith("B"): b[0] += sz
        else: b[1] += sz
        b[2] += 1; n += 1
    return n

def main():
    import boto3
    from botocore.config import Config
    coins = (sys.argv[1] if len(sys.argv) > 1 else "BTC").split(",")
    start = sys.argv[2] if len(sys.argv) > 2 else "20260614"
    end = sys.argv[3] if len(sys.argv) > 3 else start
    s3 = boto3.client("s3", endpoint_url=ENDPOINT, aws_access_key_id=load_key(),
                      aws_secret_access_key=SECRET, region_name="us-east-1",
                      config=Config(signature_version="s3v4", retries={"max_attempts": 4}))
    db = sqlite3.connect(DB, timeout=20); db.execute("PRAGMA busy_timeout=15000")
    upsert = ("INSERT INTO hl_micro (coin, ts, buy_vol, sell_vol, cvd_delta, trades) VALUES (?,?,?,?,?,?) "
              "ON CONFLICT(coin, ts) DO UPDATE SET buy_vol=excluded.buy_vol, sell_vol=excluded.sell_vol, "
              "cvd_delta=excluded.cvd_delta, trades=excluded.trades")
    grand_bytes = 0
    for date in daterange(start, end):
        per = {c: {} for c in coins}; mb = {c: 0 for c in coins}; tr = {c: 0 for c in coins}; hrs = {c: 0 for c in coins}
        for h in range(24):
            objs = s3.list_objects_v2(Bucket=BUCKET, Prefix=f"T-TRADES/D-{date}{h:02d}/E-{EXCH}/").get("Contents", [])
            for coin in coins:
                sc = f"SC-{EXCH}_PERP_{coin}_USDC+"
                m = [o for o in objs if sc in o["Key"]]
                if not m: continue
                raw = s3.get_object(Bucket=BUCKET, Key=m[0]["Key"])["Body"].read()
                mb[coin] += len(raw); grand_bytes += len(raw); hrs[coin] += 1
                tr[coin] += parse_into(gzip.decompress(raw).decode("utf-8", "ignore"), per[coin])
        for coin in coins:
            rows = [(coin, mt, round(v[0], 6), round(v[1], 6), round(v[0] - v[1], 6), v[2]) for mt, v in per[coin].items()]
            if rows:
                with db: db.executemany(upsert, rows)
            print(f"  {coin} {date}: {mb[coin]/1e6:5.1f}MB gz, {tr[coin]:>7} trades -> {len(rows):>4} min, {hrs[coin]}/24h")
    db.close()
    gb = grand_bytes / 1e9
    print(f"\nTOTAL downloaded: {gb:.4f} GB. CoinAPI bills per-GB — check your portal balance drop to get $/GB,\n"
          f"then extrapolate: full 10-coin × ~20mo ≈ (per-coin-day MB × ~600 days × coins).")

if __name__ == "__main__":
    main()

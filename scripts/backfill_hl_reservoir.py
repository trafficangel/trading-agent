#!/usr/bin/env python3
"""
Backfill HL ORDER-FLOW from Reservoir (Hydromancer) free S3 archive into hl_micro:
  - CVD       <- fills/perp/all      (aggressor = crossed==True, side buy/sell)   [SLOW: 248MB/day all-perps]
  - liq_vol   <- fills/perp/liquidations   [small]
  - book_imb  <- orderbook/1m/perps/{coin} [small, per-coin]
Bucket: hydromancer-reservoir (ap-northeast-1, REQUESTER-PAYS). AWS creds from .env.

The VPS link caps at ~2MB/s to Tokyo S3, so the 80GB fills firehose is ~10h
regardless of parallelism — but L2+liq are ~1.5GB (~15min). MODES:
  all (default) | nofills (liq+book only, fast) | fillsonly (CVD only, slow/bg)
Aggregation is fully VECTORIZED in pyarrow (group_by in C++, releases the GIL so
the N worker threads actually parallelize the decode/filter). Main thread is the
sole SQLite writer.

Run on the VPS, repo root, as trader (-u for live log):
  python3 -u scripts/backfill_hl_reservoir.py 2025-07-28 2026-06-14 nofills
  python3 -u scripts/backfill_hl_reservoir.py 2025-07-28 2026-06-14 fillsonly
"""
import sys, io, os, sqlite3, tempfile, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed

COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "LTC", "LINK", "DOGE", "AVAX"]
COINSET = set(COINS)
BUCKET, REGION, DB = "hydromancer-reservoir", "ap-northeast-1", "data/trading.sqlite"
TMPDIR = "data/_tmp_reservoir"
MIN = 60_000
WORKERS = 3
MODE = "all"

_s3 = _pa = _pq = _pc = _coinarr = None

def creds():
    e = {}
    for l in open(".env", encoding="utf-8", errors="ignore"):
        if l.startswith(("AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=")):
            k, v = l.strip().split("=", 1); e[k] = v.strip().strip('"').strip("'")
    return e

def daterange(a, b):
    d = dt.date.fromisoformat(a); end = dt.date.fromisoformat(b)
    while d <= end:
        yield d.isoformat(); d += dt.timedelta(days=1)

def mb(ts_ms): return (int(ts_ms) // MIN) * MIN

def fetch(key):
    from botocore.exceptions import ClientError
    try:
        return _s3.get_object(Bucket=BUCKET, Key=key, RequestPayer="requester")["Body"].read()
    except ClientError as ex:
        if ex.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise

def process_day(date):
    pa, pq, pc = _pa, _pq, _pc
    frows = []; lrows = []; brows = []; dl = 0
    # ---- FILLS -> CVD (vectorized) ----
    if MODE != "nofills":
        raw = fetch(f"by_dex/hyperliquid/fills/perp/all/date={date}/fills.parquet")
        if raw is not None:
            dl += len(raw)
            tf = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False, dir=TMPDIR); tf.write(raw); tf.close(); del raw
            parts = []
            try:
                pf = pq.ParquetFile(tf.name)
                for batch in pf.iter_batches(columns=["coin", "side", "size", "timestamp", "crossed"], batch_size=400_000):
                    bt = pa.Table.from_batches([batch])
                    mask = pc.and_(pc.is_in(bt["coin"], value_set=_coinarr), pc.fill_null(bt["crossed"], False))
                    parts.append(bt.filter(mask))
            finally:
                os.remove(tf.name)
            if parts:
                t = pa.concat_tables(parts)
                us = pc.cast(t["timestamp"], pa.int64())
                minute = pc.multiply(pc.cast(pc.divide(pc.cast(us, pa.float64()), 60_000_000.0), pa.int64()), pa.scalar(60_000, pa.int64()))
                szf = pc.cast(t["size"], pa.float64()); isbuy = pc.equal(t["side"], "buy")
                t = t.append_column("minute", minute).append_column("buyv", pc.if_else(isbuy, szf, pa.scalar(0.0))).append_column("sellv", pc.if_else(isbuy, pa.scalar(0.0), szf))
                g = t.group_by(["coin", "minute"]).aggregate([("buyv", "sum"), ("sellv", "sum"), ("buyv", "count")]).to_pydict()
                co, mn, bs, ss, cn = g["coin"], g["minute"], g["buyv_sum"], g["sellv_sum"], g["buyv_count"]
                frows = [(co[i], mn[i], round(bs[i], 6), round(ss[i], 6), round(bs[i] - ss[i], 6), cn[i]) for i in range(len(co))]
    if MODE == "fillsonly":
        return date, frows, lrows, brows, dl

    # ---- LIQUIDATIONS ----
    lq = fetch(f"by_dex/hyperliquid/fills/perp/liquidations/date={date}/fills.parquet")
    if lq:
        dl += len(lq); t = pq.read_table(io.BytesIO(lq), columns=["coin", "size", "timestamp"]).to_pydict(); agg = {}
        for i in range(len(t["coin"])):
            if t["coin"][i] not in COINSET: continue
            k = (t["coin"][i], mb(t["timestamp"][i].timestamp() * 1000)); agg[k] = agg.get(k, 0.0) + float(t["size"][i])
        lrows = [(c, mt, round(v, 6)) for (c, mt), v in agg.items()]

    # ---- L2 BOOK imbalance ----
    for coin in COINS:
        ob = fetch(f"by_dex/hyperliquid/orderbook/1m/perps/date={date}/{coin}.parquet")
        if not ob: continue
        dl += len(ob); t = pq.read_table(io.BytesIO(ob), columns=["block_time_ms", "bids", "asks"]).to_pydict(); per = {}
        for i in range(len(t["block_time_ms"])):
            bids = t["bids"][i] or []; asks = t["asks"][i] or []
            bs = sum(float(x["sz"]) for x in bids[:5]); asm = sum(float(x["sz"]) for x in asks[:5])
            per[mb(t["block_time_ms"][i])] = (bs, asm)
        for mt, (bs, asm) in per.items():
            brows.append((coin, mt, round(bs, 6), round(asm, 6), round((bs - asm) / (bs + asm), 4) if (bs + asm) > 0 else None))
    return date, frows, lrows, brows, dl

def main():
    global _s3, _pa, _pq, _pc, _coinarr, MODE
    import boto3, pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
    from botocore.config import Config
    _pa, _pq, _pc = pa, pq, pc
    e = creds()
    _s3 = boto3.client("s3", region_name=REGION, aws_access_key_id=e["AWS_ACCESS_KEY_ID"], aws_secret_access_key=e["AWS_SECRET_ACCESS_KEY"],
                       config=Config(max_pool_connections=WORKERS * 3, retries={"max_attempts": 4}))
    _coinarr = pa.array(COINS, pa.string())
    os.makedirs(TMPDIR, exist_ok=True)
    start = sys.argv[1] if len(sys.argv) > 1 else "2026-06-13"
    end = sys.argv[2] if len(sys.argv) > 2 else "2026-06-14"
    if len(sys.argv) > 3: MODE = sys.argv[3]
    dates = list(daterange(start, end))
    db = sqlite3.connect(DB, timeout=60); db.execute("PRAGMA busy_timeout=30000")
    UP_FLOW = ("INSERT INTO hl_micro (coin,ts,buy_vol,sell_vol,cvd_delta,trades) VALUES (?,?,?,?,?,?) "
               "ON CONFLICT(coin,ts) DO UPDATE SET buy_vol=excluded.buy_vol,sell_vol=excluded.sell_vol,cvd_delta=excluded.cvd_delta,trades=excluded.trades")
    UP_LIQ = "INSERT INTO hl_micro (coin,ts,liq_vol) VALUES (?,?,?) ON CONFLICT(coin,ts) DO UPDATE SET liq_vol=excluded.liq_vol"
    UP_BOOK = ("INSERT INTO hl_micro (coin,ts,book_bid,book_ask,book_imb) VALUES (?,?,?,?,?) "
               "ON CONFLICT(coin,ts) DO UPDATE SET book_bid=excluded.book_bid,book_ask=excluded.book_ask,book_imb=excluded.book_imb")
    grand = 0; done = 0; t0 = dt.datetime.now()
    print(f"MODE={MODE} days={len(dates)} workers={WORKERS}", flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(process_day, d): d for d in dates}
        for fut in as_completed(futs):
            date, frows, lrows, brows, dl = fut.result()
            grand += dl; done += 1
            if frows:
                with db: db.executemany(UP_FLOW, frows)
            if lrows:
                with db: db.executemany(UP_LIQ, lrows)
            if brows:
                with db: db.executemany(UP_BOOK, brows)
            el = (dt.datetime.now() - t0).total_seconds()
            if done % 10 == 0 or done == len(dates):
                print(f"[{done}/{len(dates)}] {date}: CVD {len(frows)} liq {len(lrows)} book {len(brows)} | {grand/1e9:.2f}GB {el:.0f}s", flush=True)
    db.close()
    print(f"\nDONE {done} days, {grand/1e9:.2f} GB in {(dt.datetime.now()-t0).total_seconds()/60:.1f} min", flush=True)

if __name__ == "__main__":
    main()

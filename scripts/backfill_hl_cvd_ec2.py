#!/usr/bin/env python3
"""
IN-REGION CVD backfill — run this on AWS CloudShell or a tiny EC2 in ap-northeast-1
(same region as the Reservoir/Hydromancer archive). The VPS↔Tokyo link caps at ~2MB/s
so the 248MB/day fills firehose is undownloadable there; FROM INSIDE the region S3 reads
are fast + same-region egress is FREE, so months of CVD aggregate in ~minutes for cents.

Self-contained (NO repo deps). Reads ONLY fills/perp/all → aggregates per-minute CVD
(buy/sell vol, delta, trade count) and writes a SMALL portable sqlite `hl_cvd.sqlite`
(table hl_cvd(coin,ts,buy_vol,sell_vol,cvd_delta,trades)). That file (~tens of MB for a
year) is what you ship back to the VPS; import it into hl_micro with import_cvd_backfill.py.

AWS creds from env (CloudShell injects them automatically if you're logged in; on EC2 use
an instance role OR export the Reservoir IAM keys). REQUESTER-PAYS bucket.

  pip install --quiet boto3 pyarrow
  HL_WORKERS=2 python3 backfill_hl_cvd_ec2.py 2025-06-25 2026-06-24      # CloudShell (2GB RAM → 2 workers)
  HL_WORKERS=6 python3 backfill_hl_cvd_ec2.py 2025-06-25 2026-06-24      # bigger EC2 (more RAM → more workers)

Idempotent + resumable: re-running UPSERTs, and it SKIPS days already present in hl_cvd
(so a timed-out CloudShell session just continues where it stopped).
"""
import sys, os, sqlite3, tempfile, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed

COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "LTC", "LINK", "DOGE", "AVAX"]
BUCKET, REGION = "hydromancer-reservoir", "ap-northeast-1"
OUT = os.environ.get("HL_OUT", "hl_cvd.sqlite")
WORKERS = int(os.environ.get("HL_WORKERS", "2"))
MIN = 60_000
TMPDIR = os.environ.get("HL_TMP", "/tmp/_hlcvd")

_s3 = _pa = _pq = _pc = _coinarr = None


def daterange(a, b):
    d = dt.date.fromisoformat(a); end = dt.date.fromisoformat(b)
    while d <= end:
        yield d.isoformat(); d += dt.timedelta(days=1)


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
    raw = fetch(f"by_dex/hyperliquid/fills/perp/all/date={date}/fills.parquet")
    if raw is None:
        return date, [], 0
    dl = len(raw)
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
    if not parts:
        return date, [], dl
    t = pa.concat_tables(parts)
    us = pc.cast(t["timestamp"], pa.int64())
    minute = pc.multiply(pc.cast(pc.divide(pc.cast(us, pa.float64()), 60_000_000.0), pa.int64()), pa.scalar(60_000, pa.int64()))
    szf = pc.cast(t["size"], pa.float64()); isbuy = pc.equal(t["side"], "buy")
    t = (t.append_column("minute", minute)
          .append_column("buyv", pc.if_else(isbuy, szf, pa.scalar(0.0)))
          .append_column("sellv", pc.if_else(isbuy, pa.scalar(0.0), szf)))
    g = t.group_by(["coin", "minute"]).aggregate([("buyv", "sum"), ("sellv", "sum"), ("buyv", "count")]).to_pydict()
    co, mn, bs, ss, cn = g["coin"], g["minute"], g["buyv_sum"], g["sellv_sum"], g["buyv_count"]
    rows = [(co[i], mn[i], round(bs[i], 6), round(ss[i], 6), round(bs[i] - ss[i], 6), cn[i]) for i in range(len(co))]
    return date, rows, dl


def main():
    global _s3, _pa, _pq, _pc, _coinarr
    import boto3, pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
    from botocore.config import Config
    _pa, _pq, _pc = pa, pq, pc
    _s3 = boto3.client("s3", region_name=REGION, config=Config(max_pool_connections=WORKERS * 3, retries={"max_attempts": 4}))
    _coinarr = pa.array(COINS, pa.string())
    os.makedirs(TMPDIR, exist_ok=True)
    start = sys.argv[1] if len(sys.argv) > 1 else "2025-12-25"
    end = sys.argv[2] if len(sys.argv) > 2 else "2026-06-24"

    db = sqlite3.connect(OUT, timeout=60)
    db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA busy_timeout=30000")
    db.execute("CREATE TABLE IF NOT EXISTS hl_cvd (coin TEXT, ts INTEGER, buy_vol REAL, sell_vol REAL, cvd_delta REAL, trades INTEGER, PRIMARY KEY(coin, ts))")
    db.commit()
    UP = ("INSERT INTO hl_cvd (coin,ts,buy_vol,sell_vol,cvd_delta,trades) VALUES (?,?,?,?,?,?) "
          "ON CONFLICT(coin,ts) DO UPDATE SET buy_vol=excluded.buy_vol,sell_vol=excluded.sell_vol,cvd_delta=excluded.cvd_delta,trades=excluded.trades")
    # resume: skip days already fully covered (any coin has rows whose minute falls in that day)
    have = set()
    for (d,) in db.execute("SELECT DISTINCT date(ts/1000,'unixepoch') FROM hl_cvd"):
        have.add(d)
    dates = [d for d in daterange(start, end) if d not in have]
    skipped = len(list(daterange(start, end))) - len(dates)

    grand = 0; done = 0; t0 = dt.datetime.now()
    print(f"in-region CVD backfill · {start}..{end} · {len(dates)} days to do ({skipped} already present) · workers={WORKERS}", flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(process_day, d): d for d in dates}
        for fut in as_completed(futs):
            date, rows, dl = fut.result()
            grand += dl; done += 1
            if rows:
                with db:
                    db.executemany(UP, rows)
            el = (dt.datetime.now() - t0).total_seconds()
            if done % 5 == 0 or done == len(dates):
                rate = grand / 1e6 / el if el > 0 else 0
                print(f"[{done}/{len(dates)}] {date}: {len(rows)} min-rows | {grand/1e9:.1f}GB {el:.0f}s ({rate:.1f}MB/s)", flush=True)
    db.close()
    print(f"\nDONE {done} days, {grand/1e9:.1f}GB in {(dt.datetime.now()-t0).total_seconds()/60:.1f} min → {OUT}", flush=True)
    print(f"Ship {OUT} back to the VPS, then: python3 scripts/import_cvd_backfill.py {OUT}", flush=True)


if __name__ == "__main__":
    main()

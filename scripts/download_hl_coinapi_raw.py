#!/usr/bin/env python3
"""Download raw Hyperliquid trades and quotes from CoinAPI Flat Files.

The downloader is resumable and cost-aware: it lists the complete manifest and
prints its compressed size before fetching any objects. Files are written via a
temporary path, checked against the S3 size, and fully decompressed once to
verify the gzip CRC before being promoted into the dataset.

Run on the production VPS, where COINAPI_KEY is configured:
  python3 -u scripts/download_hl_coinapi_raw.py \
    BTC,ETH,UNI,VIRTUAL,SAGA 20260624 20260630 data/hft-coinapi
"""

import concurrent.futures
import datetime as dt
import gzip
import json
import os
import pathlib
import sys
import time

BUCKET = "coinapi"
ENDPOINT = "https://s3.flatfiles.coinapi.io"
EXCHANGE = "HYPERLIQUID"
KINDS = ("T-TRADES", "T-QUOTES")
WORKERS = max(1, int(os.environ.get("COINAPI_DOWNLOAD_WORKERS", "4")))


def load_key():
    for line in open(".env", encoding="utf-8", errors="ignore"):
        if line.startswith("COINAPI_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("COINAPI_KEY is not configured")


def dates(start, end):
    current = dt.datetime.strptime(start, "%Y%m%d").date()
    last = dt.datetime.strptime(end, "%Y%m%d").date()
    if current > last:
        raise ValueError("start date must not be after end date")
    while current <= last:
        yield current.strftime("%Y%m%d")
        current += dt.timedelta(days=1)


def format_bytes(value):
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    amount = float(value)
    unit = 0
    while amount >= 1024 and unit < len(units) - 1:
        amount /= 1024
        unit += 1
    return f"{amount:.2f} {units[unit]}"


def client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=load_key(),
        aws_secret_access_key="coinapi",
        region_name="us-east-1",
        config=Config(signature_version="s3v4", max_pool_connections=WORKERS * 2, retries={"max_attempts": 4}),
    )


def build_manifest(s3, coins, start, end, out):
    wanted = {coin: f"SC-{EXCHANGE}_PERP_{coin}_USDC+" for coin in coins}
    manifest = []
    prefixes = [(date, hour, kind) for date in dates(start, end) for hour in range(24) for kind in KINDS]

    def list_prefix(spec):
        date, hour, kind = spec
        prefix = f"{kind}/D-{date}{hour:02d}/E-{EXCHANGE}/"
        response = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
        return date, hour, kind, response.get("Contents", [])

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        listed = list(pool.map(list_prefix, prefixes))
    for date, hour, kind, objects in listed:
        for coin, marker in wanted.items():
            matches = [obj for obj in objects if marker in obj["Key"]]
            if not matches:
                manifest.append({"kind": kind, "date": date, "hour": hour, "coin": coin, "missing": True})
                continue
            obj = matches[0]
            path = pathlib.Path(out, kind.lower().replace("t-", ""), date, f"{hour:02d}", f"{coin}.csv.gz")
            manifest.append({
                "kind": kind,
                "date": date,
                "hour": hour,
                "coin": coin,
                "key": obj["Key"],
                "size": int(obj["Size"]),
                "etag": str(obj.get("ETag", "")).strip('"'),
                "path": str(path),
                "missing": False,
            })
    return manifest


def verify_gzip(path):
    with gzip.open(path, "rb") as stream:
        while stream.read(1024 * 1024):
            pass


def fetch_one(s3, item):
    if item["missing"]:
        return "missing", item
    path = pathlib.Path(item["path"])
    if path.exists() and path.stat().st_size == item["size"]:
        verify_gzip(path)
        return "cached", item
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(f"{path}.part")
    temporary.unlink(missing_ok=True)
    try:
        response = s3.get_object(Bucket=BUCKET, Key=item["key"])
        with open(temporary, "wb") as output:
            while True:
                chunk = response["Body"].read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        if temporary.stat().st_size != item["size"]:
            raise IOError(f"size mismatch for {item['key']}")
        verify_gzip(temporary)
        temporary.replace(path)
        return "downloaded", item
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main():
    coins = [coin.strip().upper() for coin in (sys.argv[1] if len(sys.argv) > 1 else "BTC").split(",") if coin.strip()]
    start = sys.argv[2] if len(sys.argv) > 2 else "20260624"
    end = sys.argv[3] if len(sys.argv) > 3 else start
    out = pathlib.Path(sys.argv[4] if len(sys.argv) > 4 else "data/hft-coinapi").resolve()
    if not coins or any(not coin.isalnum() for coin in coins):
        raise ValueError("coins must be comma-separated alphanumeric symbols")

    s3 = client()
    print(f"CoinAPI raw Hyperliquid · {start}..{end} · {','.join(coins)} · workers={WORKERS}", flush=True)
    manifest = build_manifest(s3, coins, start, end, out)
    available = [item for item in manifest if not item["missing"]]
    total = sum(item["size"] for item in available)
    missing = len(manifest) - len(available)
    print(f"manifest: {len(available)}/{len(manifest)} files · {format_bytes(total)} compressed · missing={missing}", flush=True)

    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps({
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "coins": coins,
        "start": start,
        "end": end,
        "files": manifest,
    }, indent=2), encoding="utf-8")

    counts = {"downloaded": 0, "cached": 0, "missing": 0}
    downloaded_bytes = 0
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_one, s3, item) for item in manifest]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            status, item = future.result()
            counts[status] += 1
            if status == "downloaded":
                downloaded_bytes += item["size"]
            if index % 100 == 0 or index == len(futures):
                elapsed = max(time.monotonic() - started, 0.001)
                print(
                    f"[{index}/{len(futures)}] downloaded={counts['downloaded']} cached={counts['cached']} "
                    f"missing={counts['missing']} · {format_bytes(downloaded_bytes)} · {format_bytes(downloaded_bytes / elapsed)}/s",
                    flush=True,
                )
    print(f"done · manifest {manifest_path} · dataset {out}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        raise

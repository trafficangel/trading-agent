#!/usr/bin/env python3
"""Read-only Lighter SOL execution recorder for LuxAlgo shadow validation.

No keys are loaded and no transaction endpoint is called.  The recorder keeps
the executable $1,000 buy/sell VWAP, BBO and funding estimate at 100 ms
resolution so a later LuxAlgo webhook can be evaluated at signal + 300 ms,
matching the Standard-account taker delay.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sqlite3
import time
from pathlib import Path

import websockets

LIGHTER_WS = "wss://mainnet.zklighter.elliot.ai/stream"
MARKET_ID = 2
NOTIONAL_USD = 1_000.0
SAMPLE_MS = 100
RETENTION_MS = 14 * 24 * 60 * 60 * 1_000
DB_PATH = Path(
    os.environ.get(
        "LIGHTER_LUX_SHADOW_DB",
        "/home/trader/apps/lighter-lux-shadow/data/lighter_lux_shadow.sqlite",
    )
)


def execution_vwap(levels: list[tuple[float, float]], notional: float) -> float | None:
    remaining = notional
    quantity = 0.0
    cost = 0.0
    for price, available in levels:
        take = min(available, remaining / price)
        quantity += take
        cost += take * price
        remaining -= take * price
        if remaining <= 1e-8:
            return cost / quantity
    return None


def open_database() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS sol_execution_snapshots (
          ts_ms INTEGER PRIMARY KEY,
          exchange_ts_ms INTEGER NOT NULL,
          bid REAL NOT NULL,
          ask REAL NOT NULL,
          buy_vwap_1000 REAL NOT NULL,
          sell_vwap_1000 REAL NOT NULL,
          current_funding_pct_h REAL,
          last_funding_pct_h REAL,
          index_price REAL,
          mark_price REAL
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_sol_execution_exchange_ts "
        "ON sol_execution_snapshots(exchange_ts_ms)"
    )
    db.commit()
    return db


async def record(stop: asyncio.Event) -> None:
    db = open_database()
    last_prune_ms = 0
    while not stop.is_set():
        bids: dict[float, float] = {}
        asks: dict[float, float] = {}
        previous_nonce: int | None = None
        stats: dict[str, object] = {}
        last_sample_ms = 0
        try:
            async with websockets.connect(
                LIGHTER_WS,
                ping_interval=20,
                ping_timeout=20,
                max_size=64 * 1024 * 1024,
                max_queue=16_384,
            ) as socket:
                await socket.send(
                    json.dumps(
                        {"type": "subscribe", "channel": f"order_book/{MARKET_ID}"}
                    )
                )
                await socket.send(
                    json.dumps(
                        {"type": "subscribe", "channel": f"market_stats/{MARKET_ID}"}
                    )
                )
                print(json.dumps({"event": "connected", "market_id": MARKET_ID}), flush=True)
                async for raw in socket:
                    now_ms = int(time.time() * 1_000)
                    message = json.loads(raw)
                    market_stats = message.get("market_stats")
                    if market_stats:
                        stats = market_stats
                        continue
                    book = message.get("order_book")
                    if not book:
                        continue
                    begin_nonce = book.get("begin_nonce")
                    if previous_nonce is not None and begin_nonce != previous_nonce:
                        raise RuntimeError(
                            f"nonce_gap:{previous_nonce}!={begin_nonce}"
                        )
                    if book.get("nonce") is not None:
                        previous_nonce = int(book["nonce"])
                    for row in book.get("bids", []):
                        price, size = float(row["price"]), float(row["size"])
                        if size:
                            bids[price] = size
                        else:
                            bids.pop(price, None)
                    for row in book.get("asks", []):
                        price, size = float(row["price"]), float(row["size"])
                        if size:
                            asks[price] = size
                        else:
                            asks.pop(price, None)
                    if not bids or not asks or now_ms - last_sample_ms < SAMPLE_MS:
                        continue
                    bid_levels = sorted(bids.items(), reverse=True)
                    ask_levels = sorted(asks.items())
                    bid, ask = bid_levels[0][0], ask_levels[0][0]
                    buy_vwap = execution_vwap(ask_levels, NOTIONAL_USD)
                    sell_vwap = execution_vwap(bid_levels, NOTIONAL_USD)
                    if (
                        buy_vwap is None
                        or sell_vwap is None
                        or bid >= ask
                        or now_ms - int(message.get("timestamp", now_ms)) > 2_000
                    ):
                        continue
                    exchange_ts_ms = int(message.get("timestamp", now_ms))
                    db.execute(
                        """
                        INSERT OR REPLACE INTO sol_execution_snapshots VALUES
                        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            now_ms,
                            exchange_ts_ms,
                            bid,
                            ask,
                            buy_vwap,
                            sell_vwap,
                            float(stats["current_funding_rate"])
                            if stats.get("current_funding_rate") is not None
                            else None,
                            float(stats["funding_rate"])
                            if stats.get("funding_rate") is not None
                            else None,
                            float(stats["index_price"])
                            if stats.get("index_price") is not None
                            else None,
                            float(stats["mark_price"])
                            if stats.get("mark_price") is not None
                            else None,
                        ),
                    )
                    db.commit()
                    last_sample_ms = now_ms
                    if now_ms - last_prune_ms >= 60 * 60 * 1_000:
                        db.execute(
                            "DELETE FROM sol_execution_snapshots WHERE ts_ms < ?",
                            (now_ms - RETENTION_MS,),
                        )
                        db.commit()
                        last_prune_ms = now_ms
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(
                json.dumps(
                    {"event": "reconnect", "error": f"{type(error).__name__}:{error}"}
                ),
                flush=True,
            )
            try:
                await asyncio.wait_for(stop.wait(), timeout=2)
            except TimeoutError:
                pass
    db.close()


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await record(stop)


if __name__ == "__main__":
    asyncio.run(main())

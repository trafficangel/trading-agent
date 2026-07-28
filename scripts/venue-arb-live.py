#!/usr/bin/env python3
"""Protected one-shot Extended -> Lighter perpetual-arbitrage canary.

The process consumes the read-only venue-arb monitor status, waits for a fresh
tradeable window, submits both IOC legs concurrently, reconciles exchange
positions, exits on convergence, and flattens immediately on any mismatch.
It writes a public-safe status and trade journal for /lab/venue-arb.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import json
import math
import os
import signal
import time
from dataclasses import asdict, dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from pathlib import Path
from typing import Any

import aiohttp
import lighter
from x10.clients.rest import RestApiClient
from x10.config import MAINNET_CONFIG
from x10.core.stark_account import StarkPerpetualAccount
from x10.models.order import OrderSide, OrderType, TimeInForce
from x10.signing.order_object import create_order_object


MARKETS: dict[str, int] = {
    "BTC": 1,
    "ETH": 0,
    "SOL": 2,
    "HYPE": 24,
    "XRP": 7,
    "DOGE": 3,
    "ADA": 39,
    "BNB": 25,
    "LTC": 35,
}


@dataclass(frozen=True)
class Fill:
    price: float
    quantity: float
    notional: float
    fee: float
    filled_at: int | None


class Canary:
    def __init__(self, *, force_dry_run: bool = False) -> None:
        self.enabled = (
            os.getenv("VENUE_ARB_LIVE_ENABLED", "false").lower() == "true"
            and not force_dry_run
        )
        self.notional = float(os.getenv("VENUE_ARB_LIVE_NOTIONAL_USD", "300"))
        self.leverage = int(os.getenv("VENUE_ARB_LIVE_LEVERAGE", "5"))
        self.entry_net_bps = float(os.getenv("VENUE_ARB_LIVE_ENTRY_NET_BPS", "5"))
        self.fresh_ms = int(os.getenv("VENUE_ARB_LIVE_FRESH_MS", "150"))
        self.entry_slippage = float(
            os.getenv("VENUE_ARB_LIVE_ENTRY_SLIPPAGE", "0.0002")
        )
        self.exit_slippage = float(
            os.getenv("VENUE_ARB_LIVE_EXIT_SLIPPAGE", "0.001")
        )
        self.emergency_slippage = float(
            os.getenv("VENUE_ARB_LIVE_EMERGENCY_SLIPPAGE", "0.01")
        )
        self.min_hold_ms = int(os.getenv("VENUE_ARB_LIVE_MIN_HOLD_MS", "200"))
        self.max_hold_ms = int(os.getenv("VENUE_ARB_LIVE_MAX_HOLD_MS", "60000"))
        self.max_adverse_bps = float(
            os.getenv("VENUE_ARB_LIVE_MAX_ADVERSE_BPS", "20")
        )
        self.cooldown_ms = int(
            float(os.getenv("VENUE_ARB_LIVE_COOLDOWN_SECONDS", "900")) * 1000
        )
        self.max_trades = int(os.getenv("VENUE_ARB_LIVE_MAX_TRADES", "1"))
        self.daily_loss_usd = float(
            os.getenv("VENUE_ARB_LIVE_DAILY_LOSS_USD", "5")
        )
        self.data_dir = Path(
            os.getenv(
                "VENUE_ARB_DATA_DIR",
                "/home/trader/apps/trading-agent/data/venue-arb",
            )
        )
        self.monitor_path = self.data_dir / "status.json"
        self.execution_path = Path(
            os.getenv(
                "VENUE_ARB_EXECUTION_STATUS_PATH",
                str(self.data_dir / "execution-status.json"),
            )
        )
        self.status_path = self.data_dir / "live-status.json"
        self.trades_path = self.data_dir / "live-trades.json"
        self.lock_path = self.data_dir / "live.lock"
        self.running = True
        self.trade_open = False
        self.last_order_id = int(time.time() * 1000)
        self.last_status_write = 0.0
        self.last_rejection: str | None = None
        self.extended: RestApiClient | None = None
        self.extended_markets: dict[str, Any] = {}
        self.lighter_url = os.environ["LIGHTER_BASE_URL"]
        self.lighter_account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"])
        self.lighter_key_index = int(os.environ["LIGHTER_API_KEY_INDEX"])
        self.lighter_signer = lighter.SignerClient(
            url=self.lighter_url,
            account_index=self.lighter_account_index,
            api_private_keys={
                self.lighter_key_index: os.environ["LIGHTER_API_PRIVATE_KEY"]
            },
        )
        self.lighter_api = lighter.ApiClient(
            lighter.Configuration(host=self.lighter_url)
        )
        self.lighter_meta: dict[int, dict[str, Any]] = {}
        self.lock_file: Any = None

    def log(self, event: str, **fields: Any) -> None:
        print(
            json.dumps(
                {"at": int(time.time() * 1000), "event": event, **fields},
                default=str,
                separators=(",", ":"),
            ),
            flush=True,
        )

    def order_id(self) -> int:
        self.last_order_id = max(self.last_order_id + 1, int(time.time() * 1000))
        return self.last_order_id

    def acquire_lock(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.lock_file = self.lock_path.open("a+")
        fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def atomic_json(path: Path, data: Any) -> None:
        tmp = path.with_suffix(f"{path.suffix}.tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp, path)

    def read_json(self, path: Path, fallback: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return fallback

    def trades(self) -> list[dict[str, Any]]:
        rows = self.read_json(self.trades_path, [])
        return rows if isinstance(rows, list) else []

    def write_status(self, state: str, **fields: Any) -> None:
        now = int(time.time() * 1000)
        current = self.read_json(self.status_path, {})
        payload = {
            **(current if isinstance(current, dict) else {}),
            "version": "venue-arb-live-v1",
            "updatedAt": now,
            "enabled": self.enabled,
            "state": state,
            "notionalUsdPerLeg": self.notional,
            "leverage": self.leverage,
            "entryNetPct": self.entry_net_bps / 100,
            "route": "extended → lighter",
            "maxTrades": self.max_trades,
            "lastRejection": self.last_rejection,
            **fields,
        }
        self.atomic_json(self.status_path, payload)
        self.last_status_write = time.monotonic()

    def append_trade(self, row: dict[str, Any]) -> None:
        rows = self.trades()
        rows.append(row)
        self.atomic_json(self.trades_path, rows[-500:])

    def completed_trades(self) -> list[dict[str, Any]]:
        return [
            row
            for row in self.trades()
            if row.get("status") in {"closed", "failed_flat"}
        ]

    def today_net(self) -> float:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        return sum(
            float(row.get("netPnlUsd", 0) or 0)
            for row in self.completed_trades()
            if time.strftime(
                "%Y-%m-%d",
                time.gmtime(float(row.get("closedAt", 0) or 0) / 1000),
            )
            == today
        )

    async def create_extended_client(self) -> None:
        api_key = os.environ["EXTENDED_API_KEY"]
        public_key = os.getenv("EXTENDED_STARK_PUBLIC_KEY")
        if not public_key:
            base = os.getenv(
                "EXTENDED_BASE_URL",
                "https://api.starknet.extended.exchange/api/v1",
            ).rstrip("/")
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{base}/user/account/info",
                    headers={
                        "X-Api-Key": api_key,
                        "User-Agent": "RobotClaudeVenueArb/1.0",
                    },
                    timeout=10,
                ) as response:
                    response.raise_for_status()
                    body = await response.json()
            data = body.get("data") or {}
            public_key = data.get("l2Key")
        if not public_key:
            raise RuntimeError("Extended l2Key is unavailable")
        account = StarkPerpetualAccount(
            api_key=api_key,
            public_key=str(public_key),
            private_key=os.environ["EXTENDED_STARK_PRIVATE_KEY"],
            vault=os.environ["EXTENDED_VAULT_NUMBER"],
        )
        self.extended = RestApiClient(MAINNET_CONFIG, account)
        self.extended_markets = await self.extended.info.get_markets_dict()

    async def load_lighter_meta(self) -> None:
        response = await lighter.OrderApi(self.lighter_api).order_book_details()
        rows = response.to_dict().get("order_book_details") or []
        self.lighter_meta = {int(row["market_id"]): row for row in rows}
        missing = [market for market in MARKETS.values() if market not in self.lighter_meta]
        if missing:
            raise RuntimeError(f"Lighter market metadata missing: {missing}")

    async def lighter_auth(self) -> str:
        token, error = self.lighter_signer.create_auth_token_with_expiry(
            deadline=600,
            api_key_index=self.lighter_key_index,
        )
        if error is not None or not token:
            raise RuntimeError(f"Lighter auth failed: {error}")
        return token

    async def lighter_account(self) -> dict[str, Any]:
        response = await lighter.AccountApi(self.lighter_api).account(
            by="index",
            value=str(self.lighter_account_index),
            active_only=False,
        )
        rows = response.to_dict().get("accounts") or []
        if not rows:
            raise RuntimeError("Lighter account unavailable")
        return rows[0]

    async def lighter_positions(self) -> list[dict[str, Any]]:
        account = await self.lighter_account()
        return [
            row
            for row in account.get("positions") or []
            if abs(float(row.get("position", 0) or 0)) > 0
        ]

    async def extended_positions(self) -> list[Any]:
        assert self.extended is not None
        response = await self.extended.account.get_positions()
        if response.error:
            raise RuntimeError(f"Extended positions: {response.error.message}")
        return list(response.data or [])

    async def ensure_flat(self) -> None:
        extended, lighter_rows = await asyncio.gather(
            self.extended_positions(), self.lighter_positions()
        )
        if extended or lighter_rows:
            raise RuntimeError(
                f"pre-existing position: Extended={len(extended)} "
                f"Lighter={len(lighter_rows)}"
            )

    async def balances(self) -> tuple[float, float]:
        assert self.extended is not None
        ext_response, lighter_account = await asyncio.gather(
            self.extended.account.get_balance(), self.lighter_account()
        )
        if ext_response.error or ext_response.data is None:
            raise RuntimeError("Extended balance unavailable")
        ext_available = float(ext_response.data.available_for_trade)
        lighter_available = float(lighter_account.get("available_balance", 0) or 0)
        return ext_available, lighter_available

    async def arm_leverage(self) -> None:
        assert self.extended is not None
        for coin, market_id in MARKETS.items():
            market_name = f"{coin}-USD"
            if market_name not in self.extended_markets:
                continue
            ext_result = await self.extended.account.update_leverage(
                market_name, Decimal(self.leverage)
            )
            if ext_result.error:
                raise RuntimeError(
                    f"Extended leverage failed for {coin}: "
                    f"{ext_result.error.message}"
                )
            _, response, error = await self.lighter_signer.update_leverage(
                market_index=market_id,
                margin_mode=self.lighter_signer.CROSS_MARGIN_MODE,
                leverage=self.leverage,
                api_key_index=self.lighter_key_index,
            )
            if (
                error is not None
                or response is None
                or response.to_dict().get("code") != 200
            ):
                raise RuntimeError(
                    f"Lighter leverage failed for {coin}: {error}"
                )

    def candidate(self) -> dict[str, Any] | None:
        status = self.read_json(self.execution_path, {})
        now = int(time.time() * 1000)
        if status.get("version") != "venue-arb-execution-v1":
            self.last_rejection = "monitor version mismatch"
            return None
        if now - int(status.get("updatedAt", 0) or 0) > self.fresh_ms:
            self.last_rejection = "monitor snapshot stale"
            return None
        eligible = []
        for row in status.get("active") or []:
            if row.get("buyVenue") != "extended" or row.get("sellVenue") != "lighter":
                continue
            coin = str(row.get("coin") or "")
            net = float(row.get("currentNetBps1000") or -math.inf)
            ages = (
                float(row.get("currentBuyBookAgeMs") or math.inf),
                float(row.get("currentSellBookAgeMs") or math.inf),
            )
            depth = min(
                float(row.get("currentBuyDepthUsd") or 0),
                float(row.get("currentSellDepthUsd") or 0),
            )
            prices = (
                float(row.get("currentBuyVwap1000") or 0),
                float(row.get("currentSellVwap1000") or 0),
            )
            if (
                coin in MARKETS
                and net >= self.entry_net_bps
                and max(ages) <= self.fresh_ms
                and depth >= max(1000, self.notional * 3)
                and min(prices) > 0
            ):
                eligible.append(row)
        if not eligible:
            self.last_rejection = (
                f"waiting for Extended→Lighter net ≥{self.entry_net_bps:.1f} bps"
            )
            return None
        self.last_rejection = None
        return max(
            eligible,
            key=lambda row: float(row.get("currentNetBps1000") or -math.inf),
        )

    def common_quantity(self, coin: str, price: float) -> Decimal:
        market = self.extended_markets[f"{coin}-USD"]
        ext_tick = market.trading_config.min_order_size_change
        lighter_scale = Decimal(
            10 ** int(self.lighter_meta[MARKETS[coin]]["size_decimals"])
        )
        lighter_tick = Decimal(1) / lighter_scale
        raw = Decimal(str(self.notional)) / Decimal(str(price))
        quantity = (
            raw / ext_tick
        ).to_integral_value(rounding=ROUND_FLOOR) * ext_tick
        quantity = (
            quantity / lighter_tick
        ).to_integral_value(rounding=ROUND_FLOOR) * lighter_tick
        if quantity <= 0 or float(quantity) * price < self.notional * 0.9:
            raise RuntimeError("common order quantity is too small")
        return quantity

    def extended_worst_price(
        self, coin: str, reference: float, side: OrderSide, slippage: float
    ) -> Decimal:
        market = self.extended_markets[f"{coin}-USD"]
        multiplier = 1 + slippage if side == OrderSide.BUY else 1 - slippage
        rounding = ROUND_CEILING if side == OrderSide.BUY else ROUND_FLOOR
        return market.trading_config.round_price(
            Decimal(str(reference * multiplier)), rounding_direction=rounding
        )

    async def place_extended(
        self,
        coin: str,
        quantity: Decimal,
        reference: float,
        side: OrderSide,
        *,
        reduce_only: bool,
        slippage: float,
    ) -> int:
        assert self.extended is not None
        order = self.create_extended_order(
            coin,
            quantity,
            reference,
            side,
            reduce_only=reduce_only,
            slippage=slippage,
        )
        response = await self.extended.orders.place_order(order=order)
        if response.error or response.data is None:
            message = response.error.message if response.error else "empty response"
            raise RuntimeError(f"Extended order rejected: {message}")
        return int(response.data.id)

    def create_extended_order(
        self,
        coin: str,
        quantity: Decimal,
        reference: float,
        side: OrderSide,
        *,
        reduce_only: bool,
        slippage: float,
    ) -> Any:
        assert self.extended is not None
        market = self.extended_markets[f"{coin}-USD"]
        return create_order_object(
            account=self.extended.stark_account,
            order_type=OrderType.MARKET,
            starknet_domain=self.extended.config.signing.starknet_domain,
            market=market,
            side=side,
            amount_of_synthetic=quantity,
            price=self.extended_worst_price(coin, reference, side, slippage),
            time_in_force=TimeInForce.IOC,
            reduce_only=reduce_only,
            post_only=False,
            taker_fee=Decimal("0.00025"),
        )

    async def place_lighter(
        self,
        coin: str,
        quantity: Decimal,
        *,
        is_ask: bool,
        reduce_only: bool,
        slippage: float,
    ) -> int:
        market_id = MARKETS[coin]
        scale = 10 ** int(self.lighter_meta[market_id]["size_decimals"])
        order_id = self.order_id()
        _, response, error = (
            await self.lighter_signer.create_market_order_limited_slippage(
                market_index=market_id,
                client_order_index=order_id,
                base_amount=round(float(quantity) * scale),
                max_slippage=slippage,
                is_ask=is_ask,
                reduce_only=reduce_only,
                api_key_index=self.lighter_key_index,
            )
        )
        if error is not None or response is None:
            raise RuntimeError(f"Lighter order rejected: {error}")
        if response.to_dict().get("code") != 200:
            raise RuntimeError(f"Lighter order rejected: {response.to_dict()}")
        return order_id

    async def extended_fill(self, market: str, order_id: int) -> Fill | None:
        assert self.extended is not None
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            response = await self.extended.account.get_trades(
                market_names=[market], limit=100
            )
            rows = [
                row
                for row in (response.data or [])
                if int(row.order_id) == order_id
            ]
            if rows:
                quantity = sum(float(row.qty) for row in rows)
                notional = sum(float(row.value) for row in rows)
                return Fill(
                    price=notional / quantity,
                    quantity=quantity,
                    notional=notional,
                    fee=sum(float(row.fee) for row in rows),
                    filled_at=max(int(row.created_time) for row in rows),
                )
            await asyncio.sleep(0.15)
        return None

    async def lighter_fill(self, coin: str, order_id: int) -> Fill | None:
        deadline = time.monotonic() + 6
        market_id = MARKETS[coin]
        while time.monotonic() < deadline:
            response = await lighter.OrderApi(self.lighter_api).trades(
                sort_by="timestamp",
                sort_dir="desc",
                limit=100,
                authorization=await self.lighter_auth(),
                market_id=market_id,
                account_index=self.lighter_account_index,
            )
            rows = [
                row
                for row in (response.to_dict().get("trades") or [])
                if int(row.get("ask_client_id", -1)) == order_id
                or int(row.get("bid_client_id", -1)) == order_id
            ]
            if rows:
                quantity = sum(float(row.get("size", 0) or 0) for row in rows)
                notional = sum(
                    float(row.get("price", 0) or 0)
                    * float(row.get("size", 0) or 0)
                    for row in rows
                )
                return Fill(
                    price=notional / quantity,
                    quantity=quantity,
                    notional=notional,
                    fee=0.0,
                    filled_at=max(
                        int(row.get("timestamp", 0) or 0) for row in rows
                    ),
                )
            await asyncio.sleep(0.15)
        return None

    async def wait_positions(
        self, coin: str, *, want_open: bool, timeout: float = 6
    ) -> tuple[Any | None, dict[str, Any] | None]:
        deadline = time.monotonic() + timeout
        last: tuple[Any | None, dict[str, Any] | None] = (None, None)
        while time.monotonic() < deadline:
            ext_rows, lighter_rows = await asyncio.gather(
                self.extended_positions(), self.lighter_positions()
            )
            ext = next(
                (row for row in ext_rows if row.market == f"{coin}-USD"), None
            )
            lit = next(
                (
                    row
                    for row in lighter_rows
                    if int(row.get("market_id", -1)) == MARKETS[coin]
                ),
                None,
            )
            last = (ext, lit)
            if ((ext is not None) == want_open) and ((lit is not None) == want_open):
                return last
            await asyncio.sleep(0.15)
        return last

    async def extended_reference(self, coin: str, side: OrderSide) -> float:
        assert self.extended is not None
        response = await self.extended.info.get_market_statistics(
            market_name=f"{coin}-USD"
        )
        if response.error or response.data is None:
            raise RuntimeError("Extended market statistics unavailable")
        return float(
            response.data.ask_price if side == OrderSide.BUY else response.data.bid_price
        )

    async def flatten(self, coin: str, *, emergency: bool) -> dict[str, Any]:
        ext_rows, lighter_rows = await asyncio.gather(
            self.extended_positions(), self.lighter_positions()
        )
        ext = next(
            (row for row in ext_rows if row.market == f"{coin}-USD"), None
        )
        lit = next(
            (
                row
                for row in lighter_rows
                if int(row.get("market_id", -1)) == MARKETS[coin]
            ),
            None,
        )
        slippage = self.emergency_slippage if emergency else self.exit_slippage
        tasks: dict[str, Any] = {}
        if ext is not None:
            ext_side = OrderSide.SELL if str(ext.side) == "LONG" else OrderSide.BUY
            ext_reference = await self.extended_reference(coin, ext_side)
            tasks["extended"] = asyncio.create_task(
                self.place_extended(
                    coin,
                    Decimal(str(abs(float(ext.size)))),
                    ext_reference,
                    ext_side,
                    reduce_only=True,
                    slippage=slippage,
                )
            )
        if lit is not None:
            tasks["lighter"] = asyncio.create_task(
                self.place_lighter(
                    coin,
                    Decimal(str(abs(float(lit["position"])))),
                    is_ask=int(lit.get("sign", 0)) > 0,
                    reduce_only=True,
                    slippage=slippage,
                )
            )
        results = (
            await asyncio.gather(*tasks.values(), return_exceptions=True)
            if tasks
            else []
        )
        order_ids = dict(zip(tasks.keys(), results, strict=True))
        errors = {
            venue: str(result)
            for venue, result in order_ids.items()
            if isinstance(result, Exception)
        }
        if errors and not emergency:
            successful = {
                venue: int(result)
                for venue, result in order_ids.items()
                if not isinstance(result, Exception)
            }
            retry = await self.flatten(coin, emergency=True)
            return {**successful, **retry}
        if errors:
            raise RuntimeError(f"emergency flatten rejected: {errors}")
        remaining = await self.wait_positions(coin, want_open=False, timeout=8)
        if any(remaining):
            if not emergency:
                retry = await self.flatten(coin, emergency=True)
                successful = {
                    venue: int(value) for venue, value in order_ids.items()
                }
                return {**successful, **retry}
            raise RuntimeError("positions remain after flatten")
        return {key: int(value) for key, value in order_ids.items()}

    def opportunity_net(self, opportunity_id: str) -> float | None:
        status = self.read_json(self.execution_path, {})
        row = next(
            (
                item
                for item in status.get("active") or []
                if item.get("id") == opportunity_id
            ),
            None,
        )
        if row is None:
            return None
        value = float(row.get("currentNetBps1000") or -math.inf)
        return value if math.isfinite(value) else None

    async def execute(self, candidate: dict[str, Any]) -> None:
        coin = str(candidate["coin"])
        opportunity_id = str(candidate["id"])
        quantity = self.common_quantity(
            coin, float(candidate["currentBuyVwap1000"])
        )
        started_at = int(time.time() * 1000)
        trade: dict[str, Any] = {
            "id": f"L{started_at}",
            "status": "opening",
            "coin": coin,
            "route": "Extended → Lighter",
            "opportunityId": opportunity_id,
            "signalAt": int(candidate.get("startedAt") or started_at),
            "startedAt": started_at,
            "entryNetPct": float(candidate["currentNetBps1000"]) / 100,
            "notionalUsdPerLeg": self.notional,
            "leverage": self.leverage,
            "quantity": float(quantity),
        }
        self.trade_open = True
        self.write_status("opening", activeTrade=trade)
        self.log("entry_submit", **trade)
        entry_tasks = {
            "extended": asyncio.create_task(
                self.place_extended(
                    coin,
                    quantity,
                    float(candidate["currentBuyVwap1000"]),
                    OrderSide.BUY,
                    reduce_only=False,
                    slippage=self.entry_slippage,
                )
            ),
            "lighter": asyncio.create_task(
                self.place_lighter(
                    coin,
                    quantity,
                    is_ask=True,
                    reduce_only=False,
                    slippage=self.entry_slippage,
                )
            ),
        }
        results = await asyncio.gather(
            *entry_tasks.values(), return_exceptions=True
        )
        entry_orders = dict(zip(entry_tasks.keys(), results, strict=True))
        order_errors = {
            venue: str(result)
            for venue, result in entry_orders.items()
            if isinstance(result, Exception)
        }
        if order_errors:
            await asyncio.sleep(0.5)
            with contextlib.suppress(Exception):
                await self.flatten(coin, emergency=True)
            trade.update(
                status="failed_flat",
                closedAt=int(time.time() * 1000),
                error=f"entry leg rejected: {order_errors}",
                netPnlUsd=0,
            )
            self.append_trade(trade)
            self.trade_open = False
            self.write_status("blocked", activeTrade=None, lastTrade=trade)
            return
        ext_order = int(entry_orders["extended"])
        lit_order = int(entry_orders["lighter"])
        ext_fill_task = asyncio.create_task(
            self.extended_fill(f"{coin}-USD", ext_order)
        )
        lit_fill_task = asyncio.create_task(self.lighter_fill(coin, lit_order))
        ext_fill, lit_fill = await asyncio.gather(ext_fill_task, lit_fill_task)
        positions = await self.wait_positions(coin, want_open=True, timeout=4)
        if (
            ext_fill is None
            or lit_fill is None
            or any(position is None for position in positions)
            or abs(ext_fill.quantity - lit_fill.quantity)
            > max(ext_fill.quantity, lit_fill.quantity) * 0.002
        ):
            with contextlib.suppress(Exception):
                await self.flatten(coin, emergency=True)
            trade.update(
                status="failed_flat",
                closedAt=int(time.time() * 1000),
                error="entry fills/positions did not reconcile",
                entryExtended=asdict(ext_fill) if ext_fill else None,
                entryLighter=asdict(lit_fill) if lit_fill else None,
                netPnlUsd=0,
            )
            self.append_trade(trade)
            self.trade_open = False
            self.write_status("blocked", activeTrade=None, lastTrade=trade)
            return
        opened_at = max(
            ext_fill.filled_at or started_at, lit_fill.filled_at or started_at
        )
        trade.update(
            status="open",
            openedAt=opened_at,
            entryLatencyMs=opened_at - started_at,
            entryExtended=asdict(ext_fill),
            entryLighter=asdict(lit_fill),
        )
        self.write_status("open", activeTrade=trade)
        self.log("entry_filled", **trade)
        while self.running:
            now = int(time.time() * 1000)
            if now - opened_at >= self.max_hold_ms:
                close_reason = "max_hold"
                break
            if now - opened_at >= self.min_hold_ms:
                current_net = self.opportunity_net(opportunity_id)
                if current_net is None or current_net <= 0:
                    close_reason = "converged"
                    break
                if (
                    current_net
                    >= float(candidate["currentNetBps1000"])
                    + self.max_adverse_bps
                ):
                    close_reason = "adverse_basis"
                    break
            await asyncio.sleep(0.05)
        else:
            close_reason = "shutdown"
        close_started = int(time.time() * 1000)
        self.write_status(
            "closing", activeTrade={**trade, "closeReason": close_reason}
        )
        exit_orders = await self.flatten(coin, emergency=False)
        ext_exit_task = asyncio.create_task(
            self.extended_fill(f"{coin}-USD", exit_orders["extended"])
        )
        lit_exit_task = asyncio.create_task(
            self.lighter_fill(coin, exit_orders["lighter"])
        )
        ext_exit, lit_exit = await asyncio.gather(ext_exit_task, lit_exit_task)
        if ext_exit is None or lit_exit is None:
            raise RuntimeError("exit fills missing after flat confirmation")
        closed_at = max(
            ext_exit.filled_at or close_started,
            lit_exit.filled_at or close_started,
        )
        quantity_done = min(
            ext_fill.quantity,
            lit_fill.quantity,
            ext_exit.quantity,
            lit_exit.quantity,
        )
        gross = (
            (ext_exit.price - ext_fill.price)
            + (lit_fill.price - lit_exit.price)
        ) * quantity_done
        fees = ext_fill.fee + ext_exit.fee + lit_fill.fee + lit_exit.fee
        net = gross - fees
        trade.update(
            status="closed",
            closeReason=close_reason,
            closeStartedAt=close_started,
            closedAt=closed_at,
            holdingMs=closed_at - opened_at,
            exitLatencyMs=closed_at - close_started,
            exitExtended=asdict(ext_exit),
            exitLighter=asdict(lit_exit),
            grossPnlUsd=round(gross, 8),
            feesUsd=round(fees, 8),
            netPnlUsd=round(net, 8),
            netPnlPct=round(net / self.notional * 100, 8),
        )
        self.append_trade(trade)
        self.trade_open = False
        self.write_status("completed", activeTrade=None, lastTrade=trade)
        self.log("trade_closed", **trade)

    async def preflight(self) -> None:
        await asyncio.gather(
            self.create_extended_client(), self.load_lighter_meta()
        )
        await self.ensure_flat()
        ext_balance, lit_balance = await self.balances()
        required = self.notional / self.leverage + 10
        if min(ext_balance, lit_balance) < required:
            raise RuntimeError(
                f"available margin below ${required:.2f}: "
                f"Extended={ext_balance:.2f}, Lighter={lit_balance:.2f}"
            )
        if self.today_net() <= -self.daily_loss_usd:
            raise RuntimeError("daily loss breaker is active")
        self.write_status(
            "preflight",
            balancesUsd={
                "extended": round(ext_balance, 4),
                "lighter": round(lit_balance, 4),
            },
        )
        if self.enabled:
            await self.arm_leverage()

    async def sign_test(self) -> None:
        await self.preflight()
        reference = await self.extended_reference("BTC", OrderSide.BUY)
        quantity = self.common_quantity("BTC", reference)
        order = self.create_extended_order(
            "BTC",
            quantity,
            reference,
            OrderSide.BUY,
            reduce_only=False,
            slippage=self.entry_slippage,
        )
        if not order.settlement or not order.settlement.signature:
            raise RuntimeError("Extended signature was not created")
        self.write_status("sign_test_ready")
        self.log("sign_test_ready", market="BTC-USD", quantity=float(quantity))

    async def run(self) -> None:
        self.acquire_lock()
        await self.preflight()
        if not self.enabled:
            self.write_status("dry_run_ready")
            self.log("dry_run_ready")
            return
        if len(self.completed_trades()) >= self.max_trades:
            self.write_status("completed", reason="max trade count reached")
            return
        self.write_status("armed")
        self.log(
            "armed",
            notional=self.notional,
            leverage=self.leverage,
            threshold_bps=self.entry_net_bps,
        )
        while self.running:
            if len(self.completed_trades()) >= self.max_trades:
                self.write_status("completed", reason="max trade count reached")
                return
            candidate = self.candidate()
            if candidate:
                await self.execute(candidate)
                return
            if time.monotonic() - self.last_status_write >= 1:
                self.write_status("armed")
            await asyncio.sleep(0.02)

    async def close(self) -> None:
        if self.extended is not None:
            await self.extended.close()
        await self.lighter_signer.close()
        await self.lighter_api.close()


def self_test() -> None:
    assert MARKETS["BTC"] == 1
    assert len(MARKETS) == 9
    assert Decimal("1.234") > 0
    print("venue-arb-live self-test ok")


async def main(force_dry_run: bool, sign_test: bool) -> None:
    runner = Canary(force_dry_run=force_dry_run)
    loop = asyncio.get_running_loop()
    for name in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(name, setattr, runner, "running", False)
    try:
        if sign_test:
            runner.acquire_lock()
            await runner.sign_test()
        else:
            await runner.run()
    except Exception as error:
        runner.log("fatal", error=str(error))
        with contextlib.suppress(Exception):
            if runner.trade_open:
                positions = await asyncio.gather(
                    runner.extended_positions(), runner.lighter_positions()
                )
                coins = {
                    str(row.market).split("-")[0] for row in positions[0]
                } | {
                    coin
                    for coin, market_id in MARKETS.items()
                    if any(
                        int(row.get("market_id", -1)) == market_id
                        for row in positions[1]
                    )
                }
                for coin in coins:
                    await runner.flatten(coin, emergency=True)
            runner.write_status("error", error=str(error), activeTrade=None)
        raise
    finally:
        await runner.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sign-test", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        asyncio.run(main(args.dry_run, args.sign_test))

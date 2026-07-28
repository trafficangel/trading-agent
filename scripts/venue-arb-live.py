#!/usr/bin/env python3
"""Protected one-shot Extended/Lighter perpetual-arbitrage canary.

The process consumes the read-only venue-arb monitor status, waits for a fresh
tradeable window in the configured direction, submits both IOC legs
concurrently, reconciles exchange positions, exits on convergence, and
flattens immediately on any mismatch. It writes a public-safe status and trade
journal for /lab/venue-arb.
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
from datetime import datetime, timedelta, timezone
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from pathlib import Path
from typing import Any

import aiohttp
import lighter
from x10.clients.rest import RestApiClient
from x10.config import MAINNET_CONFIG
from x10.core.stark_account import StarkPerpetualAccount
from x10.errors import ApiError
from x10.models.order import OrderSide, OrderStatus, OrderType, TimeInForce
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

ROUTES: dict[str, tuple[str, str, str]] = {
    "extended-lighter": ("extended", "lighter", "Extended → Lighter"),
    "lighter-extended": ("lighter", "extended", "Lighter → Extended"),
}


@dataclass(frozen=True)
class Fill:
    price: float
    quantity: float
    notional: float
    fee: float
    filled_at: int | None


@dataclass(frozen=True)
class MakerFillResult:
    fill: Fill | None
    status: str
    reason: str | None


def maker_entry_edge_bps(
    side: str,
    extended_price: float,
    lighter_hedge_price: float,
) -> float:
    if min(extended_price, lighter_hedge_price) <= 0:
        return -math.inf
    if side == "buy":
        return (lighter_hedge_price / extended_price - 1) * 10_000
    return (extended_price / lighter_hedge_price - 1) * 10_000


def safer_maker_price(
    *,
    side: str,
    candidate_price: float,
    best_bid: float,
    best_ask: float,
    tick: float,
    safety_ticks: int,
    safety_bps: float,
) -> float:
    if (
        side not in {"buy", "sell"}
        or min(candidate_price, best_bid, best_ask, tick) <= 0
        or best_bid >= best_ask
    ):
        return math.nan
    opposite = best_ask if side == "buy" else best_bid
    distance = max(
        max(1, safety_ticks) * tick,
        opposite * max(0, safety_bps) / 10_000,
    )
    if side == "buy":
        return min(candidate_price, best_ask - distance)
    return max(candidate_price, best_bid + distance)


def projected_net_usd(
    *,
    quantity: float,
    entry_buy: float,
    entry_sell: float,
    exit_buy: float,
    exit_sell: float,
    known_entry_fees: float,
    estimated_exit_fees: float,
) -> float:
    gross = (
        (exit_buy - entry_buy)
        + (entry_sell - exit_sell)
    ) * quantity
    return gross - known_entry_fees - estimated_exit_fees


class Canary:
    def __init__(self, *, force_dry_run: bool = False) -> None:
        self.enabled = (
            os.getenv("VENUE_ARB_LIVE_ENABLED", "false").lower() == "true"
            and not force_dry_run
        )
        self.execution_mode = os.getenv(
            "VENUE_ARB_LIVE_EXECUTION", "taker-taker"
        ).strip().lower()
        if self.execution_mode not in {"taker-taker", "maker-taker"}:
            raise RuntimeError(
                f"unsupported VENUE_ARB_LIVE_EXECUTION={self.execution_mode!r}"
            )
        self.route_id = os.getenv(
            "VENUE_ARB_LIVE_ROUTE", "extended-lighter"
        ).strip().lower()
        if self.execution_mode == "taker-taker" and self.route_id not in ROUTES:
            raise RuntimeError(
                f"unsupported VENUE_ARB_LIVE_ROUTE={self.route_id!r}"
            )
        if self.execution_mode == "maker-taker":
            self.route_id = "extended-maker-lighter"
            self.buy_venue = "extended"
            self.sell_venue = "lighter"
            self.route_label = "Extended maker ↔ Lighter taker"
        else:
            self.buy_venue, self.sell_venue, self.route_label = ROUTES[self.route_id]
        self.notional = float(os.getenv("VENUE_ARB_LIVE_NOTIONAL_USD", "300"))
        self.leverage = int(os.getenv("VENUE_ARB_LIVE_LEVERAGE", "5"))
        self.entry_net_bps = float(os.getenv("VENUE_ARB_LIVE_ENTRY_NET_BPS", "15"))
        self.exit_min_profit_bps = float(
            os.getenv("VENUE_ARB_LIVE_EXIT_MIN_PROFIT_BPS", "10")
        )
        self.exit_confirmations = int(
            os.getenv("VENUE_ARB_LIVE_EXIT_CONFIRMATIONS", "3")
        )
        self.extended_taker_bps = float(
            os.getenv("VENUE_ARB_LIVE_EXTENDED_TAKER_BPS", "2.5")
        )
        self.fresh_ms = int(os.getenv("VENUE_ARB_LIVE_FRESH_MS", "150"))
        self.source_fresh_ms = int(
            os.getenv("VENUE_ARB_LIVE_SOURCE_FRESH_MS", "750")
        )
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
        self.maker_max_queue_usd = float(
            os.getenv("VENUE_ARB_LIVE_MAKER_MAX_QUEUE_USD", "5000")
        )
        self.maker_min_ttl_ms = int(
            os.getenv("VENUE_ARB_LIVE_MAKER_MIN_TTL_MS", "5000")
        )
        self.maker_order_ttl_ms = int(
            os.getenv("VENUE_ARB_LIVE_MAKER_ORDER_TTL_MS", "60000")
        )
        self.maker_safety_ticks = int(
            os.getenv("VENUE_ARB_LIVE_MAKER_SAFETY_TICKS", "1")
        )
        self.maker_safety_bps = float(
            os.getenv("VENUE_ARB_LIVE_MAKER_SAFETY_BPS", "0")
        )
        self.execution_buffer_bps = float(
            os.getenv("VENUE_ARB_EXECUTION_BUFFER_BPS", "2")
        )
        self.maker_retry_cooldown_ms = int(
            os.getenv("VENUE_ARB_LIVE_MAKER_RETRY_COOLDOWN_MS", "5000")
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
        self.shutdown_requested = False
        self.trade_open = False
        self.last_order_id = int(time.time() * 1000)
        self.last_status_write = 0.0
        self.last_rejection: str | None = None
        self.next_maker_attempt_at = 0
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
            "executionMode": self.execution_mode,
            "notionalUsdPerLeg": self.notional,
            "leverage": self.leverage,
            "entryNetPct": self.entry_net_bps / 100,
            "exitMinProfitPct": self.exit_min_profit_bps / 100,
            "exitConfirmations": self.exit_confirmations,
            "shutdownDeferredWhenOpen": True,
            "routeId": self.route_id,
            "route": self.route_label,
            "maxTrades": self.max_trades,
            "lastRejection": self.last_rejection,
            "reason": None,
            "error": None,
            **fields,
        }
        self.atomic_json(self.status_path, payload)
        self.last_status_write = time.monotonic()

    def request_shutdown(self) -> None:
        self.shutdown_requested = True
        self.log("shutdown_requested", trade_open=self.trade_open)
        if not self.trade_open:
            self.running = False

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

    def completed_route_trades(self) -> list[dict[str, Any]]:
        return [
            row
            for row in self.completed_trades()
            if row.get("routeId") == self.route_id
            or (
                not row.get("routeId")
                and str(row.get("route") or "").lower()
                == self.route_label.lower()
            )
        ]

    def completed_mode_trades(self) -> list[dict[str, Any]]:
        if self.execution_mode == "maker-taker":
            return [
                row
                for row in self.completed_trades()
                if row.get("executionMode") == self.execution_mode
            ]
        return self.completed_route_trades()

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
        assert self.extended is not None
        extended, lighter_rows, open_orders = await asyncio.gather(
            self.extended_positions(),
            self.lighter_positions(),
            self.extended.account.get_open_orders(),
        )
        if open_orders.error:
            raise RuntimeError("Extended open orders unavailable")
        if extended or lighter_rows or list(open_orders.data or []):
            raise RuntimeError(
                f"pre-existing position: Extended={len(extended)} "
                f"Lighter={len(lighter_rows)} "
                f"ExtendedOrders={len(list(open_orders.data or []))}"
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
        if status.get("version") != "venue-arb-execution-v2":
            self.last_rejection = "monitor version mismatch"
            return None
        if now - int(status.get("updatedAt", 0) or 0) > self.fresh_ms:
            self.last_rejection = "monitor snapshot stale"
            return None
        eligible = []
        for row in status.get("active") or []:
            if (
                row.get("buyVenue") != self.buy_venue
                or row.get("sellVenue") != self.sell_venue
            ):
                continue
            coin = str(row.get("coin") or "")
            net = float(row.get("currentNetBps1000") or -math.inf)
            ages = (
                float(row.get("currentBuyBookAgeMs") or math.inf),
                float(row.get("currentSellBookAgeMs") or math.inf),
            )
            source_ages = (
                float(row.get("currentBuyBookSourceAgeMs") or math.inf),
                float(row.get("currentSellBookSourceAgeMs") or math.inf),
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
                and max(source_ages) <= self.source_fresh_ms
                and depth >= max(1000, self.notional * 3)
                and min(prices) > 0
            ):
                eligible.append(row)
        if not eligible:
            self.last_rejection = (
                f"waiting for {self.route_label} net "
                f"≥{self.entry_net_bps:.1f} bps"
            )
            return None
        self.last_rejection = None
        return max(
            eligible,
            key=lambda row: float(row.get("currentNetBps1000") or -math.inf),
        )

    def maker_candidate(self) -> dict[str, Any] | None:
        status = self.read_json(self.execution_path, {})
        now = int(time.time() * 1000)
        if status.get("version") != "venue-arb-execution-v2":
            self.last_rejection = "maker execution snapshot version mismatch"
            return None
        if now - int(status.get("updatedAt", 0) or 0) > self.fresh_ms:
            self.last_rejection = "maker execution snapshot stale"
            return None
        maker = status.get("maker") or {}
        quote = maker.get("quote") or {}
        queue = quote.get("queue") or {}
        coin = str(quote.get("coin") or "")
        price = float(quote.get("price") or 0)
        queue_ahead = float(queue.get("queueAhead") or 0)
        projected_net_bps = float(quote.get("projectedNetBps") or -math.inf)
        expires_at = int(quote.get("expiresAt") or 0)
        freshness = (status.get("closingQuotes") or {}).get(coin) or {}
        lighter_hedge_price = float(
            freshness.get(
                "lighterSellVwap" if quote.get("side") == "buy"
                else "lighterBuyVwap"
            )
            or 0
        )
        if (
            now < self.next_maker_attempt_at
            or quote.get("stage") != "entry"
            or quote.get("activatedAt") is None
            or coin not in MARKETS
            or quote.get("side") not in {"buy", "sell"}
            or price <= 0
            or lighter_hedge_price <= 0
            or projected_net_bps < self.entry_net_bps
            or queue_ahead * price > self.maker_max_queue_usd
            or expires_at - now < self.maker_min_ttl_ms
            or float(freshness.get("extendedBookAgeMs") or math.inf)
            > self.source_fresh_ms
            or float(freshness.get("lighterBookAgeMs") or math.inf)
            > self.source_fresh_ms
            or float(freshness.get("extendedSourceAgeMs") or math.inf)
            > self.source_fresh_ms
            or float(freshness.get("lighterSourceAgeMs") or math.inf)
            > self.source_fresh_ms
        ):
            self.last_rejection = (
                f"waiting maker net ≥{self.entry_net_bps:.1f} bps, "
                f"queue ≤${self.maker_max_queue_usd:.0f}"
            )
            return None
        self.last_rejection = None
        return {
            "id": str(quote.get("id")),
            "coin": coin,
            "side": str(quote.get("side")),
            "price": price,
            "queueAheadUsd": queue_ahead * price,
            "projectedNetBps": projected_net_bps,
            "lighterHedgePrice": lighter_hedge_price,
            "expiresAt": expires_at,
            "monitorUpdatedAt": int(status.get("updatedAt") or 0),
        }

    async def revalidate_maker_candidate(
        self, candidate: dict[str, Any]
    ) -> dict[str, Any] | None:
        assert self.extended is not None
        coin = str(candidate["coin"])
        side = str(candidate["side"])
        response = await self.extended.info.get_market_statistics(
            market_name=f"{coin}-USD"
        )
        if response.error or response.data is None:
            self.last_rejection = "Extended best bid/ask unavailable"
            return None
        fresh = self.maker_candidate()
        if (
            fresh is None
            or fresh["coin"] != coin
            or fresh["side"] != side
        ):
            self.last_rejection = "maker window changed during revalidation"
            return None

        stats = response.data
        best_bid = float(stats.bid_price)
        best_ask = float(stats.ask_price)
        market = self.extended_markets[f"{coin}-USD"]
        tick = float(market.trading_config.min_price_change)
        hedge_price = float(fresh["lighterHedgePrice"])
        required_raw_bps = (
            self.entry_net_bps + self.execution_buffer_bps
        )
        edge_limit_price = (
            hedge_price / (1 + required_raw_bps / 10_000)
            if side == "buy"
            else hedge_price * (1 + required_raw_bps / 10_000)
        )
        raw_price = safer_maker_price(
            side=side,
            candidate_price=edge_limit_price,
            best_bid=best_bid,
            best_ask=best_ask,
            tick=tick,
            safety_ticks=self.maker_safety_ticks,
            safety_bps=self.maker_safety_bps,
        )
        rounding = ROUND_FLOOR if side == "buy" else ROUND_CEILING
        if not math.isfinite(raw_price):
            self.last_rejection = "invalid Extended maker safety price"
            return None
        price = float(
            market.trading_config.round_price(
                Decimal(str(raw_price)), rounding_direction=rounding
            )
        )
        projected_net_bps = (
            maker_entry_edge_bps(side, price, hedge_price)
            - self.execution_buffer_bps
        )
        if (
            price <= 0
            or (side == "buy" and price >= best_ask)
            or (side == "sell" and price <= best_bid)
            or projected_net_bps < self.entry_net_bps
        ):
            self.last_rejection = (
                "maker safety price no longer clears the net entry gate"
            )
            return None
        return {
            **fresh,
            "price": price,
            "sourcePrice": float(fresh["price"]),
            "queueAheadUsd": float(fresh["queueAheadUsd"]),
            "projectedNetBps": projected_net_bps,
            "extendedBestBid": best_bid,
            "extendedBestAsk": best_ask,
            "makerSafetyTicks": self.maker_safety_ticks,
            "makerSafetyBps": self.maker_safety_bps,
        }

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

    def lighter_compatible_quantity(self, coin: str, quantity: float) -> Decimal:
        market_id = MARKETS[coin]
        scale = Decimal(
            10 ** int(self.lighter_meta[market_id]["size_decimals"])
        )
        tick = Decimal(1) / scale
        raw = Decimal(str(quantity))
        result = (raw / tick).to_integral_value(rounding=ROUND_FLOOR) * tick
        if result <= 0:
            raise RuntimeError("maker fill is below Lighter minimum quantity")
        if float(raw - result) > max(float(raw) * 0.002, float(tick) / 10):
            raise RuntimeError("maker partial fill cannot be hedged precisely")
        return result

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

    def create_extended_maker_order(
        self,
        coin: str,
        quantity: Decimal,
        price: float,
        side: OrderSide,
    ) -> Any:
        assert self.extended is not None
        market = self.extended_markets[f"{coin}-USD"]
        rounding = ROUND_FLOOR if side == OrderSide.BUY else ROUND_CEILING
        maker_price = market.trading_config.round_price(
            Decimal(str(price)), rounding_direction=rounding
        )
        return create_order_object(
            account=self.extended.stark_account,
            order_type=OrderType.LIMIT,
            starknet_domain=self.extended.config.signing.starknet_domain,
            market=market,
            side=side,
            amount_of_synthetic=quantity,
            price=maker_price,
            time_in_force=TimeInForce.GTT,
            expire_time=datetime.now(timezone.utc)
            + timedelta(milliseconds=self.maker_order_ttl_ms),
            reduce_only=False,
            post_only=True,
            taker_fee=Decimal("0"),
        )

    async def place_extended_maker(
        self,
        coin: str,
        quantity: Decimal,
        price: float,
        side: OrderSide,
    ) -> int:
        assert self.extended is not None
        order = self.create_extended_maker_order(
            coin, quantity, price, side
        )
        response = await self.extended.orders.place_order(order=order)
        if response.error or response.data is None:
            message = response.error.message if response.error else "empty response"
            raise RuntimeError(f"Extended maker order rejected: {message}")
        return int(response.data.id)

    @staticmethod
    def order_status_value(status: Any) -> str:
        return str(getattr(status, "value", status)).upper()

    async def cancel_extended_order(self, order_id: int) -> None:
        assert self.extended is not None
        try:
            response = await self.extended.orders.cancel_order(order_id)
        except ApiError as error:
            if "code 404" not in str(error):
                raise
            await self.cancel_all_extended_orders()
            return
        if response.error:
            raise RuntimeError(
                f"Extended cancel rejected: {response.error.message}"
            )

    async def cancel_all_extended_orders(self) -> None:
        assert self.extended is not None
        response = await self.extended.orders.mass_cancel(cancel_all=True)
        if response.error:
            raise RuntimeError(
                f"Extended mass cancel rejected: {response.error.message}"
            )

    async def extended_order_by_id(self, order_id: int) -> Any | None:
        assert self.extended is not None
        try:
            response = await self.extended.account.get_order_by_id(order_id)
        except ApiError as error:
            if "code 404" in str(error):
                return None
            raise
        if response.error or response.data is None:
            return None
        return response.data

    async def wait_extended_maker_fill(
        self,
        coin: str,
        order_id: int,
        deadline_at: int,
    ) -> MakerFillResult:
        assert self.extended is not None
        market = f"{coin}-USD"
        saw_fill = False
        final_statuses = {
            OrderStatus.FILLED.value,
            OrderStatus.CANCELLED.value,
            OrderStatus.REJECTED.value,
            OrderStatus.EXPIRED.value,
        }
        finalized = False
        final_row: Any | None = None
        while int(time.time() * 1000) < deadline_at:
            row = await self.extended_order_by_id(order_id)
            if row is None:
                await asyncio.sleep(0.1)
                continue
            filled_qty = float(row.filled_qty or 0)
            status = self.order_status_value(row.status)
            if filled_qty > 0:
                saw_fill = True
                if status not in final_statuses:
                    await self.cancel_extended_order(order_id)
                else:
                    finalized = True
                break
            if status not in final_statuses and not row.post_only:
                await self.cancel_all_extended_orders()
                raise RuntimeError(
                    "Extended unfilled maker order lost post-only protection"
                )
            if status in final_statuses:
                finalized = True
                final_row = row
                break
            await asyncio.sleep(0.1)
        else:
            await self.cancel_extended_order(order_id)

        settle_deadline = time.monotonic() + 3
        while time.monotonic() < settle_deadline:
            row = await self.extended_order_by_id(order_id)
            if row is None:
                await asyncio.sleep(0.1)
                continue
            if float(row.filled_qty or 0) > 0:
                saw_fill = True
            if self.order_status_value(row.status) in final_statuses:
                finalized = True
                final_row = row
                break
            await asyncio.sleep(0.1)
        if not finalized:
            await self.cancel_all_extended_orders()
            final_row = None
            final_deadline = time.monotonic() + 3
            while time.monotonic() < final_deadline:
                final_row = await self.extended_order_by_id(order_id)
                if (
                    final_row is not None
                    and self.order_status_value(final_row.status)
                    in final_statuses
                ):
                    break
                await asyncio.sleep(0.1)
            if (
                final_row is not None
                and self.order_status_value(final_row.status)
                in final_statuses
            ):
                saw_fill = (
                    saw_fill or float(final_row.filled_qty or 0) > 0
                )
            else:
                fill = await self.extended_fill(market, order_id)
                open_response = await self.extended.account.get_open_orders(
                    market_names=[market]
                )
                matching_open = [
                    row
                    for row in (open_response.data or [])
                    if int(row.id) == order_id
                ]
                if fill is not None:
                    return MakerFillResult(
                        fill=fill,
                        status="FILLED",
                        reason=None,
                    )
                if not open_response.error and not matching_open:
                    return MakerFillResult(
                        fill=None,
                        status="NOT_FOUND_AFTER_CANCEL",
                        reason=None,
                    )
                raise RuntimeError(
                    "Extended maker remainder cancellation is unconfirmed"
                )
        if not saw_fill:
            return MakerFillResult(
                fill=None,
                status=(
                    self.order_status_value(final_row.status)
                    if final_row is not None
                    else "UNFILLED"
                ),
                reason=(
                    str(getattr(final_row, "status_reason", "") or "") or None
                    if final_row is not None
                    else None
                ),
            )
        fill = await self.extended_fill(market, order_id)
        if fill is None:
            raise RuntimeError("Extended maker fill is missing from trade history")
        return MakerFillResult(
            fill=fill,
            status=(
                self.order_status_value(final_row.status)
                if final_row is not None
                else "FILLED"
            ),
            reason=(
                str(getattr(final_row, "status_reason", "") or "") or None
                if final_row is not None
                else None
            ),
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

    async def wait_extended_position(
        self, coin: str, *, want_open: bool, timeout: float = 6
    ) -> Any | None:
        deadline = time.monotonic() + timeout
        last: Any | None = None
        while time.monotonic() < deadline:
            rows = await self.extended_positions()
            last = next(
                (row for row in rows if row.market == f"{coin}-USD"),
                None,
            )
            if (last is not None) == want_open:
                return last
            await asyncio.sleep(0.1)
        return last

    def current_lighter_hedge_price(
        self, coin: str, side: str
    ) -> float | None:
        status = self.read_json(self.execution_path, {})
        now = int(time.time() * 1000)
        quote = (status.get("closingQuotes") or {}).get(coin) or {}
        price = float(
            quote.get(
                "lighterSellVwap" if side == "buy" else "lighterBuyVwap"
            )
            or 0
        )
        ages = (
            now - int(status.get("updatedAt", 0) or 0),
            float(quote.get("lighterBookAgeMs") or math.inf),
            float(quote.get("lighterSourceAgeMs") or math.inf),
        )
        if (
            status.get("version") != "venue-arb-execution-v2"
            or ages[0] > self.fresh_ms
            or max(ages[1:]) > self.source_fresh_ms
            or price <= 0
        ):
            return None
        return price

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

    def projected_exit(
        self,
        coin: str,
        ext_fill: Fill,
        lit_fill: Fill,
        quantity: float,
    ) -> dict[str, float] | None:
        status = self.read_json(self.execution_path, {})
        now = int(time.time() * 1000)
        if (
            status.get("version") != "venue-arb-execution-v2"
            or now - int(status.get("updatedAt", 0) or 0) > self.fresh_ms
        ):
            return None
        quote = (status.get("closingQuotes") or {}).get(coin) or {}
        ages = (
            float(quote.get("extendedBookAgeMs") or math.inf),
            float(quote.get("lighterBookAgeMs") or math.inf),
        )
        source_ages = (
            float(quote.get("extendedSourceAgeMs") or math.inf),
            float(quote.get("lighterSourceAgeMs") or math.inf),
        )
        if self.buy_venue == "extended":
            ext_exit = float(quote.get("extendedSellVwap") or 0)
            lit_exit = float(quote.get("lighterBuyVwap") or 0)
            entry_buy = ext_fill.price
            entry_sell = lit_fill.price
            exit_buy = ext_exit
            exit_sell = lit_exit
        else:
            ext_exit = float(quote.get("extendedBuyVwap") or 0)
            lit_exit = float(quote.get("lighterSellVwap") or 0)
            entry_buy = lit_fill.price
            entry_sell = ext_fill.price
            exit_buy = lit_exit
            exit_sell = ext_exit
        if (
            max(ages) > self.fresh_ms
            or max(source_ages) > self.source_fresh_ms
            or min(ext_exit, lit_exit) <= 0
        ):
            return None
        estimated_exit_fees = (
            ext_exit * quantity * self.extended_taker_bps / 10_000
        )
        net = projected_net_usd(
            quantity=quantity,
            entry_buy=entry_buy,
            entry_sell=entry_sell,
            exit_buy=exit_buy,
            exit_sell=exit_sell,
            known_entry_fees=ext_fill.fee + lit_fill.fee,
            estimated_exit_fees=estimated_exit_fees,
        )
        return {
            "extendedExitVwap": ext_exit,
            "lighterExitVwap": lit_exit,
            "estimatedExitFeesUsd": estimated_exit_fees,
            "netPnlUsd": net,
            "netPnlPct": net / self.notional * 100,
            "quoteAt": float(status.get("updatedAt", 0) or 0),
        }

    def projected_maker_exit(
        self,
        coin: str,
        *,
        extended_long: bool,
        ext_fill: Fill,
        lit_fill: Fill,
        quantity: float,
    ) -> dict[str, float] | None:
        status = self.read_json(self.execution_path, {})
        now = int(time.time() * 1000)
        if (
            status.get("version") != "venue-arb-execution-v2"
            or now - int(status.get("updatedAt", 0) or 0) > self.fresh_ms
        ):
            return None
        quote = (status.get("closingQuotes") or {}).get(coin) or {}
        ages = (
            float(quote.get("extendedBookAgeMs") or math.inf),
            float(quote.get("lighterBookAgeMs") or math.inf),
        )
        source_ages = (
            float(quote.get("extendedSourceAgeMs") or math.inf),
            float(quote.get("lighterSourceAgeMs") or math.inf),
        )
        if extended_long:
            ext_exit = float(quote.get("extendedSellVwap") or 0)
            lit_exit = float(quote.get("lighterBuyVwap") or 0)
            gross = (
                (ext_exit - ext_fill.price)
                + (lit_fill.price - lit_exit)
            ) * quantity
        else:
            ext_exit = float(quote.get("extendedBuyVwap") or 0)
            lit_exit = float(quote.get("lighterSellVwap") or 0)
            gross = (
                (ext_fill.price - ext_exit)
                + (lit_exit - lit_fill.price)
            ) * quantity
        if (
            max(ages) > self.source_fresh_ms
            or max(source_ages) > self.source_fresh_ms
            or min(ext_exit, lit_exit) <= 0
        ):
            return None
        estimated_exit_fees = (
            ext_exit * quantity * self.extended_taker_bps / 10_000
        )
        net = gross - ext_fill.fee - lit_fill.fee - estimated_exit_fees
        return {
            "extendedExitVwap": ext_exit,
            "lighterExitVwap": lit_exit,
            "estimatedExitFeesUsd": estimated_exit_fees,
            "netPnlUsd": net,
            "netPnlPct": net / max(ext_fill.notional, 1e-9) * 100,
            "quoteAt": float(status.get("updatedAt", 0) or 0),
        }

    async def execute_maker(self, candidate: dict[str, Any]) -> None:
        candidate = await self.revalidate_maker_candidate(candidate)
        if candidate is None:
            self.log("maker_revalidation_skipped", reason=self.last_rejection)
            return
        coin = str(candidate["coin"])
        side = str(candidate["side"])
        extended_long = side == "buy"
        ext_side = OrderSide.BUY if extended_long else OrderSide.SELL
        quantity = self.common_quantity(coin, float(candidate["price"]))
        started_at = int(time.time() * 1000)
        route = (
            "Extended maker long → Lighter short"
            if extended_long
            else "Extended maker short → Lighter long"
        )
        trade: dict[str, Any] = {
            "id": f"M{started_at}",
            "status": "maker_opening",
            "executionMode": self.execution_mode,
            "coin": coin,
            "routeId": self.route_id,
            "route": route,
            "opportunityId": str(candidate["id"]),
            "signalAt": int(candidate.get("monitorUpdatedAt") or started_at),
            "startedAt": started_at,
            "entryNetPct": float(candidate["projectedNetBps"]) / 100,
            "queueAheadUsd": round(float(candidate["queueAheadUsd"]), 4),
            "notionalUsdPerLeg": self.notional,
            "leverage": self.leverage,
            "quantityRequested": float(quantity),
            "makerPrice": float(candidate["price"]),
            "makerSourcePrice": float(candidate["sourcePrice"]),
            "extendedBestBid": float(candidate["extendedBestBid"]),
            "extendedBestAsk": float(candidate["extendedBestAsk"]),
            "makerSafetyTicks": int(candidate["makerSafetyTicks"]),
            "makerSafetyBps": float(candidate["makerSafetyBps"]),
        }
        self.trade_open = True
        self.write_status("maker_opening", activeTrade=trade)
        self.log("maker_submit", **trade)
        submit_started_at = int(time.time() * 1000)
        order_id = await self.place_extended_maker(
            coin, quantity, float(candidate["price"]), ext_side
        )
        trade["entrySubmittedAt"] = submit_started_at
        trade["entryAcceptedAt"] = int(time.time() * 1000)
        trade["entrySubmitLatencyMs"] = (
            trade["entryAcceptedAt"] - submit_started_at
        )
        trade["entryExtendedOrderId"] = order_id
        deadline_at = started_at + self.maker_order_ttl_ms
        maker_result = await self.wait_extended_maker_fill(
            coin, order_id, deadline_at
        )
        ext_fill = maker_result.fill
        if ext_fill is None:
            trade.update(
                status=(
                    "maker_post_only_rejected"
                    if maker_result.reason == "POST_ONLY_FAILED"
                    else "maker_unfilled"
                ),
                makerOrderStatus=maker_result.status,
                makerOrderReason=maker_result.reason,
                closedAt=int(time.time() * 1000),
                netPnlUsd=0,
                netPnlPct=0,
            )
            self.append_trade(trade)
            self.next_maker_attempt_at = (
                int(time.time() * 1000) + self.maker_retry_cooldown_ms
            )
            self.trade_open = False
            if self.shutdown_requested:
                self.running = False
            self.write_status("armed", activeTrade=None, lastTrade=trade)
            self.log("maker_unfilled", **trade)
            return
        if abs(ext_fill.fee) > 1e-9:
            with contextlib.suppress(Exception):
                await self.flatten(coin, emergency=True)
            raise RuntimeError(
                f"Extended maker fill charged a taker fee: {ext_fill.fee}"
            )

        hedge_price = self.current_lighter_hedge_price(coin, side)
        post_fill_net_bps = (
            maker_entry_edge_bps(side, ext_fill.price, hedge_price)
            - self.execution_buffer_bps
            if hedge_price is not None
            else -math.inf
        )
        trade.update(
            entryExtended=asdict(ext_fill),
            postFillLighterHedgePrice=hedge_price,
            postFillNetBps=(
                post_fill_net_bps
                if math.isfinite(post_fill_net_bps)
                else None
            ),
        )
        if post_fill_net_bps < self.entry_net_bps:
            position = await self.wait_extended_position(
                coin, want_open=True, timeout=6
            )
            if position is None:
                raise RuntimeError(
                    "Extended maker fill position is not visible for abort"
                )
            flattened = await self.flatten(coin, emergency=True)
            exit_order_id = flattened.get("extended")
            if not isinstance(exit_order_id, int):
                raise RuntimeError(
                    "Extended stale maker fill abort has no exit order"
                )
            exit_fill = await self.extended_fill(
                f"{coin}-USD", exit_order_id
            )
            if exit_fill is None:
                raise RuntimeError(
                    "Extended stale maker fill abort is missing its fill"
                )
            gross = (
                (exit_fill.price - ext_fill.price) * ext_fill.quantity
                if extended_long
                else (ext_fill.price - exit_fill.price) * ext_fill.quantity
            )
            net = gross - ext_fill.fee - exit_fill.fee
            trade.update(
                status="closed",
                closeReason="post_fill_edge_lost",
                entryExtendedOrderId=order_id,
                exitExtendedOrderId=exit_order_id,
                exitExtended=asdict(exit_fill),
                quantityExecuted=ext_fill.quantity,
                grossPnlUsd=gross,
                feesUsd=ext_fill.fee + exit_fill.fee,
                netPnlUsd=net,
                netPnlPct=net / max(ext_fill.notional, 1e-9) * 100,
                closedAt=int(time.time() * 1000),
            )
            self.append_trade(trade)
            self.trade_open = False
            if self.shutdown_requested:
                self.running = False
            self.write_status("completed", activeTrade=None, lastTrade=trade)
            self.log("maker_fill_aborted", **trade)
            return

        try:
            hedge_quantity = self.lighter_compatible_quantity(
                coin, ext_fill.quantity
            )
        except Exception:
            with contextlib.suppress(Exception):
                await self.flatten(coin, emergency=True)
            raise
        hedge_started = int(time.time() * 1000)
        lit_order = await self.place_lighter(
            coin,
            hedge_quantity,
            is_ask=extended_long,
            reduce_only=False,
            slippage=self.entry_slippage,
        )
        lit_fill = await self.lighter_fill(coin, lit_order)
        positions = await self.wait_positions(coin, want_open=True, timeout=4)
        ext_position, lit_position = positions
        ext_position_side = str(
            getattr(ext_position, "side", "")
        ).upper()
        lit_sign = int((lit_position or {}).get("sign", 0))
        expected_ext_side = "LONG" if extended_long else "SHORT"
        expected_lit_sign = -1 if extended_long else 1
        if (
            lit_fill is None
            or ext_position is None
            or lit_position is None
            or ext_position_side != expected_ext_side
            or lit_sign != expected_lit_sign
            or abs(ext_fill.quantity - lit_fill.quantity)
            > max(ext_fill.quantity, lit_fill.quantity) * 0.002
        ):
            with contextlib.suppress(Exception):
                await self.flatten(coin, emergency=True)
            trade.update(
                status="failed_flat",
                closedAt=int(time.time() * 1000),
                error="maker fill hedge did not reconcile",
                entryExtended=asdict(ext_fill),
                entryLighter=asdict(lit_fill) if lit_fill else None,
                netPnlUsd=0,
            )
            self.append_trade(trade)
            self.trade_open = False
            self.write_status("blocked", activeTrade=None, lastTrade=trade)
            return

        opened_at = max(
            ext_fill.filled_at or started_at,
            lit_fill.filled_at or hedge_started,
        )
        trade.update(
            status="open",
            openedAt=opened_at,
            makerToHedgeMs=max(0, hedge_started - (ext_fill.filled_at or started_at)),
            entryLatencyMs=opened_at - started_at,
            quantity=float(hedge_quantity),
            entryExtended=asdict(ext_fill),
            entryLighter=asdict(lit_fill),
        )
        self.write_status("open", activeTrade=trade)
        self.log("maker_hedged", **trade)
        profit_confirmations = 0
        projected: dict[str, float] | None = None
        last_profit_quote_at = 0.0
        actual_notional = min(ext_fill.notional, lit_fill.notional)
        minimum_profit_usd = (
            actual_notional * self.exit_min_profit_bps / 10_000
        )
        maximum_loss_usd = (
            actual_notional * self.max_adverse_bps / 10_000
        )
        while True:
            now = int(time.time() * 1000)
            projected = self.projected_maker_exit(
                coin,
                extended_long=extended_long,
                ext_fill=ext_fill,
                lit_fill=lit_fill,
                quantity=float(hedge_quantity),
            )
            if now - opened_at >= self.max_hold_ms:
                close_reason = "max_hold"
                break
            if (
                projected is not None
                and projected["netPnlUsd"] <= -maximum_loss_usd
            ):
                close_reason = "adverse_basis"
                break
            if (
                projected is not None
                and projected["netPnlUsd"] >= minimum_profit_usd
                and projected["quoteAt"] > last_profit_quote_at
            ):
                profit_confirmations += 1
                last_profit_quote_at = projected["quoteAt"]
            elif (
                projected is None
                or projected["netPnlUsd"] < minimum_profit_usd
            ):
                profit_confirmations = 0
            if profit_confirmations >= self.exit_confirmations:
                close_reason = "projected_net_profit"
                break
            if (
                self.shutdown_requested
                and time.monotonic() - self.last_status_write >= 1
            ):
                self.write_status(
                    "shutdown_pending_flatten",
                    activeTrade={
                        **trade,
                        "projectedExit": projected,
                        "minimumProfitUsd": minimum_profit_usd,
                    },
                )
            await asyncio.sleep(0.05)

        close_started = int(time.time() * 1000)
        self.write_status(
            "closing", activeTrade={**trade, "closeReason": close_reason}
        )
        exit_orders = await self.flatten(coin, emergency=False)
        ext_exit, lit_exit = await asyncio.gather(
            self.extended_fill(
                f"{coin}-USD", exit_orders["extended"]
            ),
            self.lighter_fill(coin, exit_orders["lighter"]),
        )
        if ext_exit is None or lit_exit is None:
            raise RuntimeError("maker exit fills missing after flat confirmation")
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
        if extended_long:
            gross = (
                (ext_exit.price - ext_fill.price)
                + (lit_fill.price - lit_exit.price)
            ) * quantity_done
        else:
            gross = (
                (ext_fill.price - ext_exit.price)
                + (lit_exit.price - lit_fill.price)
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
            projectedExit=projected,
            exitExtended=asdict(ext_exit),
            exitLighter=asdict(lit_exit),
            grossPnlUsd=round(gross, 8),
            feesUsd=round(fees, 8),
            netPnlUsd=round(net, 8),
            netPnlPct=round(net / max(actual_notional, 1e-9) * 100, 8),
        )
        self.append_trade(trade)
        self.trade_open = False
        if self.shutdown_requested:
            self.running = False
        self.write_status("completed", activeTrade=None, lastTrade=trade)
        self.log("maker_trade_closed", **trade)

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
            "routeId": self.route_id,
            "route": self.route_label,
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
        extended_is_buy = self.buy_venue == "extended"
        entry_tasks = {
            "extended": asyncio.create_task(
                self.place_extended(
                    coin,
                    quantity,
                    float(
                        candidate[
                            "currentBuyVwap1000"
                            if extended_is_buy
                            else "currentSellVwap1000"
                        ]
                    ),
                    OrderSide.BUY if extended_is_buy else OrderSide.SELL,
                    reduce_only=False,
                    slippage=self.entry_slippage,
                )
            ),
            "lighter": asyncio.create_task(
                self.place_lighter(
                    coin,
                    quantity,
                    is_ask=self.sell_venue == "lighter",
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
        ext_position, lit_position = positions
        ext_side = str(getattr(ext_position, "side", "")).upper()
        lit_sign = int((lit_position or {}).get("sign", 0))
        expected_ext_side = "LONG" if extended_is_buy else "SHORT"
        expected_lit_sign = -1 if extended_is_buy else 1
        if (
            ext_fill is None
            or lit_fill is None
            or ext_position is None
            or lit_position is None
            or ext_side != expected_ext_side
            or lit_sign != expected_lit_sign
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
        profit_confirmations = 0
        projected: dict[str, float] | None = None
        last_profit_quote_at = 0.0
        minimum_profit_usd = self.notional * self.exit_min_profit_bps / 10_000
        while True:
            now = int(time.time() * 1000)
            if now - opened_at >= self.max_hold_ms:
                close_reason = "max_hold"
                break
            projected = self.projected_exit(
                coin, ext_fill, lit_fill, quantity=float(quantity)
            )
            if (
                projected is not None
                and projected["netPnlUsd"] >= minimum_profit_usd
                and projected["quoteAt"] > last_profit_quote_at
            ):
                profit_confirmations += 1
                last_profit_quote_at = projected["quoteAt"]
            elif (
                projected is None
                or projected["netPnlUsd"] < minimum_profit_usd
            ):
                profit_confirmations = 0
            if profit_confirmations >= self.exit_confirmations:
                close_reason = "projected_net_profit"
                break
            if now - opened_at >= self.min_hold_ms:
                current_net = self.opportunity_net(opportunity_id)
                if (
                    current_net is not None
                    and current_net
                    >= float(candidate["currentNetBps1000"])
                    + self.max_adverse_bps
                ):
                    close_reason = "adverse_basis"
                    break
            if (
                self.shutdown_requested
                and time.monotonic() - self.last_status_write >= 1
            ):
                self.write_status(
                    "shutdown_pending_profit",
                    activeTrade={
                        **trade,
                        "projectedExit": projected,
                        "minimumProfitUsd": minimum_profit_usd,
                    },
                )
            await asyncio.sleep(0.05)
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
        if extended_is_buy:
            gross = (
                (ext_exit.price - ext_fill.price)
                + (lit_fill.price - lit_exit.price)
            ) * quantity_done
        else:
            gross = (
                (lit_exit.price - lit_fill.price)
                + (ext_fill.price - ext_exit.price)
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
            projectedExit=projected,
            exitExtended=asdict(ext_exit),
            exitLighter=asdict(lit_exit),
            grossPnlUsd=round(gross, 8),
            feesUsd=round(fees, 8),
            netPnlUsd=round(net, 8),
            netPnlPct=round(net / self.notional * 100, 8),
        )
        self.append_trade(trade)
        self.trade_open = False
        if self.shutdown_requested:
            self.running = False
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
        order = (
            self.create_extended_maker_order(
                "BTC", quantity, reference * 0.99, OrderSide.BUY
            )
            if self.execution_mode == "maker-taker"
            else self.create_extended_order(
                "BTC",
                quantity,
                reference,
                OrderSide.BUY,
                reduce_only=False,
                slippage=self.entry_slippage,
            )
        )
        if not order.settlement or not order.settlement.signature:
            raise RuntimeError("Extended signature was not created")
        self.write_status(
            "sign_test_ready",
            signedOrder={
                "market": "BTC-USD",
                "type": str(order.type),
                "postOnly": order.post_only,
                "timeInForce": str(order.time_in_force),
                "quantity": float(quantity),
            },
        )
        self.log(
            "sign_test_ready",
            market="BTC-USD",
            quantity=float(quantity),
            execution_mode=self.execution_mode,
            post_only=order.post_only,
        )

    async def run(self) -> None:
        self.acquire_lock()
        await self.preflight()
        if not self.enabled:
            self.write_status("dry_run_ready", reason=None, error=None)
            self.log("dry_run_ready")
            return
        if len(self.completed_mode_trades()) >= self.max_trades:
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
            if len(self.completed_mode_trades()) >= self.max_trades:
                self.write_status("completed", reason="max trade count reached")
                return
            candidate = (
                self.maker_candidate()
                if self.execution_mode == "maker-taker"
                else self.candidate()
            )
            if candidate:
                if self.execution_mode == "maker-taker":
                    await self.execute_maker(candidate)
                    if len(self.completed_mode_trades()) >= self.max_trades:
                        return
                else:
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
    assert round(maker_entry_edge_bps("buy", 100, 101), 8) == 100
    assert round(maker_entry_edge_bps("sell", 101, 100), 8) == 100
    assert safer_maker_price(
        side="buy",
        candidate_price=100.09,
        best_bid=100,
        best_ask=100.1,
        tick=0.01,
        safety_ticks=5,
        safety_bps=2,
    ) == 100.05
    assert safer_maker_price(
        side="sell",
        candidate_price=100.01,
        best_bid=100,
        best_ask=100.1,
        tick=0.01,
        safety_ticks=5,
        safety_bps=2,
    ) == 100.05
    reproduced_loss = projected_net_usd(
        quantity=0.52,
        entry_buy=572.5,
        entry_sell=573.0972,
        exit_buy=572.46,
        exit_sell=573.2286461538461,
        known_entry_fees=0.074425,
        estimated_exit_fees=0.074419,
    )
    assert round(reproduced_loss, 6) == -0.237996
    reverse_profit = projected_net_usd(
        quantity=1,
        entry_buy=100,
        entry_sell=100.20,
        exit_buy=100.10,
        exit_sell=100.10,
        known_entry_fees=0.02505,
        estimated_exit_fees=0.025025,
    )
    assert round(reverse_profit, 6) == 0.149925
    route_guard = object.__new__(Canary)
    route_guard.route_id = "lighter-extended"
    route_guard.route_label = "Lighter → Extended"
    route_guard.trades = lambda: [
        {
            "status": "closed",
            "route": "Extended → Lighter",
        },
        {
            "status": "closed",
            "routeId": "lighter-extended",
            "route": "Lighter → Extended",
        },
    ]
    assert len(route_guard.completed_route_trades()) == 1
    signal_guard = object.__new__(Canary)
    signal_guard.running = True
    signal_guard.shutdown_requested = False
    signal_guard.trade_open = True
    signal_guard.log = lambda *_args, **_kwargs: None
    signal_guard.request_shutdown()
    assert signal_guard.shutdown_requested is True
    assert signal_guard.running is True
    signal_guard.trade_open = False
    signal_guard.request_shutdown()
    assert signal_guard.running is False
    print("venue-arb-live self-test ok")


async def main(force_dry_run: bool, sign_test: bool) -> None:
    runner = Canary(force_dry_run=force_dry_run)
    loop = asyncio.get_running_loop()
    for name in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(name, runner.request_shutdown)
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
                if runner.extended is not None:
                    await runner.cancel_all_extended_orders()
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

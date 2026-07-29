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
import statistics
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
    "LIT": 120,
    "XMR": 77,
    "NEAR": 10,
    "CRV": 36,
    "FARTCOIN": 21,
    "PUMP": 45,
    "WTI": 145,
    "XAU": 92,
    "XAG": 93,
    "ZEC": 90,
    "EUR": 96,
    "ENA": 29,
    "AAVE": 27,
    "JUP": 26,
    "UNI": 30,
    "XPL": 71,
}

ROUTES: dict[str, tuple[str, str, str]] = {
    "extended-lighter": ("extended", "lighter", "Extended → Lighter"),
    "lighter-extended": ("lighter", "extended", "Lighter → Extended"),
}
OPPOSITE_ROUTE: dict[str, str] = {
    "extended-lighter": "lighter-extended",
    "lighter-extended": "extended-lighter",
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


def competitive_maker_price(
    side: str,
    edge_limit_price: float,
) -> float:
    if (
        side not in {"buy", "sell"}
        or edge_limit_price <= 0
    ):
        return math.nan
    # The public-trade price that activated the monitor quote can already be
    # several ticks behind by the time the signed order reaches Extended.
    # Quote at the most competitive price that still preserves the configured
    # net edge; safer_maker_price() below keeps it strictly post-only.
    return edge_limit_price


def projected_net_usd(
    *,
    quantity: float,
    entry_buy: float,
    entry_sell: float,
    exit_buy: float,
    exit_sell: float,
    known_entry_fees: float,
    estimated_exit_fees: float,
    execution_buffer_usd: float = 0.0,
    funding_reserve_usd: float = 0.0,
) -> float:
    gross = (
        (exit_buy - entry_buy)
        + (entry_sell - exit_sell)
    ) * quantity
    return (
        gross
        - known_entry_fees
        - estimated_exit_fees
        - execution_buffer_usd
        - funding_reserve_usd
    )


def modeled_funding_reserve_usd(
    *,
    notional_usd: float,
    holding_ms: int,
    funding_bps_per_hour: float,
) -> float:
    return (
        max(0.0, notional_usd)
        * max(0, holding_ms)
        / 3_600_000
        * max(0.0, funding_bps_per_hour)
        / 10_000
    )


def finite_float(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def candidate_quote_version(
    snapshot_at: int,
    row: dict[str, Any],
) -> str:
    buy_age = finite_float(row.get("currentBuyBookAgeMs"), math.inf)
    sell_age = finite_float(row.get("currentSellBookAgeMs"), math.inf)
    if not math.isfinite(buy_age) or not math.isfinite(sell_age):
        return ""
    return (
        f"{round(snapshot_at - buy_age)}:"
        f"{round(snapshot_at - sell_age)}"
    )


def advance_entry_confirmations(
    *,
    candidate_id: str,
    quote_version: str,
    pending_candidate_id: str | None,
    pending_quote_version: str | None,
    pending_confirmations: int,
) -> tuple[str, str | None, int]:
    if candidate_id != pending_candidate_id:
        pending_candidate_id = candidate_id
        pending_quote_version = None
        pending_confirmations = 0
    if quote_version and quote_version != pending_quote_version:
        pending_quote_version = quote_version
        pending_confirmations += 1
    return (
        pending_candidate_id,
        pending_quote_version,
        pending_confirmations,
    )


def calibrated_basis_deviation(
    *,
    samples: list[tuple[int, float]],
    now: int,
    current_bps: float,
    window_ms: int,
    exclude_ms: int,
    min_samples: int,
    min_span_ms: int,
) -> dict[str, float] | None:
    eligible = [
        (at, value)
        for at, value in samples
        if now - window_ms <= at <= now - exclude_ms
        and math.isfinite(value)
    ]
    if len(eligible) < min_samples:
        return None
    span_ms = eligible[-1][0] - eligible[0][0]
    if span_ms < min_span_ms:
        return None
    baseline_bps = float(statistics.median(value for _, value in eligible))
    return {
        "baselineBps": baseline_bps,
        "deviationBps": current_bps - baseline_bps,
        "samples": float(len(eligible)),
        "spanMs": float(span_ms),
    }


def executable_basis_bps(
    quote: dict[str, Any],
    route_id: str,
) -> float | None:
    if route_id == "extended-lighter":
        buy = finite_float(quote.get("extendedBuyVwap"), 0)
        sell = finite_float(quote.get("lighterSellVwap"), 0)
    elif route_id == "lighter-extended":
        buy = finite_float(quote.get("lighterBuyVwap"), 0)
        sell = finite_float(quote.get("extendedSellVwap"), 0)
    else:
        return None
    if min(buy, sell) <= 0:
        return None
    return (sell / buy - 1) * 10_000


class Canary:
    def __init__(self, *, force_dry_run: bool = False) -> None:
        self.enabled = (
            os.getenv("VENUE_ARB_LIVE_ENABLED", "false").lower() == "true"
            and not force_dry_run
        )
        self.execution_mode = os.getenv(
            "VENUE_ARB_LIVE_EXECUTION", "taker-taker"
        ).strip().lower()
        self.execution_region = os.getenv(
            "VENUE_ARB_LIVE_REGION", ""
        ).strip()
        if self.execution_mode not in {"taker-taker", "maker-taker"}:
            raise RuntimeError(
                f"unsupported VENUE_ARB_LIVE_EXECUTION={self.execution_mode!r}"
            )
        self.route_id = os.getenv(
            "VENUE_ARB_LIVE_ROUTE", "extended-lighter"
        ).strip().lower()
        if (
            self.execution_mode == "taker-taker"
            and self.route_id not in {*ROUTES, "both"}
        ):
            raise RuntimeError(
                f"unsupported VENUE_ARB_LIVE_ROUTE={self.route_id!r}"
            )
        if self.execution_mode == "maker-taker":
            self.route_id = "extended-maker-lighter"
            self.buy_venue = "extended"
            self.sell_venue = "lighter"
            self.route_label = "Extended maker ↔ Lighter taker"
            self.live_routes = ("extended-lighter",)
        elif self.route_id == "both":
            self.buy_venue = ""
            self.sell_venue = ""
            self.route_label = "Extended ↔ Lighter"
            self.live_routes = tuple(ROUTES)
        else:
            self.buy_venue, self.sell_venue, self.route_label = ROUTES[self.route_id]
            self.live_routes = (self.route_id,)
        allowed_coins = {
            coin.strip().upper()
            for coin in os.getenv("VENUE_ARB_LIVE_ALLOWED_COINS", "").split(",")
            if coin.strip()
        }
        unknown_coins = allowed_coins - MARKETS.keys()
        if unknown_coins:
            raise RuntimeError(
                "unsupported VENUE_ARB_LIVE_ALLOWED_COINS="
                + ",".join(sorted(unknown_coins))
            )
        self.allowed_coins = allowed_coins or set(MARKETS)
        self.notional = float(os.getenv("VENUE_ARB_LIVE_NOTIONAL_USD", "300"))
        self.leverage = int(os.getenv("VENUE_ARB_LIVE_LEVERAGE", "5"))
        self.entry_net_bps = float(os.getenv("VENUE_ARB_LIVE_ENTRY_NET_BPS", "15"))
        self.basis_gate_enabled = (
            os.getenv("VENUE_ARB_LIVE_BASIS_GATE_ENABLED", "true").lower()
            == "true"
        )
        self.basis_window_ms = int(
            float(os.getenv("VENUE_ARB_LIVE_BASIS_WINDOW_SECONDS", "1800"))
            * 1000
        )
        self.basis_exclude_ms = int(
            float(os.getenv("VENUE_ARB_LIVE_BASIS_EXCLUDE_SECONDS", "5"))
            * 1000
        )
        self.basis_min_samples = int(
            os.getenv("VENUE_ARB_LIVE_BASIS_MIN_SAMPLES", "120")
        )
        self.basis_min_span_ms = int(
            float(os.getenv("VENUE_ARB_LIVE_BASIS_MIN_SPAN_SECONDS", "120"))
            * 1000
        )
        self.basis_min_deviation_bps = float(
            os.getenv(
                "VENUE_ARB_LIVE_BASIS_MIN_DEVIATION_BPS",
                str(self.entry_net_bps),
            )
        )
        if (
            self.basis_window_ms <= self.basis_exclude_ms
            or self.basis_exclude_ms < 0
            or self.basis_min_samples < 1
            or self.basis_min_span_ms < 0
            or self.basis_min_deviation_bps < 0
        ):
            raise RuntimeError("invalid live basis calibration settings")
        self.entry_confirmations = int(
            os.getenv("VENUE_ARB_LIVE_ENTRY_CONFIRMATIONS", "3")
        )
        if self.entry_confirmations < 1:
            raise RuntimeError(
                "VENUE_ARB_LIVE_ENTRY_CONFIRMATIONS must be positive"
            )
        self.maker_cancel_net_bps = float(
            os.getenv(
                "VENUE_ARB_LIVE_MAKER_CANCEL_NET_BPS",
                str(self.entry_net_bps),
            )
        )
        self.post_fill_net_bps = float(
            os.getenv(
                "VENUE_ARB_LIVE_POST_FILL_NET_BPS",
                str(self.entry_net_bps),
            )
        )
        if not (
            self.entry_net_bps
            >= self.maker_cancel_net_bps
            >= self.post_fill_net_bps
            >= 0
        ):
            raise RuntimeError(
                "maker thresholds must satisfy "
                "entry >= cancel >= post-fill >= 0"
            )
        self.exit_min_profit_bps = float(
            os.getenv("VENUE_ARB_LIVE_EXIT_MIN_PROFIT_BPS", "10")
        )
        self.exit_confirmations = int(
            os.getenv("VENUE_ARB_LIVE_EXIT_CONFIRMATIONS", "3")
        )
        self.extended_taker_bps = float(
            os.getenv("VENUE_ARB_LIVE_EXTENDED_TAKER_BPS", "2.5")
        )
        self.lighter_taker_bps = float(
            os.getenv("VENUE_ARB_LIVE_LIGHTER_TAKER_BPS", "0")
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
        self.max_loss_usd = float(
            os.getenv(
                "VENUE_ARB_LIVE_MAX_LOSS_USD",
                str(self.notional * self.max_adverse_bps / 10_000),
            )
        )
        if self.max_loss_usd <= 0:
            raise RuntimeError("VENUE_ARB_LIVE_MAX_LOSS_USD must be positive")
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
        self.funding_bps_per_hour = float(
            os.getenv("VENUE_ARB_LIVE_FUNDING_BPS_PER_HOUR", "1")
        )
        if self.funding_bps_per_hour < 0:
            raise RuntimeError(
                "VENUE_ARB_LIVE_FUNDING_BPS_PER_HOUR must be non-negative"
            )
        self.maker_retry_cooldown_ms = int(
            os.getenv("VENUE_ARB_LIVE_MAKER_RETRY_COOLDOWN_MS", "5000")
        )
        self.cooldown_ms = int(
            float(os.getenv("VENUE_ARB_LIVE_COOLDOWN_SECONDS", "900")) * 1000
        )
        self.max_trades = int(os.getenv("VENUE_ARB_LIVE_MAX_TRADES", "1"))
        self.required_maker_shadow_passes = int(
            os.getenv("VENUE_ARB_LIVE_REQUIRE_MAKER_SHADOW_PASSES", "0")
        )
        if self.required_maker_shadow_passes < 0:
            raise RuntimeError(
                "VENUE_ARB_LIVE_REQUIRE_MAKER_SHADOW_PASSES must be non-negative"
            )
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
        self.basis_path = self.data_dir / "basis-calibration-v1.json"
        self.lock_path = self.data_dir / "live.lock"
        self.running = True
        self.shutdown_requested = False
        self.trade_open = False
        self.active_trade: dict[str, Any] | None = None
        self.last_order_id = int(time.time() * 1000)
        self.last_status_write = 0.0
        self.last_rejection: str | None = None
        self.last_basis_snapshot_at = 0
        self.last_basis_write_at = 0
        self.basis_samples: dict[str, list[tuple[int, float]]] = {}
        self.basis_gate_status: dict[str, Any] = {}
        self.load_basis_samples()
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
            "executionRegion": self.execution_region or None,
            "notionalUsdPerLeg": self.notional,
            "leverage": self.leverage,
            "entryNetPct": self.entry_net_bps / 100,
            "entryConfirmations": self.entry_confirmations,
            "basisGate": {
                "enabled": self.basis_gate_enabled,
                "windowSeconds": self.basis_window_ms / 1000,
                "excludeRecentSeconds": self.basis_exclude_ms / 1000,
                "minSamples": self.basis_min_samples,
                "minSpanSeconds": self.basis_min_span_ms / 1000,
                "minDeviationPct": self.basis_min_deviation_bps / 100,
                "roundTripCostPct": (
                    self.basis_round_trip_cost_bps() / 100
                ),
                "current": self.basis_gate_status,
            },
            "makerCancelNetPct": self.maker_cancel_net_bps / 100,
            "postFillNetPct": self.post_fill_net_bps / 100,
            "exitMinProfitPct": self.exit_min_profit_bps / 100,
            "exitConfirmations": self.exit_confirmations,
            "executionBufferPct": self.execution_buffer_bps / 100,
            "fundingReservePctPerHour": self.funding_bps_per_hour / 100,
            "maxLossUsd": self.max_loss_usd,
            "shutdownDeferredWhenOpen": True,
            "routeId": self.route_id,
            "route": self.route_label,
            "allowedCoins": sorted(self.allowed_coins),
            "maxTrades": self.max_trades,
            "makerShadowRequiredPasses": self.required_maker_shadow_passes,
            "makerShadowObservedPasses": self.maker_shadow_pass_count(),
            "lastRejection": self.last_rejection,
            "reason": None,
            "error": None,
            **fields,
        }
        self.atomic_json(self.status_path, payload)
        self.last_status_write = time.monotonic()

    def load_basis_samples(self) -> None:
        checkpoint = self.read_json(self.basis_path, {})
        if not isinstance(checkpoint, dict):
            return
        now = int(time.time() * 1000)
        cutoff = now - self.basis_window_ms
        rows = checkpoint.get("samples")
        if not isinstance(rows, dict):
            return
        checkpoint_route = str(
            checkpoint.get("routeId") or "extended-lighter"
        )
        for sample_key, values in rows.items():
            if not isinstance(values, list):
                continue
            if ":" in sample_key:
                route_id, coin = sample_key.split(":", 1)
            else:
                route_id, coin = checkpoint_route, sample_key
            if route_id not in ROUTES or coin not in MARKETS:
                continue
            parsed: list[tuple[int, float]] = []
            for value in values:
                if not isinstance(value, list) or len(value) != 2:
                    continue
                at = int(finite_float(value[0], 0))
                basis = finite_float(value[1], math.nan)
                if at >= cutoff and math.isfinite(basis):
                    parsed.append((at, basis))
            if parsed:
                self.basis_samples[f"{route_id}:{coin}"] = sorted(parsed)

    def persist_basis_samples(self, now: int) -> None:
        if now - self.last_basis_write_at < 1000:
            return
        self.atomic_json(
            self.basis_path,
            {
                "version": "basis-calibration-v2",
                "updatedAt": now,
                "routeId": self.route_id,
                "samples": self.basis_samples,
            },
        )
        self.last_basis_write_at = now

    def observe_basis(
        self,
        status: dict[str, Any],
        now: int,
    ) -> None:
        snapshot_at = int(status.get("updatedAt", 0) or 0)
        if snapshot_at <= self.last_basis_snapshot_at:
            return
        cutoff = now - self.basis_window_ms
        closing = status.get("closingQuotes") or {}
        for coin in self.allowed_coins:
            quote = closing.get(coin) or {}
            ages = (
                finite_float(quote.get("extendedBookAgeMs"), math.inf),
                finite_float(quote.get("lighterBookAgeMs"), math.inf),
                finite_float(quote.get("extendedSourceAgeMs"), math.inf),
                finite_float(quote.get("lighterSourceAgeMs"), math.inf),
            )
            if max(ages) > self.source_fresh_ms:
                continue
            for route_id in ROUTES:
                raw_bps = executable_basis_bps(quote, route_id)
                if raw_bps is None:
                    continue
                sample_key = f"{route_id}:{coin}"
                values = self.basis_samples.setdefault(sample_key, [])
                values.append((snapshot_at, raw_bps))
                self.basis_samples[sample_key] = [
                    value for value in values if value[0] >= cutoff
                ]
        self.last_basis_snapshot_at = snapshot_at
        self.persist_basis_samples(now)

    def basis_candidate_metrics(
        self,
        *,
        route_id: str,
        coin: str,
        status: dict[str, Any],
        now: int,
    ) -> dict[str, float] | None:
        quote = (status.get("closingQuotes") or {}).get(coin) or {}
        current_bps = executable_basis_bps(quote, route_id)
        if current_bps is None:
            return None
        entry = calibrated_basis_deviation(
            samples=self.basis_samples.get(f"{route_id}:{coin}", []),
            now=now,
            current_bps=current_bps,
            window_ms=self.basis_window_ms,
            exclude_ms=self.basis_exclude_ms,
            min_samples=self.basis_min_samples,
            min_span_ms=self.basis_min_span_ms,
        )
        opposite_route = OPPOSITE_ROUTE[route_id]
        exit_basis = executable_basis_bps(quote, opposite_route)
        if entry is None or exit_basis is None:
            return None
        exit_metrics = calibrated_basis_deviation(
            samples=self.basis_samples.get(
                f"{opposite_route}:{coin}",
                [],
            ),
            now=now,
            current_bps=exit_basis,
            window_ms=self.basis_window_ms,
            exclude_ms=self.basis_exclude_ms,
            min_samples=self.basis_min_samples,
            min_span_ms=self.basis_min_span_ms,
        )
        if exit_metrics is None:
            return None
        return {
            **entry,
            "currentBps": current_bps,
            "exitBaselineBps": exit_metrics["baselineBps"],
            "expectedNetBps": (
                current_bps
                + exit_metrics["baselineBps"]
                - self.basis_round_trip_cost_bps()
            ),
        }

    def basis_round_trip_cost_bps(self) -> float:
        return (
            2 * self.extended_taker_bps
            + 2 * self.lighter_taker_bps
            + self.execution_buffer_bps
        )

    def basis_expected_net_bps(
        self,
        metrics: dict[str, float] | None,
    ) -> float:
        if metrics is None:
            return -math.inf
        return metrics["expectedNetBps"]

    def request_shutdown(self) -> None:
        self.shutdown_requested = True
        self.log("shutdown_requested", trade_open=self.trade_open)
        if not self.trade_open:
            self.running = False

    def append_trade(self, row: dict[str, Any]) -> None:
        rows = self.trades()
        rows.append(row)
        self.atomic_json(self.trades_path, rows[-500:])

    async def recover_active_trade(
        self,
        error: Exception,
        exit_orders: dict[str, int],
    ) -> None:
        trade = self.active_trade
        if trade is None or any(
            row.get("id") == trade.get("id") for row in self.trades()
        ):
            self.active_trade = None
            return
        coin = str(trade.get("coin") or "")
        if coin not in MARKETS:
            return
        entry_ext_id = trade.get("entryExtendedOrderId")
        entry_lit_id = trade.get("entryLighterOrderId")
        exit_ext_id = (
            trade.get("exitExtendedOrderId")
            or exit_orders.get("extended")
        )
        exit_lit_id = (
            trade.get("exitLighterOrderId")
            or exit_orders.get("lighter")
        )
        tasks: dict[str, Any] = {}
        if isinstance(entry_ext_id, int):
            tasks["entryExtended"] = asyncio.create_task(
                self.extended_fill(f"{coin}-USD", entry_ext_id)
            )
        if isinstance(entry_lit_id, int):
            tasks["entryLighter"] = asyncio.create_task(
                self.lighter_fill(coin, entry_lit_id)
            )
        if isinstance(exit_ext_id, int):
            tasks["exitExtended"] = asyncio.create_task(
                self.extended_fill(f"{coin}-USD", exit_ext_id)
            )
        if isinstance(exit_lit_id, int):
            tasks["exitLighter"] = asyncio.create_task(
                self.lighter_fill(coin, exit_lit_id)
            )
        results = (
            await asyncio.gather(*tasks.values())
            if tasks
            else []
        )
        fills = dict(zip(tasks.keys(), results, strict=True))
        entry_ext = fills.get("entryExtended")
        entry_lit = fills.get("entryLighter")
        exit_ext = fills.get("exitExtended")
        exit_lit = fills.get("exitLighter")
        if entry_ext is None and entry_lit is None:
            self.active_trade = None
            return

        extended_long = str(trade.get("extendedSide")) == "long"
        gross = 0.0
        fees = 0.0
        complete = True
        if entry_ext is not None:
            fees += entry_ext.fee
            if exit_ext is None:
                complete = False
            else:
                quantity = min(entry_ext.quantity, exit_ext.quantity)
                gross += (
                    (exit_ext.price - entry_ext.price) * quantity
                    if extended_long
                    else (entry_ext.price - exit_ext.price) * quantity
                )
                fees += exit_ext.fee
        if entry_lit is not None:
            fees += entry_lit.fee
            if exit_lit is None:
                complete = False
            else:
                quantity = min(entry_lit.quantity, exit_lit.quantity)
                gross += (
                    (entry_lit.price - exit_lit.price) * quantity
                    if extended_long
                    else (exit_lit.price - entry_lit.price) * quantity
                )
                fees += exit_lit.fee
        net = gross - fees
        closed_at = max(
            [
                int(fill.filled_at or 0)
                for fill in (exit_ext, exit_lit)
                if fill is not None
            ]
            or [int(time.time() * 1000)]
        )
        notional = max(
            [
                fill.notional
                for fill in (entry_ext, entry_lit)
                if fill is not None
            ]
            or [self.notional]
        )
        trade.update(
            status="failed_flat" if complete else "recovery_incomplete",
            closeReason="fatal_recovery",
            entryExtended=asdict(entry_ext) if entry_ext else None,
            entryLighter=asdict(entry_lit) if entry_lit else None,
            exitExtended=asdict(exit_ext) if exit_ext else None,
            exitLighter=asdict(exit_lit) if exit_lit else None,
            exitExtendedOrderId=exit_ext_id,
            exitLighterOrderId=exit_lit_id,
            grossPnlUsd=round(gross, 8) if complete else None,
            feesUsd=round(fees, 8),
            netPnlUsd=round(net, 8) if complete else None,
            netPnlPct=(
                round(net / max(notional, 1e-9) * 100, 8)
                if complete
                else None
            ),
            closedAt=closed_at,
            holdingMs=max(
                0,
                closed_at
                - int(
                    (entry_ext or entry_lit).filled_at
                    or trade.get("startedAt")
                    or closed_at
                ),
            ),
            error=str(error),
        )
        self.append_trade(trade)
        self.log("fatal_recovered", **trade)
        self.active_trade = None

    def completed_trades(self) -> list[dict[str, Any]]:
        return [
            row
            for row in self.trades()
            if row.get("status") in {"closed", "failed_flat"}
        ]

    def completed_route_trades(self) -> list[dict[str, Any]]:
        route_ids = (
            set(self.live_routes)
            if self.route_id == "both"
            else {self.route_id}
        )
        route_labels = {
            ROUTES[route_id][2].lower()
            for route_id in route_ids
            if route_id in ROUTES
        }
        return [
            row
            for row in self.completed_trades()
            if row.get("routeId") in route_ids
            or (
                not row.get("routeId")
                and str(row.get("route") or "").lower()
                in route_labels
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

    def maker_shadow_pass_count(self) -> int:
        if self.execution_mode != "maker-taker":
            return self.required_maker_shadow_passes
        status = self.read_json(self.monitor_path, {})
        recent = (
            ((status.get("makerShadow") or {}).get("recent") or [])
            if isinstance(status, dict)
            else []
        )
        accepted_reasons = {"maker_round_trip", "max_hold_taker_exit"}
        return sum(
            1
            for row in recent
            if isinstance(row, dict)
            and row.get("passed") is True
            and row.get("reason") in accepted_reasons
            and float(row.get("realizedNetBps") or 0) > 0
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
        self.observe_basis(status, now)
        eligible = []
        basis_by_route_coin = {
            (route_id, coin): self.basis_candidate_metrics(
                route_id=route_id,
                coin=coin,
                status=status,
                now=now,
            )
            for route_id in self.live_routes
            for coin in self.allowed_coins
        }
        basis_ready_coins = sum(
            all(
                basis_by_route_coin.get((route_id, coin)) is not None
                for route_id in self.live_routes
            )
            for coin in self.allowed_coins
        )
        best_basis: dict[str, Any] | None = None
        for (route_id, coin), metrics in basis_by_route_coin.items():
            if metrics is None:
                continue
            candidate_basis = {
                "coin": coin,
                "routeId": route_id,
                "route": ROUTES[route_id][2],
                **metrics,
                "expectedNetBps": self.basis_expected_net_bps(metrics),
            }
            if (
                best_basis is None
                or candidate_basis["expectedNetBps"]
                > float(best_basis["expectedNetBps"])
            ):
                best_basis = candidate_basis
        for row in status.get("active") or []:
            row_route = next(
                (
                    route_id
                    for route_id in self.live_routes
                    if row.get("buyVenue") == ROUTES[route_id][0]
                    and row.get("sellVenue") == ROUTES[route_id][1]
                ),
                None,
            )
            if row_route is None:
                continue
            coin = str(row.get("coin") or "")
            net = finite_float(row.get("currentNetBps1000"), -math.inf)
            ages = (
                finite_float(row.get("currentBuyBookAgeMs"), math.inf),
                finite_float(row.get("currentSellBookAgeMs"), math.inf),
            )
            source_ages = (
                finite_float(
                    row.get("currentBuyBookSourceAgeMs"),
                    math.inf,
                ),
                finite_float(
                    row.get("currentSellBookSourceAgeMs"),
                    math.inf,
                ),
            )
            depth = min(
                finite_float(row.get("currentBuyDepthUsd"), 0),
                finite_float(row.get("currentSellDepthUsd"), 0),
            )
            prices = (
                finite_float(row.get("currentBuyVwap1000"), 0),
                finite_float(row.get("currentSellVwap1000"), 0),
            )
            basis = basis_by_route_coin.get((row_route, coin))
            basis_expected_net = self.basis_expected_net_bps(basis)
            if (
                coin in MARKETS
                and coin in self.allowed_coins
                and (
                    (
                        not self.basis_gate_enabled
                        and net >= self.entry_net_bps
                    )
                    or (
                        self.basis_gate_enabled
                        and
                        basis is not None
                        and basis["deviationBps"]
                        >= self.basis_min_deviation_bps
                        and basis_expected_net >= self.entry_net_bps
                    )
                )
                and max(ages) <= self.fresh_ms
                and max(source_ages) <= self.source_fresh_ms
                and depth >= max(1000, self.notional * 3)
                and min(prices) > 0
            ):
                eligible.append(
                    {
                        **row,
                        "_basisBaselineBps": (
                            basis["baselineBps"] if basis else None
                        ),
                        "_basisExitBaselineBps": (
                            basis["exitBaselineBps"] if basis else None
                        ),
                        "_basisDeviationBps": (
                            basis["deviationBps"] if basis else None
                        ),
                        "_basisExpectedNetBps": (
                            basis_expected_net
                            if math.isfinite(basis_expected_net)
                            else None
                        ),
                        "_basisSamples": basis["samples"] if basis else None,
                        "_basisSpanMs": basis["spanMs"] if basis else None,
                        "_routeId": row_route,
                        "_routeLabel": ROUTES[row_route][2],
                        "_buyVenue": ROUTES[row_route][0],
                        "_sellVenue": ROUTES[row_route][1],
                    }
                )
        self.basis_gate_status = {
            "readyCoins": basis_ready_coins,
            "requiredCoins": len(self.allowed_coins),
            "best": best_basis,
        }
        if not eligible:
            if self.basis_gate_enabled and basis_ready_coins == 0:
                self.last_rejection = (
                    "calibrating route basis before real entry"
                )
            else:
                self.last_rejection = (
                    f"waiting for {self.route_label} expected net after "
                    f"basis reversion ≥{self.entry_net_bps:.1f} bps "
                    f"(deviation floor "
                    f"{self.basis_min_deviation_bps:.1f} bps)"
                )
            return None
        self.last_rejection = None
        winner = max(
            eligible,
            key=lambda row: finite_float(
                (
                    row.get("_basisExpectedNetBps")
                    if self.basis_gate_enabled
                    else row.get("currentNetBps1000")
                ),
                -math.inf,
            ),
        )
        snapshot_at = int(status.get("updatedAt", 0) or 0)
        return {
            **winner,
            "_snapshotAt": snapshot_at,
            "_quoteVersion": candidate_quote_version(snapshot_at, winner),
        }

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
        revalidated_candidate_price = competitive_maker_price(
            side,
            edge_limit_price,
        )
        raw_price = safer_maker_price(
            side=side,
            candidate_price=revalidated_candidate_price,
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
        *,
        maker_side: str,
        maker_price: float,
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
        internal_reason: str | None = None
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
            hedge_price = self.current_lighter_hedge_price(coin, maker_side)
            current_net_bps = (
                maker_entry_edge_bps(
                    maker_side,
                    maker_price,
                    hedge_price,
                )
                - self.execution_buffer_bps
                if hedge_price is not None
                else -math.inf
            )
            if current_net_bps < self.maker_cancel_net_bps:
                internal_reason = "EDGE_CANCELLED"
                await self.cancel_extended_order(order_id)
                break
            if status not in final_statuses and not row.post_only:
                # Extended can expose post_only=false while the final fill state
                # is still propagating. Cancel protection immediately, then
                # settle and inspect fills instead of raising before the fill
                # becomes visible.
                internal_reason = "POST_ONLY_FLAG_LOST"
                await self.cancel_all_extended_orders()
                break
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
                    str(getattr(final_row, "status_reason", "") or "")
                    or internal_reason
                    if final_row is not None
                    else internal_reason
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
        *,
        extended_is_buy: bool,
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
        if extended_is_buy:
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
        actual_notional = min(ext_fill.notional, lit_fill.notional)
        execution_buffer_usd = (
            actual_notional * self.execution_buffer_bps / 10_000
        )
        opened_at = max(
            ext_fill.filled_at or now,
            lit_fill.filled_at or now,
        )
        funding_reserve_usd = modeled_funding_reserve_usd(
            notional_usd=actual_notional,
            holding_ms=max(0, now - opened_at),
            funding_bps_per_hour=self.funding_bps_per_hour,
        )
        net = projected_net_usd(
            quantity=quantity,
            entry_buy=entry_buy,
            entry_sell=entry_sell,
            exit_buy=exit_buy,
            exit_sell=exit_sell,
            known_entry_fees=ext_fill.fee + lit_fill.fee,
            estimated_exit_fees=estimated_exit_fees,
            execution_buffer_usd=execution_buffer_usd,
            funding_reserve_usd=funding_reserve_usd,
        )
        return {
            "extendedExitVwap": ext_exit,
            "lighterExitVwap": lit_exit,
            "estimatedExitFeesUsd": estimated_exit_fees,
            "executionBufferUsd": execution_buffer_usd,
            "fundingReserveUsd": funding_reserve_usd,
            "netPnlUsd": net,
            "netPnlPct": net / max(actual_notional, 1e-9) * 100,
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
        actual_notional = min(ext_fill.notional, lit_fill.notional)
        execution_buffer_usd = (
            actual_notional * self.execution_buffer_bps / 10_000
        )
        opened_at = max(
            ext_fill.filled_at or now,
            lit_fill.filled_at or now,
        )
        funding_reserve_usd = modeled_funding_reserve_usd(
            notional_usd=actual_notional,
            holding_ms=max(0, now - opened_at),
            funding_bps_per_hour=self.funding_bps_per_hour,
        )
        net = (
            gross
            - ext_fill.fee
            - lit_fill.fee
            - estimated_exit_fees
            - execution_buffer_usd
            - funding_reserve_usd
        )
        return {
            "extendedExitVwap": ext_exit,
            "lighterExitVwap": lit_exit,
            "estimatedExitFeesUsd": estimated_exit_fees,
            "executionBufferUsd": execution_buffer_usd,
            "fundingReserveUsd": funding_reserve_usd,
            "netPnlUsd": net,
            "netPnlPct": net / max(actual_notional, 1e-9) * 100,
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
            "extendedSide": "long" if extended_long else "short",
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
        self.active_trade = trade
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
        self.write_status("maker_waiting", activeTrade=trade)
        deadline_at = started_at + self.maker_order_ttl_ms
        maker_result = await self.wait_extended_maker_fill(
            coin,
            order_id,
            deadline_at,
            maker_side=side,
            maker_price=float(candidate["price"]),
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
            self.active_trade = None
            if self.shutdown_requested:
                self.running = False
            self.write_status("armed", activeTrade=None, lastTrade=trade)
            self.log("maker_unfilled", **trade)
            return
        trade["entryExtended"] = asdict(ext_fill)
        if abs(ext_fill.fee) > 1e-9:
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
        if post_fill_net_bps < self.post_fill_net_bps:
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
            self.active_trade = None
            if self.shutdown_requested:
                self.running = False
            self.write_status("completed", activeTrade=None, lastTrade=trade)
            self.log("maker_fill_aborted", **trade)
            return

        hedge_quantity = self.lighter_compatible_quantity(
            coin, ext_fill.quantity
        )
        hedge_started = int(time.time() * 1000)
        lit_order = await self.place_lighter(
            coin,
            hedge_quantity,
            is_ask=extended_long,
            reduce_only=False,
            slippage=self.entry_slippage,
        )
        trade["entryLighterOrderId"] = lit_order
        self.write_status("maker_hedging", activeTrade=trade)
        lit_fill = await self.lighter_fill(coin, lit_order)
        trade["entryLighter"] = asdict(lit_fill) if lit_fill else None
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
            raise RuntimeError("maker fill hedge did not reconcile")

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
        trade["exitExtendedOrderId"] = exit_orders.get("extended")
        trade["exitLighterOrderId"] = exit_orders.get("lighter")
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
        holding_ms = closed_at - opened_at
        funding_reserve_usd = modeled_funding_reserve_usd(
            notional_usd=actual_notional,
            holding_ms=holding_ms,
            funding_bps_per_hour=self.funding_bps_per_hour,
        )
        net_before_funding = gross - fees
        net = net_before_funding - funding_reserve_usd
        trade.update(
            status="closed",
            closeReason=close_reason,
            closeStartedAt=close_started,
            closedAt=closed_at,
            holdingMs=holding_ms,
            exitLatencyMs=closed_at - close_started,
            projectedExit=projected,
            exitExtended=asdict(ext_exit),
            exitLighter=asdict(lit_exit),
            grossPnlUsd=round(gross, 8),
            feesUsd=round(fees, 8),
            fundingReserveUsd=round(funding_reserve_usd, 8),
            netPnlUsdBeforeFunding=round(net_before_funding, 8),
            netPnlUsd=round(net, 8),
            netPnlPct=round(net / max(actual_notional, 1e-9) * 100, 8),
        )
        self.append_trade(trade)
        self.trade_open = False
        self.active_trade = None
        if self.shutdown_requested:
            self.running = False
        self.write_status("completed", activeTrade=None, lastTrade=trade)
        self.log("maker_trade_closed", **trade)

    async def execute(self, candidate: dict[str, Any]) -> None:
        coin = str(candidate["coin"])
        opportunity_id = str(candidate["id"])
        route_id = str(candidate.get("_routeId") or self.route_id)
        route_label = str(candidate.get("_routeLabel") or self.route_label)
        buy_venue = str(candidate.get("_buyVenue") or self.buy_venue)
        sell_venue = str(candidate.get("_sellVenue") or self.sell_venue)
        extended_is_buy = buy_venue == "extended"
        quantity = self.common_quantity(
            coin, float(candidate["currentBuyVwap1000"])
        )
        started_at = int(time.time() * 1000)
        trade: dict[str, Any] = {
            "id": f"L{started_at}",
            "status": "opening",
            "coin": coin,
            "routeId": route_id,
            "route": route_label,
            "opportunityId": opportunity_id,
            "signalAt": int(candidate.get("startedAt") or started_at),
            "startedAt": started_at,
            "entryNetPct": float(
                candidate.get("_basisExpectedNetBps")
                if self.basis_gate_enabled
                else candidate["currentNetBps1000"]
            ) / 100,
            "absoluteSpreadNetPct": (
                float(candidate["currentNetBps1000"]) / 100
            ),
            "basisBaselinePct": (
                finite_float(candidate.get("_basisBaselineBps"), 0) / 100
            ),
            "basisExitBaselinePct": (
                finite_float(candidate.get("_basisExitBaselineBps"), 0) / 100
            ),
            "basisDeviationPct": (
                finite_float(candidate.get("_basisDeviationBps"), 0) / 100
            ),
            "notionalUsdPerLeg": self.notional,
            "leverage": self.leverage,
            "quantity": float(quantity),
        }
        self.trade_open = True
        self.active_trade = trade
        self.write_status("opening", activeTrade=trade)
        self.log("entry_submit", **trade)
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
                    is_ask=sell_venue == "lighter",
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
            self.active_trade = None
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
            self.active_trade = None
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
                coin,
                ext_fill,
                lit_fill,
                quantity=float(quantity),
                extended_is_buy=extended_is_buy,
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
                if (
                    projected is not None
                    and projected["netPnlUsd"] <= -self.max_loss_usd
                ):
                    close_reason = "projected_loss_guard"
                    break
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
        actual_notional = min(ext_fill.notional, lit_fill.notional)
        holding_ms = closed_at - opened_at
        funding_reserve_usd = modeled_funding_reserve_usd(
            notional_usd=actual_notional,
            holding_ms=holding_ms,
            funding_bps_per_hour=self.funding_bps_per_hour,
        )
        net_before_funding = gross - fees
        net = net_before_funding - funding_reserve_usd
        trade.update(
            status="closed",
            closeReason=close_reason,
            closeStartedAt=close_started,
            closedAt=closed_at,
            holdingMs=holding_ms,
            exitLatencyMs=closed_at - close_started,
            projectedExit=projected,
            exitExtended=asdict(ext_exit),
            exitLighter=asdict(lit_exit),
            grossPnlUsd=round(gross, 8),
            feesUsd=round(fees, 8),
            fundingReserveUsd=round(funding_reserve_usd, 8),
            netPnlUsdBeforeFunding=round(net_before_funding, 8),
            netPnlUsd=round(net, 8),
            netPnlPct=round(net / max(actual_notional, 1e-9) * 100, 8),
        )
        self.append_trade(trade)
        self.trade_open = False
        self.active_trade = None
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
        shadow_gate_announced = False
        self.write_status("armed")
        self.log(
            "armed",
            notional=self.notional,
            leverage=self.leverage,
            threshold_bps=self.entry_net_bps,
        )
        pending_candidate_id: str | None = None
        pending_quote_version: str | None = None
        pending_confirmations = 0
        while self.running:
            if len(self.completed_mode_trades()) >= self.max_trades:
                self.write_status("completed", reason="max trade count reached")
                return
            observed_shadow_passes = self.maker_shadow_pass_count()
            if observed_shadow_passes < self.required_maker_shadow_passes:
                self.last_rejection = (
                    "ждёт новый прибыльный maker-shadow цикл: "
                    f"{observed_shadow_passes}/{self.required_maker_shadow_passes}"
                )
                if time.monotonic() - self.last_status_write >= 1:
                    self.write_status(
                        "armed_waiting_shadow",
                        makerShadowObservedPasses=observed_shadow_passes,
                    )
                await asyncio.sleep(0.2)
                continue
            if not shadow_gate_announced and self.required_maker_shadow_passes:
                shadow_gate_announced = True
                self.log(
                    "maker_shadow_gate_open",
                    observed=observed_shadow_passes,
                    required=self.required_maker_shadow_passes,
                )
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
                    candidate_id = str(candidate.get("id") or "")
                    quote_version = str(
                        candidate.get("_quoteVersion") or ""
                    )
                    (
                        pending_candidate_id,
                        pending_quote_version,
                        pending_confirmations,
                    ) = advance_entry_confirmations(
                        candidate_id=candidate_id,
                        quote_version=quote_version,
                        pending_candidate_id=pending_candidate_id,
                        pending_quote_version=pending_quote_version,
                        pending_confirmations=pending_confirmations,
                    )
                    if pending_confirmations >= self.entry_confirmations:
                        await self.execute(candidate)
                        return
                    self.last_rejection = (
                        "confirming fresh books "
                        f"{pending_confirmations}/{self.entry_confirmations}"
                    )
            elif self.execution_mode == "taker-taker":
                pending_candidate_id = None
                pending_quote_version = None
                pending_confirmations = 0
            if time.monotonic() - self.last_status_write >= 1:
                self.write_status(
                    "armed",
                    entryConfirmationProgress={
                        "current": pending_confirmations,
                        "required": self.entry_confirmations,
                    },
                )
            await asyncio.sleep(0.02)

    async def close(self) -> None:
        if self.extended is not None:
            await self.extended.close()
        await self.lighter_signer.close()
        await self.lighter_api.close()


def self_test() -> None:
    assert MARKETS["BTC"] == 1
    assert MARKETS["ZEC"] == 90
    assert MARKETS["XAU"] == 92
    assert len(MARKETS) == 25
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
    assert competitive_maker_price("buy", 100.05) == 100.05
    assert competitive_maker_price("sell", 100.05) == 100.05
    assert math.isnan(competitive_maker_price("buy", 0))
    assert math.isnan(competitive_maker_price("hold", 100.05))
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
    protected_profit = projected_net_usd(
        quantity=1,
        entry_buy=100,
        entry_sell=100.20,
        exit_buy=100.10,
        exit_sell=100.10,
        known_entry_fees=0.02505,
        estimated_exit_fees=0.025025,
        execution_buffer_usd=0.02,
        funding_reserve_usd=0.001,
    )
    assert round(protected_profit, 6) == 0.128925
    assert modeled_funding_reserve_usd(
        notional_usd=100,
        holding_ms=180_000,
        funding_bps_per_hour=1,
    ) == 0.0005
    assert finite_float(0, math.inf) == 0
    assert candidate_quote_version(
        1_000,
        {
            "currentBuyBookAgeMs": 0,
            "currentSellBookAgeMs": 25,
        },
    ) == "1000:975"
    pending_id: str | None = None
    pending_version: str | None = None
    confirmations = 0
    for version, expected in [("1:1", 1), ("1:1", 1), ("2:1", 2), ("2:2", 3)]:
        pending_id, pending_version, confirmations = advance_entry_confirmations(
            candidate_id="HYPE-window",
            quote_version=version,
            pending_candidate_id=pending_id,
            pending_quote_version=pending_version,
            pending_confirmations=confirmations,
        )
        assert confirmations == expected
    pending_id, pending_version, confirmations = advance_entry_confirmations(
        candidate_id="new-window",
        quote_version="3:3",
        pending_candidate_id=pending_id,
        pending_quote_version=pending_version,
        pending_confirmations=confirmations,
    )
    assert (pending_id, pending_version, confirmations) == (
        "new-window",
        "3:3",
        1,
    )
    basis = calibrated_basis_deviation(
        samples=[(index * 1_000, 20.0) for index in range(1, 181)],
        now=181_000,
        current_bps=31.0,
        window_ms=180_000,
        exclude_ms=5_000,
        min_samples=120,
        min_span_ms=120_000,
    )
    assert basis is not None
    assert basis["baselineBps"] == 20.0
    assert basis["deviationBps"] == 11.0
    assert calibrated_basis_deviation(
        samples=[(index * 1_000, 20.0) for index in range(1, 60)],
        now=60_000,
        current_bps=31.0,
        window_ms=180_000,
        exclude_ms=5_000,
        min_samples=120,
        min_span_ms=120_000,
    ) is None
    basis_guard = object.__new__(Canary)
    basis_guard.extended_taker_bps = 2.5
    basis_guard.lighter_taker_bps = 0
    basis_guard.execution_buffer_bps = 2
    assert basis_guard.basis_round_trip_cost_bps() == 7
    assert basis_guard.basis_expected_net_bps({
        "deviationBps": 17,
        "expectedNetBps": 10,
    }) == 10
    quote = {
        "extendedBuyVwap": 100.0,
        "extendedSellVwap": 99.9,
        "lighterBuyVwap": 101.1,
        "lighterSellVwap": 101.0,
    }
    assert round(
        executable_basis_bps(quote, "extended-lighter") or 0,
        8,
    ) == 100
    assert round(
        executable_basis_bps(quote, "lighter-extended") or 0,
        8,
    ) == round((99.9 / 101.1 - 1) * 10_000, 8)
    route_guard = object.__new__(Canary)
    route_guard.route_id = "lighter-extended"
    route_guard.route_label = "Lighter → Extended"
    route_guard.live_routes = ("lighter-extended",)
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
    route_guard.route_id = "both"
    route_guard.live_routes = tuple(ROUTES)
    assert len(route_guard.completed_route_trades()) == 2
    shadow_guard = object.__new__(Canary)
    shadow_guard.execution_mode = "maker-taker"
    shadow_guard.required_maker_shadow_passes = 1
    shadow_guard.monitor_path = Path("/unused")
    shadow_guard.read_json = lambda *_args, **_kwargs: {
        "makerShadow": {
            "recent": [
                {
                    "passed": True,
                    "reason": "post_fill_edge_lost",
                    "realizedNetBps": 2,
                },
                {
                    "passed": True,
                    "reason": "maker_round_trip",
                    "realizedNetBps": 4,
                },
                {
                    "passed": False,
                    "reason": "maker_round_trip",
                    "realizedNetBps": -1,
                },
            ]
        }
    }
    assert shadow_guard.maker_shadow_pass_count() == 1
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

    async def recovery_check() -> None:
        recovered: list[dict[str, Any]] = []
        recovery = object.__new__(Canary)
        recovery.active_trade = {
            "id": "test-recovery",
            "coin": "BNB",
            "extendedSide": "long",
            "startedAt": 1_000,
            "entryExtendedOrderId": 1,
        }
        recovery.notional = 100
        recovery.trades = lambda: []
        recovery.append_trade = recovered.append
        recovery.log = lambda *_args, **_kwargs: None

        async def extended_fill(
            _market: str, order_id: int
        ) -> Fill | None:
            if order_id == 1:
                return Fill(569.32, 0.17, 96.7844, 0, 2_000)
            if order_id == 2:
                return Fill(568.97, 0.17, 96.7249, 0.024181, 5_020)
            return None

        recovery.extended_fill = extended_fill
        recovery.lighter_fill = lambda *_args: None
        await recovery.recover_active_trade(
            RuntimeError("simulated fatal"),
            {"extended": 2},
        )
        assert len(recovered) == 1
        assert recovered[0]["status"] == "failed_flat"
        assert recovered[0]["netPnlUsd"] == -0.083681
        assert recovered[0]["holdingMs"] == 3_020

    asyncio.run(recovery_check())
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
        recovery_exit_orders: dict[str, int] = {}
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
                if (
                    runner.active_trade is not None
                    and runner.active_trade.get("coin")
                ):
                    coins.add(str(runner.active_trade["coin"]))
                for coin in coins:
                    orders = await runner.flatten(coin, emergency=True)
                    if (
                        runner.active_trade is not None
                        and coin == runner.active_trade.get("coin")
                    ):
                        recovery_exit_orders = orders
        with contextlib.suppress(Exception):
            await runner.recover_active_trade(error, recovery_exit_orders)
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

#!/usr/bin/env python3
"""Protected LuxAlgo -> Lighter live canary.

Consumes only captured signals written by the Node webhook process. Each
strategy/market may hold one independent position, every position has an
exchange-native reduce-only stop, and the portfolio keeps its $10 daily
realized-loss breaker, $15 cumulative drawdown breaker, per-strategy live
gates, and no replay of signals that predate the first service start.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import lighter


@dataclass(frozen=True)
class Strategy:
    market_id: int
    symbol: str
    asset: str
    stop_pct: float


@dataclass(frozen=True)
class FillSummary:
    price: float | None
    pnl: float | None
    fill_at: int | None
    count: int
    size: float
    notional: float


STRATEGIES = {
    "sol-lg-mf50": Strategy(2, "SOLUSDT", "SOL", 5.0),
    "eth-cntr-st": Strategy(0, "ETHUSDT", "ETH", 4.0),
    "btc-choch-cfm-tc": Strategy(1, "BTCUSDT", "BTC", 3.5),
    "ltc-tcs-smart-trail": Strategy(35, "LTCUSDT", "LTC", 5.0),
    "uni-cfm-smart-weak": Strategy(30, "UNIUSDT", "UNI", 5.0),
    "dot-cntr-tc-hw": Strategy(11, "DOTUSDT", "DOT", 5.0),
    "hbar-cfm-smart-weak": Strategy(59, "HBARUSDT", "HBAR", 5.0),
    "aave-cntr-strong": Strategy(27, "AAVEUSDT", "AAVE", 5.0),
}


class LiveRunner:
    def __init__(self) -> None:
        self.url = os.environ["LIGHTER_BASE_URL"]
        self.account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"])
        self.key_index = int(os.environ["LIGHTER_API_KEY_INDEX"])
        self.enabled = os.getenv("LIGHTER_LIVE_ENABLED", "false").lower() == "true"
        self.notional = float(os.getenv("LIGHTER_LIVE_NOTIONAL_USD", "100"))
        self.leverage = int(os.getenv("LIGHTER_LIVE_LEVERAGE", "10"))
        self.daily_loss_usd = float(os.getenv("LIGHTER_LIVE_DAILY_LOSS_USD", "10"))
        self.max_drawdown_usd = float(
            os.getenv("LIGHTER_LIVE_MAX_DRAWDOWN_USD", "15")
        )
        self.strategy_pause_sample = int(
            os.getenv("LIGHTER_LIVE_STRATEGY_PAUSE_SAMPLE", "10")
        )
        self.strategy_gate_sample = int(
            os.getenv("LIGHTER_LIVE_STRATEGY_GATE_SAMPLE", "20")
        )
        self.max_slippage = float(os.getenv("LIGHTER_LIVE_MAX_SLIPPAGE", "0.003"))
        self.signal_batch_size = max(
            1,
            int(os.getenv("LIGHTER_LIVE_SIGNAL_BATCH_SIZE", "16")),
        )
        self.signal_parallelism = max(
            1,
            int(os.getenv("LIGHTER_LIVE_SIGNAL_PARALLELISM", "4")),
        )
        self.db = sqlite3.connect(
            os.getenv(
                "LIGHTER_DB_PATH",
                "/home/trader/apps/trading-agent/data/trading.sqlite",
            ),
            timeout=10,
            isolation_level=None,
        )
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.signer = lighter.SignerClient(
            url=self.url,
            account_index=self.account_index,
            api_private_keys={
                self.key_index: os.environ["LIGHTER_API_PRIVATE_KEY"]
            },
        )
        self.api = lighter.ApiClient(lighter.Configuration(host=self.url))
        self.market_meta: dict[int, dict[str, Any]] = {}
        self.running = True
        self.last_order_id = int(time.time() * 1000)
        self.last_stop_check = 0.0
        self.last_heartbeat = 0.0
        self.reconcile_cursor = 0
        self.leverage_ready: set[int] = set()
        self.market_locks: dict[int, asyncio.Lock] = {}
        self.signal_slots = asyncio.Semaphore(self.signal_parallelism)

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

    def market_lock(self, market_id: int) -> asyncio.Lock:
        lock = self.market_locks.get(market_id)
        if lock is None:
            lock = asyncio.Lock()
            self.market_locks[market_id] = lock
        return lock

    def state(self, status: str, error: str | None = None) -> None:
        now = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_state
               SET enabled=?, heartbeat_at=?, status=?, last_error=?
               WHERE id=1""",
            (1 if self.enabled else 0, now, status, error),
        )

    async def auth(self) -> str:
        token, error = self.signer.create_auth_token_with_expiry(
            deadline=600,
            api_key_index=self.key_index,
        )
        if error is not None or not token:
            raise RuntimeError(f"auth token failed: {error}")
        return token

    async def account(self) -> dict[str, Any]:
        response = await lighter.AccountApi(self.api).account(
            by="index",
            value=str(self.account_index),
            active_only=False,
        )
        rows = response.to_dict().get("accounts") or []
        if not rows:
            raise RuntimeError("account not returned")
        return rows[0]

    async def positions(self) -> list[dict[str, Any]]:
        return self.positions_from_account(await self.account())

    @staticmethod
    def positions_from_account(account: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            row
            for row in account.get("positions") or []
            if abs(float(row.get("position", 0) or 0)) > 0
        ]

    async def market_position(self, market_id: int) -> dict[str, Any] | None:
        return next(
            (
                row
                for row in await self.positions()
                if int(row.get("market_id", -1)) == market_id
            ),
            None,
        )

    async def wait_position(
        self,
        market_id: int,
        want_open: bool,
        timeout: float = 15,
    ) -> dict[str, Any] | None:
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = await self.market_position(market_id)
            if (last is not None) == want_open:
                return last
            await asyncio.sleep(0.35)
        return last

    @staticmethod
    def response_ok(response: Any, error: Any) -> bool:
        if error is not None or response is None:
            return False
        return response.to_dict().get("code") == 200

    async def load_market_meta(self) -> None:
        response = await lighter.OrderApi(self.api).order_book_details()
        rows = response.to_dict().get("order_book_details") or []
        self.market_meta = {int(row["market_id"]): row for row in rows}
        missing = [
            strategy.market_id
            for strategy in STRATEGIES.values()
            if strategy.market_id not in self.market_meta
        ]
        if missing:
            raise RuntimeError(f"missing market metadata: {missing}")

    def scales(self, market_id: int) -> tuple[int, int]:
        meta = self.market_meta[market_id]
        return (
            10 ** int(meta["size_decimals"]),
            10 ** int(meta["price_decimals"]),
        )

    @staticmethod
    def api_bool(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes"}

    def stop_order_error(
        self,
        active: list[dict[str, Any]],
        client_order_id: int,
        strategy: Strategy,
        position_side: str,
        position_size: float,
        stop_price: float,
    ) -> str | None:
        order = next(
            (
                row
                for row in active
                if int(row.get("client_order_index", -1)) == client_order_id
            ),
            None,
        )
        if order is None:
            return "missing"
        if int(order.get("market_index", -1)) != strategy.market_id:
            return "wrong market"
        if str(order.get("type", "")).lower() != "stop-loss":
            return f"wrong type {order.get('type')}"
        if not self.api_bool(order.get("reduce_only")):
            return "reduce_only=false"
        expected_is_ask = position_side == "long"
        if "is_ask" not in order:
            return "side missing"
        if self.api_bool(order.get("is_ask")) != expected_is_ask:
            return "wrong side"
        if str(order.get("status", "")).lower() not in {"pending", "open"}:
            return f"wrong status {order.get('status')}"

        size_scale, price_scale = self.scales(strategy.market_id)
        size_tick = 1 / size_scale
        price_tick = 1 / price_scale
        remaining = float(
            order.get("remaining_base_amount")
            or order.get("initial_base_amount")
            or 0
        )
        if remaining + size_tick < abs(position_size):
            return f"under-covered {remaining} < {abs(position_size)}"

        trigger = float(order.get("trigger_price", 0) or 0)
        if trigger <= 0:
            return "trigger missing"
        expected_trigger = round(stop_price * price_scale) / price_scale
        if abs(trigger - expected_trigger) > price_tick:
            return f"wrong trigger {trigger} != {expected_trigger}"

        limit_price = float(order.get("price", 0) or 0)
        if limit_price <= 0:
            return "limit price missing"
        if position_side == "long" and limit_price > trigger + price_tick:
            return f"wrong sell limit {limit_price} > {trigger}"
        if position_side == "short" and limit_price < trigger - price_tick:
            return f"wrong buy limit {limit_price} < {trigger}"
        return None

    async def active_orders(self, market_id: int) -> list[dict[str, Any]]:
        response = await lighter.OrderApi(self.api).account_active_orders(
            authorization=await self.auth(),
            account_index=self.account_index,
            market_id=market_id,
        )
        return response.to_dict().get("orders") or []

    async def fills(
        self,
        market_id: int,
        client_order_id: int,
        timeout: float = 6,
    ) -> list[dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while True:
            response = await lighter.OrderApi(self.api).trades(
                sort_by="timestamp",
                sort_dir="desc",
                limit=100,
                authorization=await self.auth(),
                market_id=market_id,
                account_index=self.account_index,
            )
            rows = response.to_dict().get("trades") or []
            matched = [
                row
                for row in rows
                if int(row.get("ask_client_id", -1)) == client_order_id
                or int(row.get("bid_client_id", -1)) == client_order_id
            ]
            if matched or time.monotonic() >= deadline:
                return matched
            await asyncio.sleep(0.35)

    @staticmethod
    def fill_summary(
        rows: list[dict[str, Any]],
        account_index: int,
    ) -> FillSummary:
        size = sum(float(row.get("size", 0) or 0) for row in rows)
        if size <= 0:
            return FillSummary(None, None, None, 0, 0.0, 0.0)
        notional = sum(
            float(row["price"]) * float(row["size"]) for row in rows
        )
        price = notional / size
        pnl = 0.0
        for row in rows:
            if int(row.get("ask_account_id", -1)) == account_index:
                pnl += float(row.get("ask_account_pnl", 0) or 0)
            if int(row.get("bid_account_id", -1)) == account_index:
                pnl += float(row.get("bid_account_pnl", 0) or 0)
        fill_at = max(
            (int(row.get("timestamp", 0) or 0) for row in rows),
            default=0,
        ) or None
        return FillSummary(price, pnl, fill_at, len(rows), size, notional)

    async def record_entry_fill_audit(
        self,
        trade_id: int,
        strategy: Strategy,
        entry_order_id: int,
        expected_price: float,
        expected_size: float,
    ) -> None:
        try:
            fills = await self.fills(strategy.market_id, entry_order_id)
            summary = self.fill_summary(fills, self.account_index)
            if summary.price is None or summary.fill_at is None:
                self.log(
                    "entry_fill_audit_missing",
                    trade_id=trade_id,
                    order_id=entry_order_id,
                )
                return
            size_scale, price_scale = self.scales(strategy.market_id)
            price_mismatch = abs(summary.price - expected_price) > 1 / price_scale
            size_mismatch = abs(summary.size - abs(expected_size)) > 1 / size_scale
            audit_error = (
                f"entry fill mismatch: position {expected_size}@{expected_price}, "
                f"fills {summary.size}@{summary.price}"
                if price_mismatch or size_mismatch
                else None
            )
            self.db.execute(
                """UPDATE lighter_lux_live_trades
                   SET opened_at=?,entry_fill_at=?,entry_fill_count=?,
                       error=COALESCE(?,error)
                   WHERE id=?""",
                (
                    summary.fill_at,
                    summary.fill_at,
                    summary.count,
                    audit_error,
                    trade_id,
                ),
            )
            if audit_error:
                self.log("entry_fill_mismatch", trade_id=trade_id, error=audit_error)
        except Exception as exc:
            self.log(
                "entry_fill_audit_error",
                trade_id=trade_id,
                error=str(exc),
            )

    def open_trades(self) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT * FROM lighter_lux_live_trades
               WHERE status IN ('opening','open','closing')
               ORDER BY id"""
        ).fetchall()

    def open_trade(self, strategy_id: str) -> sqlite3.Row | None:
        return self.db.execute(
            """SELECT * FROM lighter_lux_live_trades
               WHERE strategy_id=?
                 AND status IN ('opening','open','closing')
               ORDER BY id DESC LIMIT 1""",
            (strategy_id,),
        ).fetchone()

    def daily_net(self) -> float:
        midnight = int(
            datetime.now(timezone.utc)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .timestamp()
            * 1000
        )
        row = self.db.execute(
            """SELECT COALESCE(SUM(net_pnl_usd),0) AS net
               FROM lighter_lux_live_trades
               WHERE status='closed' AND closed_at>=?""",
            (midnight,),
        ).fetchone()
        return float(row["net"])

    @staticmethod
    def pnl_stats(rows: list[sqlite3.Row]) -> dict[str, float | int | None]:
        pnls = [float(row["net_pnl_usd"] or 0) for row in rows]
        gross_win = sum(value for value in pnls if value > 0)
        gross_loss = abs(sum(value for value in pnls if value < 0))
        split = len(pnls) // 2
        equity = 0.0
        peak = 0.0
        max_drawdown = 0.0
        for value in pnls:
            equity += value
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, peak - equity)
        return {
            "closed": len(pnls),
            "net": sum(pnls),
            "profit_factor": (
                gross_win / gross_loss
                if gross_loss > 0
                else None
            ),
            "first_half": sum(pnls[:split]),
            "second_half": sum(pnls[split:]),
            "equity_peak": peak,
            "current_drawdown": peak - equity,
            "max_drawdown": max_drawdown,
        }

    def refresh_portfolio_risk(self) -> sqlite3.Row:
        rows = self.db.execute(
            """SELECT net_pnl_usd
               FROM lighter_lux_live_trades
               WHERE status='closed' AND net_pnl_usd IS NOT NULL
               ORDER BY closed_at,id"""
        ).fetchall()
        stats = self.pnl_stats(rows)
        state = self.db.execute(
            "SELECT * FROM lighter_lux_live_state WHERE id=1"
        ).fetchone()
        paused_at = state["portfolio_paused_at"]
        pause_reason = state["portfolio_pause_reason"]
        if (
            paused_at is None
            and float(stats["current_drawdown"] or 0) >= self.max_drawdown_usd
        ):
            paused_at = int(time.time() * 1000)
            pause_reason = (
                f"cumulative drawdown "
                f"${float(stats['current_drawdown'] or 0):.2f} "
                f">= ${self.max_drawdown_usd:.2f}"
            )
            self.log("portfolio_paused", reason=pause_reason)
        self.db.execute(
            """UPDATE lighter_lux_live_state
               SET cumulative_net_usd=?,equity_peak_usd=?,
                   current_drawdown_usd=?,max_drawdown_usd=?,
                   portfolio_paused_at=?,portfolio_pause_reason=?
               WHERE id=1""",
            (
                stats["net"],
                stats["equity_peak"],
                stats["current_drawdown"],
                stats["max_drawdown"],
                paused_at,
                pause_reason,
            ),
        )
        return self.db.execute(
            "SELECT * FROM lighter_lux_live_state WHERE id=1"
        ).fetchone()

    def refresh_strategy_stats(self) -> None:
        now = int(time.time() * 1000)
        for strategy_id in STRATEGIES:
            self.db.execute(
                """INSERT OR IGNORE INTO lighter_lux_live_strategy_state
                   (strategy_id,updated_at) VALUES (?,?)""",
                (strategy_id, now),
            )
            state = self.db.execute(
                """SELECT * FROM lighter_lux_live_strategy_state
                   WHERE strategy_id=?""",
                (strategy_id,),
            ).fetchone()
            rows = self.db.execute(
                """SELECT net_pnl_usd
                   FROM lighter_lux_live_trades
                   WHERE strategy_id=? AND status='closed'
                     AND net_pnl_usd IS NOT NULL
                   ORDER BY closed_at,id""",
                (strategy_id,),
            ).fetchall()
            stats = self.pnl_stats(rows)
            closed = int(stats["closed"] or 0)
            net = float(stats["net"] or 0)
            profit_factor = stats["profit_factor"]
            second_half = float(stats["second_half"] or 0)
            max_drawdown = float(stats["max_drawdown"] or 0)
            enabled = int(state["enabled"])
            paused_at = state["paused_at"]
            pause_reason = state["pause_reason"]

            weak_after_sample = (
                closed >= self.strategy_pause_sample
                and (
                    net <= 0
                    or (
                        profit_factor is not None
                        and float(profit_factor) < 1.0
                    )
                    or second_half <= 0
                )
            )
            passed = (
                closed >= self.strategy_gate_sample
                and net > 0
                and (
                    profit_factor is None
                    or float(profit_factor) >= 1.2
                )
                and second_half > 0
                and max_drawdown <= self.max_drawdown_usd
            )
            if enabled and weak_after_sample:
                enabled = 0
                paused_at = now
                pause_reason = (
                    f"live gate failed after {closed}: net ${net:.2f}, "
                    f"PF {'inf' if profit_factor is None else f'{float(profit_factor):.2f}'}, "
                    f"second half ${second_half:.2f}"
                )
                self.log(
                    "strategy_paused",
                    strategy=strategy_id,
                    reason=pause_reason,
                )
            gate_status = (
                "paused"
                if not enabled
                else "passed"
                if passed
                else "watch"
                if closed >= self.strategy_pause_sample
                else "collecting"
            )
            self.db.execute(
                """UPDATE lighter_lux_live_strategy_state
                   SET enabled=?,closed_trades=?,net_pnl_usd=?,
                       profit_factor=?,first_half_net_usd=?,
                       second_half_net_usd=?,max_drawdown_usd=?,
                       gate_status=?,paused_at=?,pause_reason=?,updated_at=?
                   WHERE strategy_id=?""",
                (
                    enabled,
                    closed,
                    net,
                    profit_factor,
                    stats["first_half"],
                    second_half,
                    max_drawdown,
                    gate_status,
                    paused_at,
                    pause_reason,
                    now,
                    strategy_id,
                ),
            )

    def strategy_enabled(self, strategy_id: str) -> bool:
        row = self.db.execute(
            """SELECT enabled FROM lighter_lux_live_strategy_state
               WHERE strategy_id=?""",
            (strategy_id,),
        ).fetchone()
        return row is not None and int(row["enabled"]) == 1

    def decide(
        self,
        signal_id: int,
        decision: str,
        reason: str,
        trade_id: int | None = None,
    ) -> None:
        self.db.execute(
            """INSERT OR REPLACE INTO lighter_lux_live_decisions
               (signal_id,decided_at,decision,reason,trade_id)
               VALUES (?,?,?,?,?)""",
            (signal_id, int(time.time() * 1000), decision, reason, trade_id),
        )

    async def place_stop(
        self,
        trade_id: int,
        strategy: Strategy,
        side: str,
        quantity: float,
        entry_price: float,
        existing_order_id: int | None = None,
    ) -> tuple[int, float, int]:
        size_scale, price_scale = self.scales(strategy.market_id)
        stop_price = entry_price * (
            1 - strategy.stop_pct / 100
            if side == "long"
            else 1 + strategy.stop_pct / 100
        )
        worst_price = stop_price * (0.99 if side == "long" else 1.01)
        order_id = existing_order_id or self.order_id()
        sent_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET stop_order_sent_at=? WHERE id=?""",
            (sent_at, trade_id),
        )
        _, response, error = await self.signer.create_sl_order(
            market_index=strategy.market_id,
            client_order_index=order_id,
            base_amount=round(quantity * size_scale),
            trigger_price=round(stop_price * price_scale),
            price=round(worst_price * price_scale),
            is_ask=side == "long",
            reduce_only=True,
            api_key_index=self.key_index,
        )
        if not self.response_ok(response, error):
            raise RuntimeError(f"stop rejected: {error}")
        await asyncio.sleep(0.6)
        active = await self.active_orders(strategy.market_id)
        stop_error = self.stop_order_error(
            active,
            order_id,
            strategy,
            side,
            quantity,
            stop_price,
        )
        if stop_error:
            raise RuntimeError(f"stop accepted but invalid: {stop_error}")
        protected_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET stop_order_index=?,stop_price=?,protected_at=? WHERE id=?""",
            (order_id, stop_price, protected_at, trade_id),
        )
        return order_id, stop_price, protected_at

    async def emergency_close(
        self,
        strategy: Strategy,
        position: dict[str, Any],
    ) -> int:
        size_scale, _ = self.scales(strategy.market_id)
        order_id = self.order_id()
        _, response, error = await self.signer.create_market_order_limited_slippage(
            market_index=strategy.market_id,
            client_order_index=order_id,
            base_amount=round(float(position["position"]) * size_scale),
            max_slippage=0.01,
            is_ask=int(position["sign"]) > 0,
            reduce_only=True,
            api_key_index=self.key_index,
        )
        if not self.response_ok(response, error):
            raise RuntimeError(f"emergency close rejected: {error}")
        return order_id

    async def enter(
        self,
        signal: sqlite3.Row,
        strategy: Strategy,
        side: str,
    ) -> tuple[str, int | None]:
        entry_started_at = int(time.time() * 1000)
        if self.daily_net() <= -self.daily_loss_usd:
            return "daily loss breaker", None
        risk_state = self.refresh_portfolio_risk()
        if risk_state["portfolio_paused_at"] is not None:
            return str(risk_state["portfolio_pause_reason"]), None
        self.refresh_strategy_stats()
        if not self.strategy_enabled(str(signal["strategy_id"])):
            return "strategy live-paused", None
        account = await self.account()
        if float(account["available_balance"]) < 20:
            return "balance below 20 USDC", None
        if any(
            int(position.get("market_id", -1)) == strategy.market_id
            for position in self.positions_from_account(account)
        ):
            return "exchange market already has a position", None

        order_id = self.order_id()
        cursor = self.db.execute(
            """INSERT INTO lighter_lux_live_trades
               (strategy_id,symbol,market_id,side,entry_signal_id,opened_at,
                entry_started_at,requested_notional_usd,leverage,stop_pct,
                entry_order_index,status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?, 'opening')""",
            (
                signal["strategy_id"],
                strategy.asset,
                strategy.market_id,
                side,
                signal["id"],
                entry_started_at,
                entry_started_at,
                self.notional,
                self.leverage,
                strategy.stop_pct,
                order_id,
            ),
        )
        trade_id = int(cursor.lastrowid)
        try:
            if strategy.market_id not in self.leverage_ready:
                _, response, error = await self.signer.update_leverage(
                    market_index=strategy.market_id,
                    margin_mode=self.signer.CROSS_MARGIN_MODE,
                    leverage=self.leverage,
                    api_key_index=self.key_index,
                )
                if not self.response_ok(response, error):
                    raise RuntimeError(f"leverage rejected: {error}")
                self.leverage_ready.add(strategy.market_id)

            entry_order_sent_at = int(time.time() * 1000)
            self.db.execute(
                """UPDATE lighter_lux_live_trades
                   SET entry_order_sent_at=? WHERE id=?""",
                (entry_order_sent_at, trade_id),
            )
            _, response, error = (
                await self.signer.create_market_order_quote_amount(
                    market_index=strategy.market_id,
                    client_order_index=order_id,
                    quote_amount=self.notional,
                    max_slippage=self.max_slippage,
                    is_ask=side == "short",
                    reduce_only=False,
                    api_key_index=self.key_index,
                )
            )
            if not self.response_ok(response, error):
                raise RuntimeError(f"entry rejected: {error}")
            entry_order_accepted_at = int(time.time() * 1000)
            self.db.execute(
                """UPDATE lighter_lux_live_trades
                   SET entry_order_accepted_at=? WHERE id=?""",
                (entry_order_accepted_at, trade_id),
            )

            position = await self.wait_position(strategy.market_id, True)
            if position is None:
                raise RuntimeError("entry accepted but position not visible")
            entry_position_seen_at = int(time.time() * 1000)
            actual_side = "long" if int(position["sign"]) > 0 else "short"
            if actual_side != side:
                raise RuntimeError(f"wrong exchange side: {actual_side}")
            quantity = float(position["position"])
            entry_price = float(position["avg_entry_price"])
            # Lighter position_value is mark-based and can move before this
            # response arrives. Entry notional must remain fill-price × size.
            filled_notional = abs(quantity) * entry_price
            entry_reference_l2 = (
                signal["buy_vwap_1000"]
                if side == "long"
                else signal["sell_vwap_1000"]
            )
            entry_slippage_pct = (
                None
                if entry_reference_l2 is None
                else (
                    (entry_price - float(entry_reference_l2))
                    / float(entry_reference_l2)
                    * 100
                    if side == "long"
                    else (
                        float(entry_reference_l2) - entry_price
                    )
                    / float(entry_reference_l2)
                    * 100
                )
            )
            self.db.execute(
                """UPDATE lighter_lux_live_trades
                   SET opened_at=?,entry_position_seen_at=?,
                       quantity=?,entry_price=?,filled_notional_usd=?,
                       entry_reference_source=?,entry_reference_l2=?,
                       entry_slippage_pct=?,entry_book_age_ms=?
                   WHERE id=?""",
                (
                    entry_position_seen_at,
                    entry_position_seen_at,
                    quantity,
                    entry_price,
                    filled_notional,
                    signal["source_price"],
                    entry_reference_l2,
                    entry_slippage_pct,
                    signal["book_age_ms"],
                    trade_id,
                ),
            )
            stop_id, stop_price, protected_at = await self.place_stop(
                trade_id,
                strategy,
                side,
                quantity,
                entry_price,
            )
            self.db.execute(
                "UPDATE lighter_lux_live_trades SET status='open' WHERE id=?",
                (trade_id,),
            )
            await self.record_entry_fill_audit(
                trade_id,
                strategy,
                order_id,
                entry_price,
                quantity,
            )
            self.log(
                "position_open",
                trade_id=trade_id,
                strategy=signal["strategy_id"],
                side=side,
                quantity=quantity,
                entry=entry_price,
                stop=stop_price,
                stop_order=stop_id,
                signal_to_order_ms=entry_order_sent_at
                - int(signal["received_at"]),
                order_ack_ms=entry_order_accepted_at - entry_order_sent_at,
                order_to_position_ms=entry_position_seen_at
                - entry_order_sent_at,
                signal_to_protected_ms=protected_at - int(signal["received_at"]),
            )
            return "entered", trade_id
        except Exception as exc:
            position = await self.market_position(strategy.market_id)
            if position is not None:
                try:
                    close_id = await self.emergency_close(strategy, position)
                    self.db.execute(
                        """UPDATE lighter_lux_live_trades
                           SET exit_order_index=?,status='closing',
                               close_reason='protection_failure',error=?
                           WHERE id=?""",
                        (close_id, str(exc), trade_id),
                    )
                    await self.wait_position(strategy.market_id, False)
                    await self.finalize(trade_id, "protection_failure", close_id)
                except Exception as close_exc:
                    self.db.execute(
                        """UPDATE lighter_lux_live_trades
                           SET status='error',error=? WHERE id=?""",
                        (f"{exc}; emergency close: {close_exc}", trade_id),
                    )
                    raise
            else:
                self.db.execute(
                    """UPDATE lighter_lux_live_trades
                       SET status='error',error=? WHERE id=?""",
                    (str(exc), trade_id),
                )
            return f"entry failed: {exc}", trade_id

    async def finalize(
        self,
        trade_id: int,
        reason: str,
        exit_order_id: int,
        funding: float | None = None,
    ) -> None:
        row = self.db.execute(
            "SELECT * FROM lighter_lux_live_trades WHERE id=?", (trade_id,)
        ).fetchone()
        fills = await self.fills(int(row["market_id"]), exit_order_id)
        fill_summary = self.fill_summary(fills, self.account_index)
        exit_price = fill_summary.price
        realized = fill_summary.pnl
        entry = float(row["entry_price"] or 0)
        quantity = float(row["quantity"] or 0)
        side_sign = 1 if row["side"] == "long" else -1
        if realized is None and exit_price is not None:
            realized = side_sign * (exit_price - entry) * quantity
        realized = float(realized or 0)
        funding = (
            float(row["funding_pnl_usd"] or 0)
            if funding is None
            else funding
        )
        exit_reference_l2 = row["exit_reference_l2"]
        exit_slippage_pct = (
            None
            if exit_price is None or exit_reference_l2 is None
            else (
                (float(exit_reference_l2) - exit_price)
                / float(exit_reference_l2)
                * 100
                if row["side"] == "long"
                else (
                    exit_price - float(exit_reference_l2)
                )
                / float(exit_reference_l2)
                * 100
            )
        )
        net = realized + float(funding)
        base = float(row["filled_notional_usd"] or row["requested_notional_usd"])
        net_pct = net / base * 100 if base > 0 else 0
        closed_at = int(
            fill_summary.fill_at
            or row["exit_position_gone_at"]
            or int(time.time() * 1000)
        )
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET closed_at=?,exit_price=?,gross_pnl_usd=?,
                   funding_pnl_usd=?,fee_usd=0,net_pnl_usd=?,net_pnl_pct=?,
                   exit_slippage_pct=?,exit_order_index=?,close_reason=?,
                   exit_fill_at=?,exit_fill_count=?,status='closed'
               WHERE id=?""",
            (
                closed_at,
                exit_price,
                realized,
                funding,
                net,
                net_pct,
                exit_slippage_pct,
                exit_order_id,
                reason,
                fill_summary.fill_at,
                fill_summary.count,
                trade_id,
            ),
        )
        self.log(
            "position_closed",
            trade_id=trade_id,
            reason=reason,
            exit=exit_price,
            net_usd=net,
            net_pct=net_pct,
            exit_slippage_pct=exit_slippage_pct,
        )
        self.refresh_portfolio_risk()
        self.refresh_strategy_stats()

    async def close(
        self,
        trade: sqlite3.Row,
        reason: str,
        exit_signal_id: int | None,
    ) -> bool:
        strategy = STRATEGIES[trade["strategy_id"]]
        position = await self.market_position(strategy.market_id)
        if position is None:
            await self.reconcile_open_trade(trade)
            return True
        funding = -float(position.get("total_funding_paid_out", 0) or 0)
        exit_signal = (
            self.db.execute(
                """SELECT source_price,buy_vwap_1000,sell_vwap_1000
                   FROM lighter_lux_signals WHERE id=?""",
                (exit_signal_id,),
            ).fetchone()
            if exit_signal_id is not None
            else None
        )
        exit_reference_l2 = (
            None
            if exit_signal is None
            else (
                exit_signal["sell_vwap_1000"]
                if trade["side"] == "long"
                else exit_signal["buy_vwap_1000"]
            )
        )
        size_scale, _ = self.scales(strategy.market_id)
        close_id = self.order_id()
        exit_order_sent_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET status='closing',exit_signal_id=?,exit_order_index=?,
                   close_reason=?,exit_reference_source=?,
                   exit_reference_l2=?,exit_order_sent_at=? WHERE id=?""",
            (
                exit_signal_id,
                close_id,
                reason,
                None if exit_signal is None else exit_signal["source_price"],
                exit_reference_l2,
                exit_order_sent_at,
                trade["id"],
            ),
        )
        _, response, error = await self.signer.create_market_order_limited_slippage(
            market_index=strategy.market_id,
            client_order_index=close_id,
            base_amount=round(float(position["position"]) * size_scale),
            max_slippage=self.max_slippage,
            is_ask=int(position["sign"]) > 0,
            reduce_only=True,
            api_key_index=self.key_index,
        )
        if not self.response_ok(response, error):
            self.db.execute(
                "UPDATE lighter_lux_live_trades SET status='open',error=? WHERE id=?",
                (f"close rejected: {error}", trade["id"]),
            )
            return False
        exit_order_accepted_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET exit_order_accepted_at=? WHERE id=?""",
            (exit_order_accepted_at, trade["id"]),
        )
        if await self.wait_position(strategy.market_id, False) is not None:
            self.db.execute(
                "UPDATE lighter_lux_live_trades SET status='open',error=? WHERE id=?",
                ("close accepted but position remains", trade["id"]),
            )
            return False
        exit_position_gone_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET exit_position_gone_at=? WHERE id=?""",
            (exit_position_gone_at, trade["id"]),
        )
        if trade["stop_order_index"] is not None:
            await self.signer.cancel_order(
                market_index=strategy.market_id,
                order_index=int(trade["stop_order_index"]),
                api_key_index=self.key_index,
            )
        await self.finalize(int(trade["id"]), reason, close_id, funding)
        return True

    async def safety_close(
        self,
        trade: sqlite3.Row,
        strategy: Strategy,
        position: dict[str, Any],
        reason: str,
        error: str,
        cancel_stop: bool,
    ) -> None:
        stop_id = trade["stop_order_index"]
        sent_at = int(time.time() * 1000)
        close_id = await self.emergency_close(strategy, position)
        accepted_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET status='closing',exit_order_index=?,close_reason=?,error=?,
                   exit_order_sent_at=?,exit_order_accepted_at=?
               WHERE id=?""",
            (
                close_id,
                reason,
                error,
                sent_at,
                accepted_at,
                trade["id"],
            ),
        )
        if cancel_stop and stop_id is not None:
            _, cancel_response, cancel_error = await self.signer.cancel_order(
                market_index=strategy.market_id,
                order_index=int(stop_id),
                api_key_index=self.key_index,
            )
            if not self.response_ok(cancel_response, cancel_error):
                self.log(
                    "safety_stop_cancel_failed",
                    trade_id=trade["id"],
                    stop_order=stop_id,
                    error=cancel_error,
                )
        if await self.wait_position(strategy.market_id, False) is not None:
            self.db.execute(
                """UPDATE lighter_lux_live_trades
                   SET status='error',error=? WHERE id=?""",
                (f"{error}; safety close accepted but position remains", trade["id"]),
            )
            raise RuntimeError("safety close accepted but position remains")
        gone_at = int(time.time() * 1000)
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET exit_position_gone_at=? WHERE id=?""",
            (gone_at, trade["id"]),
        )
        await self.finalize(int(trade["id"]), reason, close_id)

    async def reconcile_open_trade(self, trade: sqlite3.Row) -> None:
        strategy = STRATEGIES[trade["strategy_id"]]
        position = await self.market_position(strategy.market_id)
        if position is None:
            now = int(time.time() * 1000)
            if (
                trade["exit_reference_l2"] is None
                and trade["stop_order_index"] is not None
            ):
                self.db.execute(
                    """UPDATE lighter_lux_live_trades
                       SET exit_reference_l2=?
                       WHERE id=?""",
                    (trade["stop_price"], trade["id"]),
                )
            close_id = int(
                trade["exit_order_index"]
                or trade["stop_order_index"]
                or trade["entry_order_index"]
            )
            reason = (
                trade["close_reason"]
                or ("safety_stop" if trade["stop_order_index"] else "external_close")
            )
            self.db.execute(
                """UPDATE lighter_lux_live_trades
                   SET exit_position_gone_at=COALESCE(exit_position_gone_at,?)
                   WHERE id=?""",
                (now, trade["id"]),
            )
            await self.finalize(int(trade["id"]), reason, close_id)
            return
        self.db.execute(
            """UPDATE lighter_lux_live_trades
               SET funding_pnl_usd=? WHERE id=?""",
            (
                -float(position.get("total_funding_paid_out", 0) or 0),
                trade["id"],
            ),
        )
        expected_side = "long" if int(position["sign"]) > 0 else "short"
        size_scale, price_scale = self.scales(strategy.market_id)
        exchange_size = abs(float(position["position"]))
        exchange_entry = float(position["avg_entry_price"])
        mismatches: list[str] = []
        if expected_side != trade["side"]:
            mismatches.append(f"side {expected_side} != {trade['side']}")
        if (
            trade["quantity"] is None
            or abs(exchange_size - abs(float(trade["quantity"]))) > 1 / size_scale
        ):
            mismatches.append(f"size {exchange_size} != {trade['quantity']}")
        if (
            trade["entry_price"] is None
            or abs(exchange_entry - float(trade["entry_price"])) > 1 / price_scale
        ):
            mismatches.append(f"entry {exchange_entry} != {trade['entry_price']}")
        if mismatches:
            error = f"position mismatch: {'; '.join(mismatches)}"
            await self.safety_close(
                trade,
                strategy,
                position,
                "position_mismatch",
                error,
                cancel_stop=True,
            )
            return
        active = await self.active_orders(strategy.market_id)
        stop_id = trade["stop_order_index"]
        stop_error = (
            "missing"
            if stop_id is None or trade["stop_price"] is None
            else self.stop_order_error(
                active,
                int(stop_id),
                strategy,
                trade["side"],
                float(position["position"]),
                float(trade["stop_price"]),
            )
        )
        if stop_error:
            if trade["status"] == "opening" and trade["entry_price"] is not None:
                if stop_error == "missing":
                    await self.place_stop(
                        int(trade["id"]),
                        strategy,
                        trade["side"],
                        float(position["position"]),
                        float(position["avg_entry_price"]),
                    )
                    self.db.execute(
                        "UPDATE lighter_lux_live_trades SET status='open' WHERE id=?",
                        (trade["id"],),
                    )
                    return
            await asyncio.sleep(0.8)
            current_position = await self.market_position(strategy.market_id)
            if current_position is None:
                await self.finalize(
                    int(trade["id"]),
                    "safety_stop",
                    int(stop_id or trade["entry_order_index"]),
                )
                return
            current_active = await self.active_orders(strategy.market_id)
            current_error = (
                "missing"
                if stop_id is None or trade["stop_price"] is None
                else self.stop_order_error(
                    current_active,
                    int(stop_id),
                    strategy,
                    trade["side"],
                    float(current_position["position"]),
                    float(trade["stop_price"]),
                )
            )
            if current_error is None:
                return
            await self.safety_close(
                trade,
                strategy,
                current_position,
                (
                    "missing_stop_emergency_close"
                    if current_error == "missing"
                    else "invalid_stop_emergency_close"
                ),
                f"invalid exchange stop: {current_error}",
                cancel_stop=current_error != "missing",
            )

    async def process_signal(self, signal: sqlite3.Row) -> None:
        signal_id = int(signal["id"])
        strategy = STRATEGIES.get(signal["strategy_id"])
        if strategy is None or signal["symbol"] != strategy.symbol:
            self.decide(signal_id, "skip", "strategy not live-enabled")
            return
        if signal["capture_status"] != "captured":
            self.decide(signal_id, "skip", f"capture {signal['capture_status']}")
            return
        if not self.enabled:
            self.decide(signal_id, "skip", "live runner disabled")
            return

        trade = self.open_trade(str(signal["strategy_id"]))
        action = signal["action"]
        side = signal["side"]
        if trade is not None:
            if (
                (action == "exit" and trade["side"] == side)
                or (action == "entry" and trade["side"] != side)
            ):
                reverse = action == "entry" and trade["side"] != side
                closed = await self.close(
                    trade,
                    "reverse_signal" if reverse else "strategy_exit",
                    signal_id,
                )
                if not closed:
                    self.decide(signal_id, "error", "close failed", int(trade["id"]))
                    return
                if reverse:
                    reason, trade_id = await self.enter(signal, strategy, side)
                    self.decide(
                        signal_id,
                        "enter" if reason == "entered" else "skip",
                        reason,
                        trade_id,
                    )
                else:
                    self.decide(signal_id, "close", "strategy exit", int(trade["id"]))
                return
            self.decide(
                signal_id,
                "skip",
                "same strategy already has this side open",
                int(trade["id"]),
            )
            return

        if action == "exit":
            self.decide(signal_id, "skip", "no matching live position")
            return
        reason, trade_id = await self.enter(signal, strategy, side)
        self.decide(
            signal_id,
            "enter" if reason == "entered" else "skip",
            reason,
            trade_id,
        )

    def signal_market_id(self, signal: sqlite3.Row) -> int:
        strategy = STRATEGIES.get(str(signal["strategy_id"]))
        if strategy is not None:
            return strategy.market_id
        return -int(signal["id"]) - 1

    async def process_signal_group(
        self,
        market_id: int,
        signals: list[sqlite3.Row],
    ) -> None:
        async with self.signal_slots:
            async with self.market_lock(market_id):
                for signal_row in signals:
                    try:
                        await self.process_signal(signal_row)
                    except Exception as exc:
                        self.decide(
                            int(signal_row["id"]),
                            "error",
                            f"unexpected runner error: {exc}",
                        )
                        self.log(
                            "signal_error",
                            signal_id=signal_row["id"],
                            market_id=market_id,
                            error=str(exc),
                        )

    async def process_signal_batch(
        self,
        signals: list[sqlite3.Row],
    ) -> None:
        groups: dict[int, list[sqlite3.Row]] = {}
        for signal_row in signals:
            groups.setdefault(
                self.signal_market_id(signal_row),
                [],
            ).append(signal_row)
        started = time.monotonic()
        await asyncio.gather(
            *(
                self.process_signal_group(market_id, rows)
                for market_id, rows in groups.items()
            )
        )
        self.log(
            "signal_batch_processed",
            signals=len(signals),
            markets=len(groups),
            elapsed_ms=round((time.monotonic() - started) * 1000),
        )

    async def reconcile_loop(self) -> None:
        while self.running:
            started = time.monotonic()
            try:
                trades = self.open_trades()
                if trades:
                    selected = trades[self.reconcile_cursor % len(trades)]
                    self.reconcile_cursor += 1
                    market_id = int(selected["market_id"])
                    async with self.market_lock(market_id):
                        trade = self.db.execute(
                            """SELECT * FROM lighter_lux_live_trades
                               WHERE id=?
                                 AND status IN ('opening','open','closing')""",
                            (selected["id"],),
                        ).fetchone()
                        if trade is not None:
                            await self.reconcile_open_trade(trade)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.state("error", f"reconcile: {exc}")
                self.log("reconcile_error", error=str(exc))
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(0.05, 1.0 - elapsed))

    async def initialize(self) -> None:
        await self.load_market_meta()
        error = self.signer.check_client()
        if error is not None:
            raise RuntimeError(f"signer check failed: {error}")
        limits = await lighter.AccountApi(self.api).account_limits(
            account_index=self.account_index,
            authorization=await self.auth(),
        )
        limit_data = limits.to_dict()
        if (
            limit_data.get("user_tier") != "standard"
            or int(limit_data.get("current_maker_fee_tick", 0)) != 0
            or int(limit_data.get("current_taker_fee_tick", 0)) != 0
        ):
            raise RuntimeError(f"non-zero fee account: {limit_data}")
        state = self.db.execute(
            "SELECT * FROM lighter_lux_live_state WHERE id=1"
        ).fetchone()
        if state["last_signal_id"] is None:
            latest = self.db.execute(
                "SELECT COALESCE(MAX(id),0) AS id FROM lighter_lux_signals"
            ).fetchone()["id"]
            now = int(time.time() * 1000)
            self.db.execute(
                """UPDATE lighter_lux_live_state
                   SET last_signal_id=?,started_at=?,enabled=?,status='armed',
                       heartbeat_at=?,last_error=NULL WHERE id=1""",
                (latest, now, 1 if self.enabled else 0, now),
            )
            self.log("cursor_initialized", last_signal_id=latest)
        for trade in self.open_trades():
            await self.reconcile_open_trade(trade)
        trades = self.open_trades()
        positions = await self.positions()
        managed_markets = {int(trade["market_id"]) for trade in trades}
        orphan_markets = sorted(
            int(position.get("market_id", -1))
            for position in positions
            if int(position.get("market_id", -1)) not in managed_markets
        )
        if orphan_markets:
            raise RuntimeError(
                f"orphan exchange positions in markets {orphan_markets}; "
                "refusing to arm"
            )
        for trade in trades:
            if int(trade["market_id"]) in managed_markets:
                self.leverage_ready.add(int(trade["market_id"]))
        self.state("armed")
        self.refresh_portfolio_risk()
        self.refresh_strategy_stats()
        self.log(
            "armed",
            enabled=self.enabled,
            notional=self.notional,
            leverage=self.leverage,
            daily_loss=self.daily_loss_usd,
            max_drawdown=self.max_drawdown_usd,
        )

    async def run(self) -> None:
        reconcile_task: asyncio.Task[None] | None = None
        try:
            await self.initialize()
            reconcile_task = asyncio.create_task(
                self.reconcile_loop(),
                name="lighter-live-reconcile",
            )
            while self.running:
                state = self.db.execute(
                    "SELECT last_signal_id FROM lighter_lux_live_state WHERE id=1"
                ).fetchone()
                signal_rows = self.db.execute(
                    """SELECT id,strategy_id,symbol,action,side,received_at,
                              capture_status,
                              source_price,buy_vwap_1000,sell_vwap_1000,
                              book_age_ms
                       FROM lighter_lux_signals
                       WHERE id>? ORDER BY id LIMIT ?""",
                    (
                        int(state["last_signal_id"]),
                        self.signal_batch_size,
                    ),
                ).fetchall()
                ready_rows: list[sqlite3.Row] = []
                for signal_row in signal_rows:
                    if signal_row["capture_status"] == "pending":
                        break
                    ready_rows.append(signal_row)
                if ready_rows:
                    await self.process_signal_batch(ready_rows)
                    self.db.execute(
                        """UPDATE lighter_lux_live_state
                           SET last_signal_id=?,heartbeat_at=?,status='armed',
                               last_error=NULL WHERE id=1""",
                        (
                            ready_rows[-1]["id"],
                            int(time.time() * 1000),
                        ),
                    )
                    continue
                if signal_rows:
                    await asyncio.sleep(0.05)
                    continue
                if time.monotonic() - self.last_heartbeat >= 5:
                    self.state("armed")
                    self.last_heartbeat = time.monotonic()
                await asyncio.sleep(0.05)
        finally:
            self.running = False
            if reconcile_task is not None:
                reconcile_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await reconcile_task
            await self.api.close()
            await self.signer.close()
            self.db.close()


async def main() -> None:
    runner = LiveRunner()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, setattr, runner, "running", False)
    await runner.run()


if __name__ == "__main__":
    asyncio.run(main())

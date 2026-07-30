#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Any


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def profit_factor(values: list[float]) -> float | None:
    gains = sum(value for value in values if value > 0)
    losses = -sum(value for value in values if value < 0)
    if losses == 0:
        return math.inf if gains > 0 else None
    return gains / losses


def max_drawdown(values: list[float]) -> float:
    peak = 0.0
    equity = 0.0
    drawdown = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return drawdown


def mean_confidence_lower(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = statistics.mean(values)
    standard_error = statistics.stdev(values) / math.sqrt(len(values))
    return mean - 1.96 * standard_error


def row_timestamp(row: dict[str, Any]) -> int:
    return int(
        finite_number(row.get("exitAt"))
        or finite_number(row.get("closedAt"))
        or finite_number(row.get("signalAt"))
        or finite_number(row.get("openedAt"))
        or 0
    )


def technical_failure_reason(row: dict[str, Any]) -> str | None:
    if finite_number(row.get("realizedNetBps")) is not None:
        return None
    reason = str(row.get("reason") or "")
    unsafe_fragments = (
        "hedge_timeout",
        "unhedged",
        "exit_without_pair",
    )
    return reason if any(fragment in reason for fragment in unsafe_fragments) else None


def independent_episode_values(
    rows: list[dict[str, Any]],
    independence_ms: int,
) -> list[float]:
    episodes: list[list[float]] = []
    episode_started_at: int | None = None
    for row in rows:
        value = finite_number(row.get("realizedNetBps"))
        at = row_timestamp(row)
        if value is None:
            continue
        if (
            not episodes
            or episode_started_at is None
            or at - episode_started_at >= independence_ms
        ):
            episodes.append([value])
            episode_started_at = at
        else:
            episodes[-1].append(value)
    return [statistics.mean(episode) for episode in episodes]


def execution_evidence(
    events: list[dict[str, Any]],
    *,
    route_id: str,
    observation_started_at_ms: int,
) -> dict[str, int]:
    eligible = sorted(
        [
            event
            for event in events
            if event.get("routeId") == route_id
            and int(finite_number(event.get("at")) or 0)
            >= observation_started_at_ms
        ],
        key=lambda event: int(finite_number(event.get("at")) or 0),
    )
    quotes_activated_since_last_progress = 0
    activated_exposure_since_last_progress_ms = 0
    active_quote_started_at: dict[str, int] = {}
    for event in eligible:
        event_type = event.get("type")
        at = int(finite_number(event.get("at")) or 0)
        quote_id = str(event.get("quoteId") or "")
        if event_type == "quote_activated":
            quotes_activated_since_last_progress += 1
            if quote_id:
                active_quote_started_at[quote_id] = at
        elif event_type in ("queue_progress", "queue_filled"):
            quotes_activated_since_last_progress = 0
            activated_exposure_since_last_progress_ms = 0
            active_quote_started_at = {
                active_quote_id: at
                for active_quote_id in active_quote_started_at
            }
            if event_type == "queue_filled" and quote_id:
                active_quote_started_at.pop(quote_id, None)
        elif event_type in (
            "edge_cancelled",
            "quote_expired",
            "placement_rejected",
        ):
            started_at = active_quote_started_at.pop(quote_id, None)
            if started_at is not None:
                activated_exposure_since_last_progress_ms += max(
                    0,
                    at - started_at,
                )
    return {
        "quotesCreated": sum(
            event.get("type") == "quote_created" for event in eligible
        ),
        "quotesActivated": sum(
            event.get("type") == "quote_activated" for event in eligible
        ),
        "queueProgressEvents": sum(
            event.get("type") == "queue_progress" for event in eligible
        ),
        "queueFills": sum(
            event.get("type") == "queue_filled" for event in eligible
        ),
        "tradeThroughEntryFills": sum(
            is_trade_through_entry_fill(event) for event in eligible
        ),
        "quotesActivatedSinceLastProgress":
            quotes_activated_since_last_progress,
        # Only completed activation intervals are counted. This avoids
        # overstating exposure when a process restart leaves a historical
        # activation without a terminal event.
        "activatedExposureSinceLastProgressMs":
            activated_exposure_since_last_progress_ms,
    }


def is_trade_through_entry_fill(event: dict[str, Any]) -> bool:
    if (
        event.get("type") != "queue_filled"
        or event.get("stage") != "entry"
    ):
        return False
    quote_price = finite_number(event.get("price"))
    trade_price = finite_number(event.get("triggerTradePrice"))
    if quote_price is None or trade_price is None:
        return False
    tolerance = max(abs(quote_price) * 1e-10, 1e-12)
    side = str(event.get("side") or "").lower()
    return (
        side == "buy" and trade_price < quote_price - tolerance
    ) or (
        side == "sell" and trade_price > quote_price + tolerance
    )


def trade_through_entry_fill_times(
    events: list[dict[str, Any]],
    *,
    route_id: str,
    observation_started_at_ms: int,
) -> set[int]:
    return {
        int(finite_number(event.get("at")) or 0)
        for event in events
        if event.get("routeId") == route_id
        and int(finite_number(event.get("at")) or 0)
        >= observation_started_at_ms
        and is_trade_through_entry_fill(event)
    }


def maker_entry_fill_at(row: dict[str, Any]) -> int | None:
    match = re.match(r"^GM(\d+)-", str(row.get("id") or ""))
    return int(match.group(1)) if match else None


def evaluate(
    rows: list[dict[str, Any]],
    *,
    route_id: str,
    notional_usd: float,
    min_samples: int,
    min_profit_factor: float,
    max_drawdown_bps: float,
    independence_ms: int,
    observation_started_at_ms: int | None = None,
    now_ms: int | None = None,
    no_go_after_ms: int = 12 * 60 * 60 * 1000,
    hard_no_go_after_ms: int = 24 * 60 * 60 * 1000,
    min_trades_by_deadline: int = 3,
    negative_assessment_min_trades: int = 10,
    execution: dict[str, int] | None = None,
    max_activated_quotes_without_progress: int = 0,
    max_activated_exposure_without_progress_ms: int = 0,
    max_technical_failures: int = 0,
    require_trade_through_fills: bool = False,
    confirmed_entry_fill_times: set[int] | None = None,
) -> dict[str, Any]:
    evaluated_at = now_ms or int(time.time() * 1000)
    observation_started_at = observation_started_at_ms or evaluated_at
    row_cutoff_at = observation_started_at_ms or 0
    route_ids = {
        candidate.strip()
        for candidate in route_id.split(",")
        if candidate.strip()
    }
    realized = [
        row
        for row in rows
        if row.get("routeId") in route_ids
        and row_timestamp(row) >= row_cutoff_at
        and finite_number(row.get("realizedNetBps")) is not None
    ]
    confirmed_fill_times = confirmed_entry_fill_times or set()
    eligible = [
        row
        for row in realized
        if (
            not require_trade_through_fills
            or maker_entry_fill_at(row) in confirmed_fill_times
        )
    ]
    unconfirmed = [
        row
        for row in realized
        if row not in eligible
    ]
    eligible.sort(key=row_timestamp)
    technical_failures = [
        row
        for row in rows
        if row.get("routeId") in route_ids
        and row_timestamp(row) >= row_cutoff_at
        and technical_failure_reason(row) is not None
    ]
    technical_failures.sort(key=row_timestamp)
    trade_values = [
        float(finite_number(row["realizedNetBps"]))
        for row in eligible
    ]
    values = independent_episode_values(eligible, independence_ms)
    pf = profit_factor(values)
    confidence_lower = mean_confidence_lower(values)
    drawdown = max_drawdown(values)
    reasons: list[str] = []
    if len(values) < min_samples:
        reasons.append(f"samples {len(values)}/{min_samples}")
    if sum(trade_values) <= 0:
        reasons.append("cumulative net is not positive")
    if sum(values) <= 0:
        reasons.append("independent episode net is not positive")
    if pf is None or pf < min_profit_factor:
        reasons.append(
            "profit factor "
            f"{pf if pf is not None else 'n/a'} < {min_profit_factor}"
        )
    if confidence_lower is None or confidence_lower <= 0:
        reasons.append("95% mean lower bound is not positive")
    if drawdown > max_drawdown_bps:
        reasons.append(
            f"max drawdown {drawdown:.3f} bps > {max_drawdown_bps:.3f}"
        )
    no_go_reasons: list[str] = []
    elapsed_ms = max(0, evaluated_at - observation_started_at)
    if (
        no_go_after_ms > 0
        and elapsed_ms >= no_go_after_ms
        and len(trade_values) < min_trades_by_deadline
    ):
        no_go_reasons.append(
            "completed trades "
            f"{len(trade_values)}/{min_trades_by_deadline} "
            f"after {elapsed_ms / 3_600_000:.1f}h"
        )
    if (
        len(trade_values) >= negative_assessment_min_trades
        and sum(trade_values) <= 0
    ):
        no_go_reasons.append(
            f"cumulative net {sum(trade_values):.3f} bps "
            f"after {len(trade_values)} trades"
        )
    if (
        hard_no_go_after_ms > 0
        and elapsed_ms >= hard_no_go_after_ms
        and reasons
    ):
        no_go_reasons.append(
            "profit gate not passed after "
            f"{elapsed_ms / 3_600_000:.1f}h"
        )
    execution_metrics = execution or {
        "quotesCreated": 0,
        "quotesActivated": 0,
        "queueProgressEvents": 0,
        "queueFills": 0,
        "quotesActivatedSinceLastProgress": 0,
        "activatedExposureSinceLastProgressMs": 0,
    }
    activated_without_progress = execution_metrics.get(
        "quotesActivatedSinceLastProgress",
        (
            execution_metrics["quotesActivated"]
            if (
                execution_metrics["queueProgressEvents"] == 0
                and execution_metrics["queueFills"] == 0
            )
            else 0
        ),
    )
    if (
        max_activated_quotes_without_progress > 0
        and activated_without_progress
        >= max_activated_quotes_without_progress
    ):
        no_go_reasons.append(
            f"{activated_without_progress} activated quotes "
            "since last queue progress"
        )
    activated_exposure_without_progress_ms = execution_metrics.get(
        "activatedExposureSinceLastProgressMs",
        0,
    )
    if (
        max_activated_exposure_without_progress_ms > 0
        and activated_exposure_without_progress_ms
        >= max_activated_exposure_without_progress_ms
    ):
        no_go_reasons.append(
            "active quote exposure "
            f"{activated_exposure_without_progress_ms / 60_000:.1f}m "
            "since last queue progress"
        )
    if len(technical_failures) > max_technical_failures:
        no_go_reasons.append(
            f"technical execution failures {len(technical_failures)}"
            f"/{max_technical_failures}"
        )
    no_go = bool(no_go_reasons)
    ready = not reasons and not no_go
    by_coin: dict[str, list[float]] = defaultdict(list)
    for row, value in zip(eligible, trade_values):
        by_coin[str(row.get("coin") or "UNKNOWN")].append(value)
    return {
        "version": "venue-arb-shadow-gate-v2",
        "updatedAt": evaluated_at,
        "observationStartedAt": observation_started_at,
        "observationElapsedMs": elapsed_ms,
        "routeId": route_id,
        "notionalUsd": notional_usd,
        "ready": ready,
        "noGo": no_go,
        "decision": "GO" if ready else "NO_GO" if no_go else "OBSERVE",
        "reasons": reasons,
        "noGoReasons": no_go_reasons,
        "requirements": {
            "minSamples": min_samples,
            "minProfitFactor": min_profit_factor,
            "positiveCumulativeNet": True,
            "positiveMean95PctLowerBound": True,
            "maxDrawdownBps": max_drawdown_bps,
            "independenceMs": independence_ms,
            "noGoAfterMs": no_go_after_ms,
            "hardNoGoAfterMs": hard_no_go_after_ms,
            "minTradesByDeadline": min_trades_by_deadline,
            "negativeAssessmentMinTrades": negative_assessment_min_trades,
            "maxActivatedQuotesWithoutProgress":
                max_activated_quotes_without_progress,
            "maxActivatedExposureWithoutProgressMs":
                max_activated_exposure_without_progress_ms,
            "maxTechnicalFailures": max_technical_failures,
            "requireTradeThroughEntryFill":
                require_trade_through_fills,
        },
        "metrics": {
            "attempts": len(realized) + len(technical_failures),
            "samples": len(values),
            "trades": len(trade_values),
            "technicalFailures": len(technical_failures),
            "unconfirmedTrades": len(unconfirmed),
            "technicalFailuresByReason": dict(sorted({
                reason: sum(
                    technical_failure_reason(row) == reason
                    for row in technical_failures
                )
                for reason in {
                    str(technical_failure_reason(row))
                    for row in technical_failures
                }
            }.items())),
            "positive": sum(value > 0 for value in values),
            "winRatePct": (
                sum(value > 0 for value in values) / len(values) * 100
                if values
                else None
            ),
            "sumNetBps": sum(trade_values),
            "sumNetUsd": sum(trade_values) / 10_000 * notional_usd,
            "episodeSumNetBps": sum(values),
            "meanNetBps": statistics.mean(values) if values else None,
            "medianNetBps": statistics.median(values) if values else None,
            "mean95PctLowerBps": confidence_lower,
            "profitFactor": finite_number(pf),
            "profitFactorInfinite": pf == math.inf,
            "maxDrawdownBps": drawdown,
            "maxDrawdownUsd": drawdown / 10_000 * notional_usd,
        },
        "byCoin": {
            coin: {
                "samples": len(coin_values),
                "sumNetBps": sum(coin_values),
                "meanNetBps": statistics.mean(coin_values),
                "profitFactor": finite_number(profit_factor(coin_values)),
                "profitFactorInfinite": profit_factor(coin_values) == math.inf,
            }
            for coin, coin_values in sorted(by_coin.items())
        },
        "execution": execution_metrics,
    }


def read_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def self_test() -> None:
    losing = evaluate(
        [
            {"routeId": "a-b", "coin": "X", "realizedNetBps": 2, "exitAt": 1},
            {"routeId": "a-b", "coin": "X", "realizedNetBps": -5, "exitAt": 2},
        ],
        route_id="a-b",
        notional_usd=100,
        min_samples=2,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
    )
    assert losing["ready"] is False
    assert losing["metrics"]["sumNetUsd"] == -0.03
    winning_rows = [
        {
            "routeId": "a-b",
            "coin": "X",
            "realizedNetBps": 2 + (index % 3),
            "exitAt": (index + 1) * 60_000,
        }
        for index in range(30)
    ]
    winning = evaluate(
        winning_rows,
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
    )
    assert winning["ready"] is True
    assert winning["metrics"]["samples"] == 30
    assert round(winning["metrics"]["sumNetUsd"], 8) == 0.9
    clustered = evaluate(
        [
            {
                "routeId": "a-b",
                "coin": "X",
                "realizedNetBps": 2,
                "exitAt": 1,
            },
            {
                "routeId": "a-b",
                "coin": "Y",
                "realizedNetBps": 4,
                "exitAt": 10_001,
            },
            {
                "routeId": "a-b",
                "coin": "Z",
                "realizedNetBps": 5,
                "exitAt": 70_001,
            },
        ],
        route_id="a-b",
        notional_usd=100,
        min_samples=2,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
    )
    assert clustered["metrics"]["trades"] == 3
    assert clustered["metrics"]["samples"] == 2
    bidirectional = evaluate(
        [
            {
                "routeId": "a-b" if index % 2 == 0 else "b-a",
                "coin": "X",
                "realizedNetBps": 3,
                "exitAt": (index + 1) * 60_000,
            }
            for index in range(30)
        ],
        route_id="a-b,b-a",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
    )
    assert bidirectional["ready"] is True
    assert bidirectional["metrics"]["trades"] == 30
    assert clustered["metrics"]["episodeSumNetBps"] == 8
    no_go = evaluate(
        [],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        observation_started_at_ms=1_000,
        now_ms=12 * 60 * 60 * 1000 + 1_000,
        no_go_after_ms=12 * 60 * 60 * 1000,
        min_trades_by_deadline=3,
    )
    assert no_go["ready"] is False
    assert no_go["noGo"] is True
    assert no_go["decision"] == "NO_GO"
    assert "completed trades 0/3" in no_go["noGoReasons"][0]
    hard_no_go = evaluate(
        [
            {
                "routeId": "a-b",
                "coin": "X",
                "realizedNetBps": 1,
                "exitAt": 1,
            },
            {
                "routeId": "a-b",
                "coin": "Y",
                "realizedNetBps": 1,
                "exitAt": 60_001,
            },
            {
                "routeId": "a-b",
                "coin": "Z",
                "realizedNetBps": 1,
                "exitAt": 120_001,
            },
        ],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        observation_started_at_ms=1_000,
        now_ms=24 * 60 * 60 * 1000 + 1_000,
        no_go_after_ms=12 * 60 * 60 * 1000,
        hard_no_go_after_ms=24 * 60 * 60 * 1000,
        min_trades_by_deadline=3,
    )
    assert hard_no_go["decision"] == "NO_GO"
    assert "profit gate not passed" in hard_no_go["noGoReasons"][-1]
    hard_deadline_winner = evaluate(
        winning_rows,
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        observation_started_at_ms=1_000,
        now_ms=24 * 60 * 60 * 1000 + 1_000,
        hard_no_go_after_ms=24 * 60 * 60 * 1000,
    )
    assert hard_deadline_winner["decision"] == "GO"
    events = [
        {
            "routeId": "a-b",
            "at": 2_000 + index,
            "type": "quote_activated",
        }
        for index in range(100)
    ]
    evidence = execution_evidence(
        events,
        route_id="a-b",
        observation_started_at_ms=1_000,
    )
    unfillable = evaluate(
        [],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        execution=evidence,
        max_activated_quotes_without_progress=100,
    )
    assert unfillable["decision"] == "NO_GO"
    assert "since last queue progress" in unfillable["noGoReasons"][-1]
    evidence_with_progress = execution_evidence(
        events + [{
            "routeId": "a-b",
            "at": 3_000,
            "type": "queue_progress",
        }],
        route_id="a-b",
        observation_started_at_ms=1_000,
    )
    still_observing = evaluate(
        [],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        execution=evidence_with_progress,
        max_activated_quotes_without_progress=100,
    )
    assert still_observing["decision"] == "OBSERVE"
    exposure_events = [
        {
            "routeId": "a-b",
            "quoteId": "q1",
            "at": 2_000,
            "type": "quote_activated",
        },
        {
            "routeId": "a-b",
            "quoteId": "q1",
            "at": 32_000,
            "type": "quote_expired",
        },
        {
            "routeId": "a-b",
            "quoteId": "q2",
            "at": 40_000,
            "type": "quote_activated",
        },
        {
            "routeId": "a-b",
            "quoteId": "q2",
            "at": 70_000,
            "type": "edge_cancelled",
        },
    ]
    exposure_evidence = execution_evidence(
        exposure_events,
        route_id="a-b",
        observation_started_at_ms=1_000,
    )
    assert exposure_evidence[
        "activatedExposureSinceLastProgressMs"
    ] == 60_000
    exposure_no_go = evaluate(
        [],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        execution=exposure_evidence,
        max_activated_exposure_without_progress_ms=60_000,
    )
    assert exposure_no_go["decision"] == "NO_GO"
    assert "active quote exposure 1.0m" in (
        exposure_no_go["noGoReasons"][-1]
    )
    reset_exposure_evidence = execution_evidence(
        exposure_events + [
            {
                "routeId": "a-b",
                "quoteId": "q3",
                "at": 80_000,
                "type": "quote_activated",
            },
            {
                "routeId": "a-b",
                "quoteId": "q3",
                "at": 90_000,
                "type": "queue_progress",
            },
            {
                "routeId": "a-b",
                "quoteId": "q3",
                "at": 105_000,
                "type": "quote_expired",
            },
            {
                "routeId": "a-b",
                "quoteId": "dangling",
                "at": 110_000,
                "type": "quote_activated",
            },
        ],
        route_id="a-b",
        observation_started_at_ms=1_000,
    )
    assert reset_exposure_evidence[
        "activatedExposureSinceLastProgressMs"
    ] == 15_000
    stalled_again_events = events + [{
        "routeId": "a-b",
        "at": 3_000,
        "type": "queue_filled",
    }] + [
        {
            "routeId": "a-b",
            "at": 4_000 + index,
            "type": "quote_activated",
        }
        for index in range(100)
    ]
    stalled_again = evaluate(
        [],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        execution=execution_evidence(
            stalled_again_events,
            route_id="a-b",
            observation_started_at_ms=1_000,
        ),
        max_activated_quotes_without_progress=100,
    )
    assert stalled_again["decision"] == "NO_GO"
    assert stalled_again["execution"][
        "quotesActivatedSinceLastProgress"
    ] == 100
    technical_failure = evaluate(
        [{
            "routeId": "a-b",
            "coin": "X",
            "realizedNetBps": None,
            "closedAt": 2_000,
            "reason": "exit_hedge_timeout",
        }],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        observation_started_at_ms=1_000,
        now_ms=3_000,
    )
    assert technical_failure["decision"] == "NO_GO"
    assert technical_failure["metrics"]["technicalFailures"] == 1
    assert "technical execution failures 1/0" in (
        technical_failure["noGoReasons"][-1]
    )
    pre_observation_failure = evaluate(
        [{
            "routeId": "a-b",
            "coin": "X",
            "realizedNetBps": None,
            "closedAt": 999,
            "reason": "exit_hedge_timeout",
        }],
        route_id="a-b",
        notional_usd=100,
        min_samples=30,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=60_000,
        observation_started_at_ms=1_000,
        now_ms=3_000,
    )
    assert pre_observation_failure["decision"] == "OBSERVE"
    assert pre_observation_failure["metrics"]["technicalFailures"] == 0
    confidence_events = [
        {
            "routeId": "a-b",
            "at": 2_000,
            "type": "queue_filled",
            "stage": "entry",
            "side": "buy",
            "price": 100,
            "triggerTradePrice": 99.99,
        },
        {
            "routeId": "a-b",
            "at": 3_000,
            "type": "queue_filled",
            "stage": "entry",
            "side": "sell",
            "price": 101,
            "triggerTradePrice": 101,
        },
    ]
    confirmed = trade_through_entry_fill_times(
        confidence_events,
        route_id="a-b",
        observation_started_at_ms=1_000,
    )
    strict_fill_evidence = evaluate(
        [
            {
                "id": "GM2000-X-long",
                "routeId": "a-b",
                "coin": "X",
                "realizedNetBps": 5,
                "closedAt": 4_000,
            },
            {
                "id": "GM3000-X-short",
                "routeId": "a-b",
                "coin": "X",
                "realizedNetBps": 5,
                "closedAt": 5_000,
            },
        ],
        route_id="a-b",
        notional_usd=100,
        min_samples=2,
        min_profit_factor=1.2,
        max_drawdown_bps=10,
        independence_ms=1,
        observation_started_at_ms=1_000,
        now_ms=6_000,
        require_trade_through_fills=True,
        confirmed_entry_fill_times=confirmed,
        execution=execution_evidence(
            confidence_events,
            route_id="a-b",
            observation_started_at_ms=1_000,
        ),
    )
    assert strict_fill_evidence["metrics"]["trades"] == 1
    assert strict_fill_evidence["metrics"]["unconfirmedTrades"] == 1
    assert strict_fill_evidence["execution"]["tradeThroughEntryFills"] == 1
    assert strict_fill_evidence["ready"] is False
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "gate.json"
        atomic_json(path, winning)
        assert json.loads(path.read_text())["ready"] is True
    print("venue-arb-shadow-gate self-test ok")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--data-dir",
        default=os.getenv(
            "VENUE_ARB_GATE_DATA_DIR",
            "/home/trader/apps/venue-arb-tokyo/data/pacifica-extended-shadow",
        ),
    )
    parser.add_argument(
        "--route",
        default=os.getenv("VENUE_ARB_GATE_ROUTE", "pacifica-extended"),
    )
    parser.add_argument(
        "--input-file",
        default=os.getenv(
            "VENUE_ARB_GATE_INPUT_FILE",
            "shadow-execution-v4.ndjson",
        ),
    )
    parser.add_argument(
        "--output-file",
        default=os.getenv("VENUE_ARB_GATE_OUTPUT_FILE", "gate-status.json"),
    )
    parser.add_argument(
        "--notional",
        type=float,
        default=float(os.getenv("VENUE_ARB_GATE_NOTIONAL_USD", "100")),
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=int(os.getenv("VENUE_ARB_GATE_MIN_SAMPLES", "30")),
    )
    parser.add_argument(
        "--min-profit-factor",
        type=float,
        default=float(os.getenv("VENUE_ARB_GATE_MIN_PROFIT_FACTOR", "1.2")),
    )
    parser.add_argument(
        "--max-drawdown-bps",
        type=float,
        default=float(os.getenv("VENUE_ARB_GATE_MAX_DRAWDOWN_BPS", "50")),
    )
    parser.add_argument(
        "--independence-ms",
        type=int,
        default=int(os.getenv("VENUE_ARB_GATE_INDEPENDENCE_MS", "60000")),
    )
    parser.add_argument(
        "--observation-started-at-ms",
        type=int,
        default=int(os.getenv(
            "VENUE_ARB_GATE_OBSERVATION_STARTED_AT_MS",
            "0",
        )),
    )
    parser.add_argument(
        "--no-go-after-hours",
        type=float,
        default=float(os.getenv("VENUE_ARB_GATE_NO_GO_AFTER_HOURS", "12")),
    )
    parser.add_argument(
        "--min-trades-by-deadline",
        type=int,
        default=int(
            os.getenv("VENUE_ARB_GATE_MIN_TRADES_BY_DEADLINE", "3")
        ),
    )
    parser.add_argument(
        "--hard-no-go-after-hours",
        type=float,
        default=float(
            os.getenv("VENUE_ARB_GATE_HARD_NO_GO_AFTER_HOURS", "24")
        ),
    )
    parser.add_argument(
        "--negative-assessment-min-trades",
        type=int,
        default=int(
            os.getenv("VENUE_ARB_GATE_NEGATIVE_ASSESSMENT_MIN_TRADES", "10")
        ),
    )
    parser.add_argument(
        "--events-file",
        default=os.getenv("VENUE_ARB_GATE_EVENTS_FILE", ""),
    )
    parser.add_argument(
        "--max-activated-quotes-without-progress",
        type=int,
        default=int(os.getenv(
            "VENUE_ARB_GATE_MAX_ACTIVATED_QUOTES_WITHOUT_PROGRESS",
            "0",
        )),
    )
    parser.add_argument(
        "--max-technical-failures",
        type=int,
        default=int(os.getenv(
            "VENUE_ARB_GATE_MAX_TECHNICAL_FAILURES",
            "0",
        )),
    )
    parser.add_argument(
        "--max-activated-exposure-without-progress-ms",
        type=int,
        default=int(os.getenv(
            "VENUE_ARB_GATE_MAX_ACTIVATED_EXPOSURE_WITHOUT_PROGRESS_MS",
            "0",
        )),
    )
    parser.add_argument(
        "--require-trade-through-fills",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_GATE_REQUIRE_TRADE_THROUGH_FILLS",
            "false",
        ).lower() in ("1", "true", "yes"),
    )
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    data_dir = Path(args.data_dir)
    output_path = data_dir / args.output_file
    previous: dict[str, Any] = {}
    if output_path.exists():
        try:
            parsed = json.loads(output_path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                previous = parsed
        except (json.JSONDecodeError, OSError):
            pass
    now_ms = int(time.time() * 1000)
    observation_started_at = int(
        finite_number(previous.get("observationStartedAt"))
        or (
            args.observation_started_at_ms
            if args.observation_started_at_ms > 0
            else 0
        )
        or now_ms
    )
    events = (
        read_rows(data_dir / args.events_file)
        if args.events_file
        else []
    )
    result = evaluate(
        read_rows(data_dir / args.input_file),
        route_id=args.route,
        notional_usd=args.notional,
        min_samples=args.min_samples,
        min_profit_factor=args.min_profit_factor,
        max_drawdown_bps=args.max_drawdown_bps,
        independence_ms=args.independence_ms,
        observation_started_at_ms=observation_started_at,
        now_ms=now_ms,
        no_go_after_ms=max(
            0,
            int(args.no_go_after_hours * 60 * 60 * 1000),
        ),
        hard_no_go_after_ms=max(
            0,
            int(args.hard_no_go_after_hours * 60 * 60 * 1000),
        ),
        min_trades_by_deadline=max(0, args.min_trades_by_deadline),
        negative_assessment_min_trades=max(
            1,
            args.negative_assessment_min_trades,
        ),
        execution=execution_evidence(
            events,
            route_id=args.route,
            observation_started_at_ms=observation_started_at,
        ),
        max_activated_quotes_without_progress=max(
            0,
            args.max_activated_quotes_without_progress,
        ),
        max_activated_exposure_without_progress_ms=max(
            0,
            args.max_activated_exposure_without_progress_ms,
        ),
        max_technical_failures=max(0, args.max_technical_failures),
        require_trade_through_fills=args.require_trade_through_fills,
        confirmed_entry_fill_times=trade_through_entry_fill_times(
            events,
            route_id=args.route,
            observation_started_at_ms=observation_started_at,
        ),
    )
    atomic_json(output_path, result)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()

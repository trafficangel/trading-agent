#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
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


def evaluate(
    rows: list[dict[str, Any]],
    *,
    route_id: str,
    notional_usd: float,
    min_samples: int,
    min_profit_factor: float,
    max_drawdown_bps: float,
) -> dict[str, Any]:
    eligible = [
        row
        for row in rows
        if row.get("routeId") == route_id
        and finite_number(row.get("realizedNetBps")) is not None
    ]
    eligible.sort(
        key=lambda row: int(
            finite_number(row.get("exitAt"))
            or finite_number(row.get("closedAt"))
            or 0
        )
    )
    values = [
        float(finite_number(row["realizedNetBps"]))
        for row in eligible
    ]
    pf = profit_factor(values)
    confidence_lower = mean_confidence_lower(values)
    drawdown = max_drawdown(values)
    reasons: list[str] = []
    if len(values) < min_samples:
        reasons.append(f"samples {len(values)}/{min_samples}")
    if sum(values) <= 0:
        reasons.append("cumulative net is not positive")
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
    by_coin: dict[str, list[float]] = defaultdict(list)
    for row, value in zip(eligible, values):
        by_coin[str(row.get("coin") or "UNKNOWN")].append(value)
    return {
        "version": "venue-arb-shadow-gate-v1",
        "updatedAt": int(time.time() * 1000),
        "routeId": route_id,
        "notionalUsd": notional_usd,
        "ready": not reasons,
        "reasons": reasons,
        "requirements": {
            "minSamples": min_samples,
            "minProfitFactor": min_profit_factor,
            "positiveCumulativeNet": True,
            "positiveMean95PctLowerBound": True,
            "maxDrawdownBps": max_drawdown_bps,
        },
        "metrics": {
            "samples": len(values),
            "positive": sum(value > 0 for value in values),
            "winRatePct": (
                sum(value > 0 for value in values) / len(values) * 100
                if values
                else None
            ),
            "sumNetBps": sum(values),
            "sumNetUsd": sum(values) / 10_000 * notional_usd,
            "meanNetBps": statistics.mean(values) if values else None,
            "medianNetBps": statistics.median(values) if values else None,
            "mean95PctLowerBps": confidence_lower,
            "profitFactor": pf,
            "maxDrawdownBps": drawdown,
            "maxDrawdownUsd": drawdown / 10_000 * notional_usd,
        },
        "byCoin": {
            coin: {
                "samples": len(coin_values),
                "sumNetBps": sum(coin_values),
                "meanNetBps": statistics.mean(coin_values),
                "profitFactor": profit_factor(coin_values),
            }
            for coin, coin_values in sorted(by_coin.items())
        },
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
    )
    assert losing["ready"] is False
    assert losing["metrics"]["sumNetUsd"] == -0.03
    winning_rows = [
        {
            "routeId": "a-b",
            "coin": "X",
            "realizedNetBps": 2 + (index % 3),
            "exitAt": index,
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
    )
    assert winning["ready"] is True
    assert winning["metrics"]["samples"] == 30
    assert round(winning["metrics"]["sumNetUsd"], 8) == 0.9
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
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    data_dir = Path(args.data_dir)
    result = evaluate(
        read_rows(data_dir / args.input_file),
        route_id=args.route,
        notional_usd=args.notional,
        min_samples=args.min_samples,
        min_profit_factor=args.min_profit_factor,
        max_drawdown_bps=args.max_drawdown_bps,
    )
    atomic_json(data_dir / args.output_file, result)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()

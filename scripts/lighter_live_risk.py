"""Pure risk policy for the isolated Lighter Real canary."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Collection, Mapping, Sequence


NATIVE_PROMOTION_REPORT_VERSION = "lighter-native-promotion-audit-v4"
NATIVE_PROMOTION_NOTIONAL_USD = 100.0
NATIVE_HISTORICAL_EVIDENCE_VERSION = "lighter-native-historical-evidence-v1"
NATIVE_HISTORICAL_REPORT_SHA256 = (
    "8327517f63cd44b508aa8824e5393ad46f48ab129223e2d4fbaeaa320d496f4e"
)
NATIVE_HISTORICAL_SUPPLEMENT_SHA256 = (
    "afa6e2b1de6b64fd7917eb033177db4d1654538f54262b0bcfca0b110ea0fed1"
)
NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256 = (
    "cb507f67f7e34d005b1b5360dd6aede718d9f8a1d6cf6ebba037b84b9018f445"
)
NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256 = (
    "ea089a8d09788ca652e6cc7ce4543dd8f65ef269375bcf3405329ec17239c74f"
)
NATIVE_HISTORICAL_RSI_SUPPLEMENT_SHA256 = (
    "831526b9c633b1d9020ee84b7893d52566751eea11d3b5e8c962cb8ff6270e54"
)
NATIVE_LATENCY_EVIDENCE_VERSION = "lighter-native-entry-delay-audit-v1"
NATIVE_LATENCY_EVIDENCE_SHA256 = (
    "a6d1cf2b5e8aa5625fe001eb87f6334e223a9f3879b6921ee336156c19ac2ded"
)
NATIVE_LATENCY_SUPPLEMENT_SHA256_BY_STRATEGY = {
    "xlm-vwz60-willr14-ema400-challenger": (
        "89a0453021b9a9adcadead95b7a02c7da38a1facefd2f17a65206653566b4052"
    ),
    "hype-vwz60-stoch14-ema400-challenger": (
        "93b9abca3696ea12aaeb61acac29c76aa91ac89def21a9dcb2955e57ad2360d9"
    ),
}
NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS = 90_000
NATIVE_PROMOTION_GATE = {
    "targetClosed": 20.0,
    "minDurationDays": 7.0,
    "minClosedPerSide": 3.0,
    "minProfitFactor": 1.2,
    "maxDrawdownPct": 5.0,
    "maxCaptureErrorRatePct": 2.0,
    "maxP95BookAgeMs": 2_000.0,
    "recentDecayMinClosed": 40.0,
    "recentClosedWindow": 20.0,
    "minRecentSignalsForHealth": 20.0,
    "recentSignalWindow": 100.0,
}


def native_canary_config_error(notional_usd: float, leverage: int) -> str | None:
    """Keep every Native Real canary inside the frozen capital envelope."""
    if float(notional_usd) != NATIVE_PROMOTION_NOTIONAL_USD:
        return (
            f"native canary notional ${float(notional_usd):g} "
            f"!= ${NATIVE_PROMOTION_NOTIONAL_USD:g}"
        )
    if int(leverage) < 1 or int(leverage) > 10:
        return f"native canary leverage {int(leverage)}x outside 1x..10x"
    return None


def native_runner_liveness_error(
    status: object,
    strategy_id: str,
    now_ms: int,
) -> str | None:
    """Require a fresh, successful completed-bar decision before Native Real."""
    if not isinstance(status, dict) or status.get("version") != 1:
        return "native runner status unavailable"
    try:
        heartbeat_at = int(status.get("heartbeatAt"))
    except (TypeError, ValueError):
        return "native runner heartbeat missing"
    heartbeat_age = now_ms - heartbeat_at
    if heartbeat_age < -300_000:
        return "native runner heartbeat is in the future"
    if heartbeat_age > NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS:
        return f"native runner heartbeat stale: {heartbeat_age}ms"
    evaluations = status.get("evaluations")
    if not isinstance(evaluations, list):
        return "native runner evaluations missing"
    matching = [
        row
        for row in evaluations
        if isinstance(row, dict) and row.get("strategyId") == strategy_id
    ]
    if len(matching) != 1:
        return "native runner strategy evaluation missing or duplicated"
    row = matching[0]
    try:
        timeframe_minutes = int(row.get("timeframeMinutes", 5))
        attempted_at = int(row.get("attemptedBarTime"))
        bar_at = int(row.get("barTime"))
        evaluated_at = int(row.get("evaluatedAt"))
    except (TypeError, ValueError):
        return "native runner strategy timestamps missing"
    if timeframe_minutes not in (1, 5):
        return "native runner strategy timeframe invalid"
    timeframe_ms = timeframe_minutes * 60_000
    evaluation_age = now_ms - evaluated_at
    bar_age = now_ms - attempted_at
    if evaluation_age < -300_000 or bar_age < -300_000:
        return "native runner strategy evaluation is in the future"
    if evaluation_age > timeframe_ms + NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS:
        return f"native runner strategy evaluation stale: {evaluation_age}ms"
    if bar_age > 2 * timeframe_ms + NATIVE_RUNNER_HEARTBEAT_MAX_AGE_MS:
        return f"native runner strategy decision bar stale: {bar_age}ms"
    if bar_at != attempted_at:
        return "native runner latest attempted bar was not evaluated"
    if row.get("state") in ("data_error", "evaluation_error") or row.get("error") is not None:
        return "native runner strategy evaluation failed"
    return None


def native_registry_error(
    market_ids_by_strategy: Mapping[str, int],
    native_strategy_ids: Collection[str],
) -> str | None:
    """Reject missing registrations and one-way market ownership collisions."""
    owner_by_market: dict[int, str] = {}
    for strategy_id in sorted(native_strategy_ids):
        market_id = market_ids_by_strategy.get(strategy_id)
        if market_id is None:
            return f"native strategy {strategy_id} is not executor-registered"
        owner = owner_by_market.get(int(market_id))
        if owner is not None:
            return (
                f"native market {int(market_id)} collision: "
                f"{owner} and {strategy_id}"
            )
        owner_by_market[int(market_id)] = strategy_id
    return None


@dataclass(frozen=True)
class StrategyRiskPolicy:
    pause_sample: int = 10
    gate_sample: int = 20
    maximum_drawdown_usd: float = 5.0
    recent_window: int = 10
    minimum_watch_profit_factor: float = 1.0
    minimum_pass_profit_factor: float = 1.2


@dataclass(frozen=True)
class PnlStats:
    closed: int
    net: float
    profit_factor: float | None
    first_half: float
    second_half: float
    equity_peak: float
    current_drawdown: float
    max_drawdown: float


@dataclass(frozen=True)
class StrategyRiskDecision:
    stats: PnlStats
    recent: PnlStats
    pause: bool
    passed: bool
    gate_status: str
    reason: str | None


def native_promotion_report_error(
    report: object,
    strategy_id: str,
    now_ms: int,
    max_age_ms: int,
) -> str | None:
    """Validate the complete frozen Shadow -> Real contract fail-closed.

    The executor deliberately carries its own reviewed copy of the gate. If
    the TypeScript audit schema or any qualifying threshold changes, Native
    entries stop until the new contract is explicitly reviewed here. Exits do
    not call this function.
    """
    if not isinstance(report, dict):
        return "native promotion report is not an object"
    if report.get("version") != NATIVE_PROMOTION_REPORT_VERSION:
        return "native promotion report version mismatch"
    if report.get("autoPromotion") is not False:
        return "native promotion report autoPromotion invariant failed"
    try:
        notional = float(report.get("shadowNotionalUsd"))
    except (TypeError, ValueError):
        return "native promotion report notional missing"
    if notional != NATIVE_PROMOTION_NOTIONAL_USD:
        return f"native promotion report notional {notional:g} != 100"

    gate = report.get("gate")
    if not isinstance(gate, dict):
        return "native promotion report gate missing"
    for key, expected in NATIVE_PROMOTION_GATE.items():
        try:
            actual = float(gate.get(key))
        except (TypeError, ValueError):
            return f"native promotion gate {key} missing"
        if actual != expected:
            return (
                f"native promotion gate {key} changed: "
                f"{actual:g} != {expected:g}"
            )

    generated_raw = report.get("generatedAt")
    if not isinstance(generated_raw, str):
        return "native promotion report timestamp missing"
    try:
        generated = datetime.fromisoformat(generated_raw.replace("Z", "+00:00"))
    except ValueError:
        return "native promotion report timestamp invalid"
    if generated.tzinfo is None:
        generated = generated.replace(tzinfo=timezone.utc)
    age_ms = int(now_ms - generated.timestamp() * 1000)
    if age_ms < -5 * 60 * 1000:
        return "native promotion report timestamp is in the future"
    if age_ms > max_age_ms:
        return f"native promotion report stale: {age_ms // 60000}m"

    eligible = report.get("eligibleStrategyIds")
    if not isinstance(eligible, list) or any(
        not isinstance(value, str) for value in eligible
    ):
        return "native promotion eligibleStrategyIds invalid"
    if strategy_id not in eligible:
        return "native Shadow promotion gate not passed"

    historical = report.get("historicalEvidence")
    if not isinstance(historical, dict):
        return "native historical evidence missing"
    if historical.get("version") != NATIVE_HISTORICAL_EVIDENCE_VERSION:
        return "native historical evidence version mismatch"
    if historical.get("sourceSha256") != NATIVE_HISTORICAL_REPORT_SHA256:
        return "native historical evidence hash mismatch"
    if historical.get("supplementalSourceSha256") != NATIVE_HISTORICAL_SUPPLEMENT_SHA256:
        return "native supplemental historical evidence hash mismatch"
    if (
        historical.get("xlmSupplementalSourceSha256")
        != NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256
    ):
        return "native XLM supplemental historical evidence hash mismatch"
    if (
        historical.get("dataSupplementalSourceSha256")
        != NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256
    ):
        return "native DATA supplemental historical evidence hash mismatch"
    if (
        historical.get("rsiSupplementalSourceSha256")
        != NATIVE_HISTORICAL_RSI_SUPPLEMENT_SHA256
    ):
        return "native RSI supplemental historical evidence hash mismatch"

    latency = report.get("latencyEvidence")
    if not isinstance(latency, dict):
        return "native latency evidence missing"
    if latency.get("version") != NATIVE_LATENCY_EVIDENCE_VERSION:
        return "native latency evidence version mismatch"
    if latency.get("sourceSha256") != NATIVE_LATENCY_EVIDENCE_SHA256:
        return "native latency evidence hash mismatch"
    expected_latency_supplement = NATIVE_LATENCY_SUPPLEMENT_SHA256_BY_STRATEGY.get(
        strategy_id
    )
    if expected_latency_supplement is not None:
        supplemental_sources = latency.get("supplementalSources")
        if not isinstance(supplemental_sources, list):
            return "native latency supplemental evidence missing"
        matching_supplements = [
            source
            for source in supplemental_sources
            if isinstance(source, dict)
            and isinstance(source.get("strategyIds"), list)
            and strategy_id in source.get("strategyIds")
        ]
        if len(matching_supplements) != 1:
            return "native latency supplemental evidence missing or duplicated"
        if matching_supplements[0].get("sourceSha256") != expected_latency_supplement:
            return "native latency supplemental evidence hash mismatch"

    runner_liveness = report.get("runnerLiveness")
    if not isinstance(runner_liveness, dict) or runner_liveness.get("passed") is not True:
        return "native runner liveness evidence not passed"
    healthy_strategy_ids = runner_liveness.get("healthyStrategyIds")
    if not isinstance(healthy_strategy_ids, list) or strategy_id not in healthy_strategy_ids:
        return "native runner strategy liveness evidence missing"

    strategies = report.get("strategies")
    if not isinstance(strategies, list):
        return "native promotion strategies missing"
    matching = [
        row
        for row in strategies
        if isinstance(row, dict) and row.get("strategyId") == strategy_id
    ]
    if len(matching) != 1:
        return "native promotion strategy evidence missing or duplicated"
    row = matching[0]
    evaluation = row.get("evaluation")
    decision = row.get("decision")
    strategy_historical = row.get("historicalEvidence")
    strategy_latency = row.get("latencyEvidence")
    if row.get("realExecutorRegistered") is not True:
        return "native promotion strategy is not executor-registered"
    if not isinstance(strategy_historical, dict):
        return "native strategy historical evidence missing"
    if strategy_historical.get("passed") is not True:
        return "native strategy historical evidence not passed"
    reasons = strategy_historical.get("reasons")
    if not isinstance(reasons, list) or reasons:
        return "native strategy historical evidence reasons invalid"
    if not isinstance(strategy_latency, dict):
        return "native strategy latency evidence missing"
    if strategy_latency.get("passed") is not True:
        return "native strategy latency evidence not passed"
    if not isinstance(evaluation, dict):
        return "native promotion strategy evaluation missing"
    if evaluation.get("status") != "passed" or evaluation.get("entryAllowed") is not True:
        return "native promotion strategy evaluation not passed"
    if not isinstance(decision, dict):
        return "native promotion strategy decision missing"
    if (
        decision.get("shadowAction") != "continue"
        or decision.get("realAction") != "manual_canary_review"
        or decision.get("manualReviewRequired") is not True
    ):
        return "native promotion strategy decision is not manual canary review"
    return None


def pnl_stats(values: Sequence[float]) -> PnlStats:
    pnls = [float(value) for value in values]
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
    return PnlStats(
        closed=len(pnls),
        net=sum(pnls),
        profit_factor=(gross_win / gross_loss if gross_loss > 0 else None),
        first_half=sum(pnls[:split]),
        second_half=sum(pnls[split:]),
        equity_peak=peak,
        current_drawdown=peak - equity,
        max_drawdown=max_drawdown,
    )


def _pf_text(value: float | None) -> str:
    return "inf" if value is None else f"{value:.2f}"


def evaluate_strategy_risk(
    values: Sequence[float],
    currently_enabled: bool,
    policy: StrategyRiskPolicy,
) -> StrategyRiskDecision:
    stats = pnl_stats(values)
    recent_values = list(values)[-max(1, policy.recent_window) :]
    recent = pnl_stats(recent_values)

    reason: str | None = None
    if stats.max_drawdown >= policy.maximum_drawdown_usd:
        reason = (
            f"irreversible max drawdown ${stats.max_drawdown:.2f} "
            f">= ${policy.maximum_drawdown_usd:.2f}"
        )
    elif stats.closed >= policy.pause_sample:
        weak = (
            stats.net <= 0
            or (
                stats.profit_factor is not None
                and stats.profit_factor < policy.minimum_watch_profit_factor
            )
            or stats.second_half <= 0
            or recent.net <= 0
            or (
                recent.profit_factor is not None
                and recent.profit_factor < policy.minimum_watch_profit_factor
            )
        )
        if weak:
            reason = (
                f"live decay after {stats.closed}: net ${stats.net:.2f}, "
                f"PF {_pf_text(stats.profit_factor)}, "
                f"second half ${stats.second_half:.2f}, "
                f"recent {recent.closed} net ${recent.net:.2f}, "
                f"PF {_pf_text(recent.profit_factor)}"
            )

    passed = (
        stats.closed >= policy.gate_sample
        and stats.net > 0
        and (
            stats.profit_factor is None
            or stats.profit_factor >= policy.minimum_pass_profit_factor
        )
        and stats.second_half > 0
        and stats.max_drawdown < policy.maximum_drawdown_usd
        and recent.net > 0
        and (
            recent.profit_factor is None
            or recent.profit_factor >= policy.minimum_watch_profit_factor
        )
    )
    pause = currently_enabled and reason is not None
    gate_status = (
        "paused"
        if not currently_enabled or pause
        else "passed"
        if passed
        else "watch"
        if stats.closed >= policy.pause_sample
        else "collecting"
    )
    return StrategyRiskDecision(
        stats=stats,
        recent=recent,
        pause=pause,
        passed=passed,
        gate_status=gate_status,
        reason=reason,
    )

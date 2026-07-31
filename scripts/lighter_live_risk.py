"""Pure risk policy for the isolated Lighter Real canary."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


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

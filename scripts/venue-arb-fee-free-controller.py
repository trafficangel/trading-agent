#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


ASTER_SHADOW_SERVICE = "venue-arb-binance-bybit-shadow.service"
ASTER_GATE_TIMER = "venue-arb-aster-lighter-maker-gate.timer"
COMBINED_SHADOW_SERVICE = "venue-arb-extended-lighter-shadow.service"
EXTENDED_GATE_TIMER = "venue-arb-extended-lighter-maker-gate.timer"
GRVT_GATE_TIMER = "venue-arb-grvt-lighter-maker-gate.timer"
HIBACHI_SHADOW_SERVICE = "venue-arb-hibachi-lighter-shadow.service"
HIBACHI_GATE_TIMER = "venue-arb-hibachi-lighter-maker-gate.timer"
HIBACHI_CAPACITY_GATE_TIMER = (
    "venue-arb-hibachi-lighter-capacity-gate.timer"
)
HIBACHI_STICKY_SHADOW_SERVICE = (
    "venue-arb-hibachi-lighter-sticky-shadow.service"
)
HIBACHI_STICKY_GATE_TIMER = (
    "venue-arb-hibachi-lighter-sticky-gate.timer"
)
HIBACHI_STICKY_CAPACITY_GATE_TIMER = (
    "venue-arb-hibachi-lighter-sticky-capacity-gate.timer"
)
COINBASE_SHADOW_SERVICE = "venue-arb-coinbase-lighter-shadow.service"
COINBASE_GATE_TIMER = "venue-arb-coinbase-lighter-maker-gate.timer"
ETHEREAL_SHADOW_SERVICE = "venue-arb-ethereal-lighter-shadow.service"
ETHEREAL_GATE_TIMER = "venue-arb-ethereal-lighter-maker-gate.timer"
ETHEREAL_TAKER_GATE_TIMER = "venue-arb-ethereal-lighter-taker-gate.timer"
HOTSTUFF_SHADOW_SERVICE = "venue-arb-hotstuff-lighter-shadow.service"
HOTSTUFF_GATE_TIMER = "venue-arb-hotstuff-lighter-maker-gate.timer"
BITFINEX_SHADOW_SERVICE = "venue-arb-bitfinex-lighter-shadow.service"
BITFINEX_GATE_TIMER = "venue-arb-bitfinex-lighter-taker-gate.timer"
BITFINEX_MAKER_GATE_TIMER = "venue-arb-bitfinex-lighter-maker-gate.timer"
CONTROLLER_TIMER = "venue-arb-fee-free-controller.timer"


def read_gate(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def is_no_go(gate: dict[str, Any] | None) -> bool:
    return bool(
        gate
        and (
            gate.get("decision") == "NO_GO"
            or gate.get("noGo") is True
        )
    )


def stop_plan(
    aster_gate: dict[str, Any] | None,
    extended_gate: dict[str, Any] | None,
    grvt_gate: dict[str, Any] | None,
    hibachi_gate: dict[str, Any] | None,
    coinbase_gate: dict[str, Any] | None,
    ethereal_gate: dict[str, Any] | None,
    hotstuff_gate: dict[str, Any] | None,
    *,
    grvt_disabled: bool = False,
    sticky_gate: dict[str, Any] | None = None,
    sticky_enabled: bool = False,
    coinbase_disabled: bool = False,
    ethereal_disabled: bool = False,
    ethereal_taker_gate: dict[str, Any] | None = None,
    ethereal_taker_enabled: bool = False,
    hotstuff_disabled: bool = False,
    bitfinex_gate: dict[str, Any] | None = None,
    bitfinex_enabled: bool = False,
    bitfinex_maker_gate: dict[str, Any] | None = None,
    bitfinex_maker_enabled: bool = False,
) -> dict[str, Any]:
    aster_no_go = is_no_go(aster_gate)
    extended_no_go = is_no_go(extended_gate)
    grvt_no_go = grvt_disabled or is_no_go(grvt_gate)
    hibachi_no_go = is_no_go(hibachi_gate)
    sticky_no_go = not sticky_enabled or is_no_go(sticky_gate)
    coinbase_no_go = coinbase_disabled or is_no_go(coinbase_gate)
    ethereal_maker_no_go = is_no_go(ethereal_gate)
    ethereal_taker_no_go = (
        not ethereal_taker_enabled
        or is_no_go(ethereal_taker_gate)
    )
    ethereal_no_go = (
        ethereal_disabled
        or (ethereal_maker_no_go and ethereal_taker_no_go)
    )
    hotstuff_no_go = hotstuff_disabled or is_no_go(hotstuff_gate)
    bitfinex_taker_no_go = is_no_go(bitfinex_gate)
    bitfinex_maker_no_go = (
        not bitfinex_maker_enabled
        or is_no_go(bitfinex_maker_gate)
    )
    bitfinex_no_go = (
        not bitfinex_enabled
        or (bitfinex_taker_no_go and bitfinex_maker_no_go)
    )
    all_no_go = (
        aster_no_go
        and extended_no_go
        and grvt_no_go
        and hibachi_no_go
        and sticky_no_go
        and coinbase_no_go
        and ethereal_no_go
        and hotstuff_no_go
        and bitfinex_no_go
    )
    stop_units: list[str] = []
    disable_units: list[str] = []
    if aster_no_go:
        stop_units.extend([ASTER_SHADOW_SERVICE, ASTER_GATE_TIMER])
        disable_units.extend([ASTER_SHADOW_SERVICE, ASTER_GATE_TIMER])
    if extended_no_go:
        stop_units.append(EXTENDED_GATE_TIMER)
        disable_units.append(EXTENDED_GATE_TIMER)
    if grvt_no_go:
        stop_units.append(GRVT_GATE_TIMER)
        disable_units.append(GRVT_GATE_TIMER)
    if extended_no_go and grvt_no_go:
        stop_units.append(COMBINED_SHADOW_SERVICE)
        disable_units.append(COMBINED_SHADOW_SERVICE)
    if hibachi_no_go:
        stop_units.extend([
            HIBACHI_SHADOW_SERVICE,
            HIBACHI_GATE_TIMER,
            HIBACHI_CAPACITY_GATE_TIMER,
        ])
        disable_units.extend([
            HIBACHI_SHADOW_SERVICE,
            HIBACHI_GATE_TIMER,
            HIBACHI_CAPACITY_GATE_TIMER,
        ])
    if sticky_enabled and sticky_no_go:
        stop_units.extend([
            HIBACHI_STICKY_SHADOW_SERVICE,
            HIBACHI_STICKY_GATE_TIMER,
            HIBACHI_STICKY_CAPACITY_GATE_TIMER,
        ])
        disable_units.extend([
            HIBACHI_STICKY_SHADOW_SERVICE,
            HIBACHI_STICKY_GATE_TIMER,
            HIBACHI_STICKY_CAPACITY_GATE_TIMER,
        ])
    if coinbase_no_go:
        stop_units.extend([COINBASE_SHADOW_SERVICE, COINBASE_GATE_TIMER])
        disable_units.extend([COINBASE_SHADOW_SERVICE, COINBASE_GATE_TIMER])
    if ethereal_no_go:
        stop_units.extend([
            ETHEREAL_SHADOW_SERVICE,
            ETHEREAL_GATE_TIMER,
            ETHEREAL_TAKER_GATE_TIMER,
        ])
        disable_units.extend([
            ETHEREAL_SHADOW_SERVICE,
            ETHEREAL_GATE_TIMER,
            ETHEREAL_TAKER_GATE_TIMER,
        ])
    if hotstuff_no_go:
        stop_units.extend([HOTSTUFF_SHADOW_SERVICE, HOTSTUFF_GATE_TIMER])
        disable_units.extend([HOTSTUFF_SHADOW_SERVICE, HOTSTUFF_GATE_TIMER])
    if bitfinex_enabled and bitfinex_no_go:
        stop_units.extend([
            BITFINEX_SHADOW_SERVICE,
            BITFINEX_GATE_TIMER,
            BITFINEX_MAKER_GATE_TIMER,
        ])
        disable_units.extend([
            BITFINEX_SHADOW_SERVICE,
            BITFINEX_GATE_TIMER,
            BITFINEX_MAKER_GATE_TIMER,
        ])
    if all_no_go:
        stop_units.append(CONTROLLER_TIMER)
        disable_units.append(CONTROLLER_TIMER)
    return {
        "asterNoGo": aster_no_go,
        "extendedNoGo": extended_no_go,
        "grvtNoGo": grvt_no_go,
        "grvtDisabled": grvt_disabled,
        "hibachiNoGo": hibachi_no_go,
        "stickyNoGo": sticky_no_go,
        "stickyEnabled": sticky_enabled,
        "coinbaseNoGo": coinbase_no_go,
        "coinbaseDisabled": coinbase_disabled,
        "etherealNoGo": ethereal_no_go,
        "etherealMakerNoGo": ethereal_maker_no_go,
        "etherealTakerNoGo": ethereal_taker_no_go,
        "etherealTakerEnabled": ethereal_taker_enabled,
        "etherealDisabled": ethereal_disabled,
        "hotstuffNoGo": hotstuff_no_go,
        "hotstuffDisabled": hotstuff_disabled,
        "bitfinexNoGo": bitfinex_no_go,
        "bitfinexTakerNoGo": bitfinex_taker_no_go,
        "bitfinexMakerNoGo": bitfinex_maker_no_go,
        "bitfinexEnabled": bitfinex_enabled,
        "bitfinexMakerEnabled": bitfinex_maker_enabled,
        "allNoGo": all_no_go,
        "stopUnits": stop_units,
        "disableUnits": disable_units,
    }


def systemctl(action: str, unit: str, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return {
            "action": action,
            "unit": unit,
            "ok": True,
            "dryRun": True,
        }
    completed = subprocess.run(
        ["systemctl", action, unit],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return {
        "action": action,
        "unit": unit,
        "ok": completed.returncode == 0,
        "returnCode": completed.returncode,
        "stderr": completed.stderr.strip()[:500],
    }


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def self_test() -> None:
    observe = {"decision": "OBSERVE"}
    no_go = {"decision": "NO_GO"}
    assert stop_plan(
        observe, observe, observe, observe, observe, observe, observe
    )["stopUnits"] == []
    aster = stop_plan(no_go, observe, observe, observe, observe, observe, observe)
    assert aster["stopUnits"] == [ASTER_SHADOW_SERVICE, ASTER_GATE_TIMER]
    extended_only = stop_plan(
        observe, no_go, observe, observe, observe, observe, observe
    )
    assert extended_only["stopUnits"] == [EXTENDED_GATE_TIMER]
    grvt_only = stop_plan(
        observe, observe, no_go, observe, observe, observe, observe
    )
    assert grvt_only["stopUnits"] == [GRVT_GATE_TIMER]
    grvt_disabled = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        grvt_disabled=True,
    )
    assert grvt_disabled["grvtNoGo"] is True
    assert grvt_disabled["grvtDisabled"] is True
    assert grvt_disabled["stopUnits"] == [GRVT_GATE_TIMER]
    shared_with_disabled_grvt = stop_plan(
        observe,
        no_go,
        observe,
        observe,
        observe,
        observe,
        observe,
        grvt_disabled=True,
    )
    assert shared_with_disabled_grvt["stopUnits"] == [
        EXTENDED_GATE_TIMER,
        GRVT_GATE_TIMER,
        COMBINED_SHADOW_SERVICE,
    ]
    shared = stop_plan(observe, no_go, no_go, observe, observe, observe, observe)
    assert shared["stopUnits"] == [
        EXTENDED_GATE_TIMER,
        GRVT_GATE_TIMER,
        COMBINED_SHADOW_SERVICE,
    ]
    hibachi = stop_plan(
        observe, observe, observe, no_go, observe, observe, observe
    )
    assert hibachi["stopUnits"] == [
        HIBACHI_SHADOW_SERVICE,
        HIBACHI_GATE_TIMER,
        HIBACHI_CAPACITY_GATE_TIMER,
    ]
    sticky = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        sticky_gate=no_go,
        sticky_enabled=True,
    )
    assert sticky["stopUnits"] == [
        HIBACHI_STICKY_SHADOW_SERVICE,
        HIBACHI_STICKY_GATE_TIMER,
        HIBACHI_STICKY_CAPACITY_GATE_TIMER,
    ]
    disabled_legacy = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        coinbase_disabled=True,
        ethereal_disabled=True,
        hotstuff_disabled=True,
    )
    assert disabled_legacy["coinbaseNoGo"] is True
    assert disabled_legacy["etherealNoGo"] is True
    assert disabled_legacy["hotstuffNoGo"] is True
    assert set(disabled_legacy["stopUnits"]) == {
        COINBASE_SHADOW_SERVICE,
        COINBASE_GATE_TIMER,
        ETHEREAL_SHADOW_SERVICE,
        ETHEREAL_GATE_TIMER,
        ETHEREAL_TAKER_GATE_TIMER,
        HOTSTUFF_SHADOW_SERVICE,
        HOTSTUFF_GATE_TIMER,
    }
    coinbase = stop_plan(
        observe, observe, observe, observe, no_go, observe, observe
    )
    assert coinbase["stopUnits"] == [
        COINBASE_SHADOW_SERVICE,
        COINBASE_GATE_TIMER,
    ]
    ethereal = stop_plan(
        observe, observe, observe, observe, observe, no_go, observe
    )
    assert ethereal["stopUnits"] == [
        ETHEREAL_SHADOW_SERVICE,
        ETHEREAL_GATE_TIMER,
        ETHEREAL_TAKER_GATE_TIMER,
    ]
    ethereal_taker_observing = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        no_go,
        observe,
        ethereal_taker_gate=observe,
        ethereal_taker_enabled=True,
    )
    assert ethereal_taker_observing["etherealNoGo"] is False
    assert ethereal_taker_observing["stopUnits"] == []
    ethereal_both_failed = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        no_go,
        observe,
        ethereal_taker_gate=no_go,
        ethereal_taker_enabled=True,
    )
    assert ethereal_both_failed["stopUnits"] == [
        ETHEREAL_SHADOW_SERVICE,
        ETHEREAL_GATE_TIMER,
        ETHEREAL_TAKER_GATE_TIMER,
    ]
    hotstuff = stop_plan(
        observe, observe, observe, observe, observe, observe, no_go
    )
    assert hotstuff["stopUnits"] == [
        HOTSTUFF_SHADOW_SERVICE,
        HOTSTUFF_GATE_TIMER,
    ]
    bitfinex_observing = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        bitfinex_gate=observe,
        bitfinex_enabled=True,
        bitfinex_maker_gate=observe,
        bitfinex_maker_enabled=True,
    )
    assert bitfinex_observing["bitfinexNoGo"] is False
    assert bitfinex_observing["stopUnits"] == []
    bitfinex_failed = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        bitfinex_gate=no_go,
        bitfinex_enabled=True,
        bitfinex_maker_gate=no_go,
        bitfinex_maker_enabled=True,
    )
    assert bitfinex_failed["stopUnits"] == [
        BITFINEX_SHADOW_SERVICE,
        BITFINEX_GATE_TIMER,
        BITFINEX_MAKER_GATE_TIMER,
    ]
    bitfinex_maker_survives = stop_plan(
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        observe,
        bitfinex_gate=no_go,
        bitfinex_enabled=True,
        bitfinex_maker_gate=observe,
        bitfinex_maker_enabled=True,
    )
    assert bitfinex_maker_survives["bitfinexNoGo"] is False
    assert bitfinex_maker_survives["stopUnits"] == []
    all_failed = stop_plan(
        no_go,
        no_go,
        no_go,
        no_go,
        no_go,
        no_go,
        no_go,
        sticky_gate=no_go,
        sticky_enabled=True,
    )
    assert all_failed["allNoGo"] is True
    assert set(all_failed["stopUnits"]) == {
        ASTER_SHADOW_SERVICE,
        COMBINED_SHADOW_SERVICE,
        HIBACHI_SHADOW_SERVICE,
        HIBACHI_STICKY_SHADOW_SERVICE,
        COINBASE_SHADOW_SERVICE,
        ETHEREAL_SHADOW_SERVICE,
        HOTSTUFF_SHADOW_SERVICE,
        ASTER_GATE_TIMER,
        EXTENDED_GATE_TIMER,
        GRVT_GATE_TIMER,
        HIBACHI_GATE_TIMER,
        HIBACHI_CAPACITY_GATE_TIMER,
        HIBACHI_STICKY_GATE_TIMER,
        HIBACHI_STICKY_CAPACITY_GATE_TIMER,
        COINBASE_GATE_TIMER,
        ETHEREAL_GATE_TIMER,
        ETHEREAL_TAKER_GATE_TIMER,
        HOTSTUFF_GATE_TIMER,
        CONTROLLER_TIMER,
    }
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "controller.json"
        atomic_json(path, all_failed)
        assert json.loads(path.read_text())["allNoGo"] is True
    print("venue-arb-fee-free-controller self-test ok")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--aster-gate",
        default=os.getenv(
            "VENUE_ARB_ASTER_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/binance-bybit-shadow/"
            "aster-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--extended-gate",
        default=os.getenv(
            "VENUE_ARB_EXTENDED_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/extended-lighter-shadow/"
            "extended-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--grvt-gate",
        default=os.getenv(
            "VENUE_ARB_GRVT_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/extended-lighter-shadow/"
            "grvt-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--hibachi-gate",
        default=os.getenv(
            "VENUE_ARB_HIBACHI_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/hibachi-lighter-shadow/"
            "hibachi-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--sticky-gate",
        default=os.getenv(
            "VENUE_ARB_HIBACHI_STICKY_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/"
            "hibachi-lighter-sticky-shadow/"
            "hibachi-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--coinbase-gate",
        default=os.getenv(
            "VENUE_ARB_COINBASE_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/coinbase-lighter-shadow/"
            "coinbase-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--ethereal-gate",
        default=os.getenv(
            "VENUE_ARB_ETHEREAL_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/ethereal-lighter-shadow/"
            "ethereal-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--ethereal-taker-gate",
        default=os.getenv(
            "VENUE_ARB_ETHEREAL_TAKER_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/ethereal-lighter-shadow/"
            "ethereal-lighter-taker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--hotstuff-gate",
        default=os.getenv(
            "VENUE_ARB_HOTSTUFF_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/hotstuff-lighter-shadow/"
            "hotstuff-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--bitfinex-gate",
        default=os.getenv(
            "VENUE_ARB_BITFINEX_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/bitfinex-lighter-shadow/"
            "bitfinex-lighter-taker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--bitfinex-maker-gate",
        default=os.getenv(
            "VENUE_ARB_BITFINEX_MAKER_GATE",
            "/home/trader/apps/venue-arb-tokyo/data/bitfinex-lighter-shadow/"
            "bitfinex-lighter-maker-gate-status.json",
        ),
    )
    parser.add_argument(
        "--output",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_OUTPUT",
            "/home/trader/apps/venue-arb-tokyo/data/"
            "fee-free-controller-status.json",
        ),
    )
    parser.add_argument(
        "--grvt-disabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_GRVT_DISABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--sticky-enabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_HIBACHI_STICKY_ENABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--coinbase-disabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_COINBASE_DISABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--ethereal-disabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_ETHEREAL_DISABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--ethereal-taker-enabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_ETHEREAL_TAKER_ENABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--hotstuff-disabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_HOTSTUFF_DISABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--bitfinex-enabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_BITFINEX_ENABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument(
        "--bitfinex-maker-enabled",
        action="store_true",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_BITFINEX_MAKER_ENABLED",
            "",
        ).strip().lower() in {"1", "true", "yes", "on"},
    )
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    gates = {
        "aster": read_gate(Path(args.aster_gate)),
        "extended": read_gate(Path(args.extended_gate)),
        "grvt": read_gate(Path(args.grvt_gate)),
        "hibachi": read_gate(Path(args.hibachi_gate)),
        "sticky": read_gate(Path(args.sticky_gate)),
        "coinbase": read_gate(Path(args.coinbase_gate)),
        "ethereal": read_gate(Path(args.ethereal_gate)),
        "etherealTaker": read_gate(Path(args.ethereal_taker_gate)),
        "hotstuff": read_gate(Path(args.hotstuff_gate)),
        "bitfinex": read_gate(Path(args.bitfinex_gate)),
        "bitfinexMaker": read_gate(Path(args.bitfinex_maker_gate)),
    }
    plan = stop_plan(
        gates["aster"],
        gates["extended"],
        gates["grvt"],
        gates["hibachi"],
        gates["coinbase"],
        gates["ethereal"],
        gates["hotstuff"],
        grvt_disabled=args.grvt_disabled,
        sticky_gate=gates["sticky"],
        sticky_enabled=args.sticky_enabled,
        coinbase_disabled=args.coinbase_disabled,
        ethereal_disabled=args.ethereal_disabled,
        ethereal_taker_gate=gates["etherealTaker"],
        ethereal_taker_enabled=args.ethereal_taker_enabled,
        hotstuff_disabled=args.hotstuff_disabled,
        bitfinex_gate=gates["bitfinex"],
        bitfinex_enabled=args.bitfinex_enabled,
        bitfinex_maker_gate=gates["bitfinexMaker"],
        bitfinex_maker_enabled=args.bitfinex_maker_enabled,
    )
    actions: list[dict[str, Any]] = []
    for unit in plan["stopUnits"]:
        actions.append(systemctl("stop", unit, args.dry_run))
    for unit in plan["disableUnits"]:
        actions.append(systemctl("disable", unit, args.dry_run))
    payload = {
        "version": "venue-arb-fee-free-controller-v1",
        "updatedAt": int(time.time() * 1000),
        **plan,
        "actions": actions,
        "gates": {
            name: {
                "decision": gate.get("decision"),
                "updatedAt": gate.get("updatedAt"),
                "noGoReasons": gate.get("noGoReasons"),
            } if gate else None
            for name, gate in gates.items()
        },
    }
    atomic_json(Path(args.output), payload)
    if any(not action["ok"] for action in actions):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

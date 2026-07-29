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
COINBASE_SHADOW_SERVICE = "venue-arb-coinbase-lighter-shadow.service"
COINBASE_GATE_TIMER = "venue-arb-coinbase-lighter-maker-gate.timer"
ETHEREAL_SHADOW_SERVICE = "venue-arb-ethereal-lighter-shadow.service"
ETHEREAL_GATE_TIMER = "venue-arb-ethereal-lighter-maker-gate.timer"


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
) -> dict[str, Any]:
    aster_no_go = is_no_go(aster_gate)
    extended_no_go = is_no_go(extended_gate)
    grvt_no_go = is_no_go(grvt_gate)
    hibachi_no_go = is_no_go(hibachi_gate)
    coinbase_no_go = is_no_go(coinbase_gate)
    ethereal_no_go = is_no_go(ethereal_gate)
    stop_units: list[str] = []
    disable_units: list[str] = []
    if aster_no_go:
        stop_units.append(ASTER_SHADOW_SERVICE)
        disable_units.extend([ASTER_SHADOW_SERVICE, ASTER_GATE_TIMER])
    if extended_no_go and grvt_no_go:
        stop_units.append(COMBINED_SHADOW_SERVICE)
        disable_units.extend([
            COMBINED_SHADOW_SERVICE,
            EXTENDED_GATE_TIMER,
            GRVT_GATE_TIMER,
        ])
    if hibachi_no_go:
        stop_units.append(HIBACHI_SHADOW_SERVICE)
        disable_units.extend([HIBACHI_SHADOW_SERVICE, HIBACHI_GATE_TIMER])
    if coinbase_no_go:
        stop_units.append(COINBASE_SHADOW_SERVICE)
        disable_units.extend([COINBASE_SHADOW_SERVICE, COINBASE_GATE_TIMER])
    if ethereal_no_go:
        stop_units.append(ETHEREAL_SHADOW_SERVICE)
        disable_units.extend([ETHEREAL_SHADOW_SERVICE, ETHEREAL_GATE_TIMER])
    return {
        "asterNoGo": aster_no_go,
        "extendedNoGo": extended_no_go,
        "grvtNoGo": grvt_no_go,
        "hibachiNoGo": hibachi_no_go,
        "coinbaseNoGo": coinbase_no_go,
        "etherealNoGo": ethereal_no_go,
        "allNoGo": (
            aster_no_go
            and extended_no_go
            and grvt_no_go
            and hibachi_no_go
            and coinbase_no_go
            and ethereal_no_go
        ),
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
        observe, observe, observe, observe, observe, observe
    )["stopUnits"] == []
    aster = stop_plan(no_go, observe, observe, observe, observe, observe)
    assert aster["stopUnits"] == [ASTER_SHADOW_SERVICE]
    shared = stop_plan(observe, no_go, no_go, observe, observe, observe)
    assert shared["stopUnits"] == [COMBINED_SHADOW_SERVICE]
    hibachi = stop_plan(observe, observe, observe, no_go, observe, observe)
    assert hibachi["stopUnits"] == [HIBACHI_SHADOW_SERVICE]
    coinbase = stop_plan(observe, observe, observe, observe, no_go, observe)
    assert coinbase["stopUnits"] == [COINBASE_SHADOW_SERVICE]
    ethereal = stop_plan(observe, observe, observe, observe, observe, no_go)
    assert ethereal["stopUnits"] == [ETHEREAL_SHADOW_SERVICE]
    all_failed = stop_plan(no_go, no_go, no_go, no_go, no_go, no_go)
    assert all_failed["allNoGo"] is True
    assert set(all_failed["stopUnits"]) == {
        ASTER_SHADOW_SERVICE,
        COMBINED_SHADOW_SERVICE,
        HIBACHI_SHADOW_SERVICE,
        COINBASE_SHADOW_SERVICE,
        ETHEREAL_SHADOW_SERVICE,
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
        "--output",
        default=os.getenv(
            "VENUE_ARB_CONTROLLER_OUTPUT",
            "/home/trader/apps/venue-arb-tokyo/data/"
            "fee-free-controller-status.json",
        ),
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
        "coinbase": read_gate(Path(args.coinbase_gate)),
        "ethereal": read_gate(Path(args.ethereal_gate)),
    }
    plan = stop_plan(
        gates["aster"],
        gates["extended"],
        gates["grvt"],
        gates["hibachi"],
        gates["coinbase"],
        gates["ethereal"],
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

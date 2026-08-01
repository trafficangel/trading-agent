from __future__ import annotations

import copy
from datetime import datetime, timezone
import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))

from lighter_live_risk import (  # noqa: E402
    NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256,
    NATIVE_HISTORICAL_EVIDENCE_VERSION,
    NATIVE_HISTORICAL_REPORT_SHA256,
    NATIVE_HISTORICAL_RSI_SUPPLEMENT_SHA256,
    NATIVE_HISTORICAL_SUPPLEMENT_SHA256,
    NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256,
    NATIVE_PROMOTION_GATE,
    native_promotion_report_error,
)


NOW_MS = 1_800_000_000_000
STRATEGY_ID = "sol-z60-reclaim"


def valid_report() -> dict:
    return {
        "version": "lighter-native-promotion-audit-v3",
        "generatedAt": datetime.fromtimestamp(
            (NOW_MS - 60_000) / 1000,
            tz=timezone.utc,
        ).isoformat().replace("+00:00", "Z"),
        "gate": dict(NATIVE_PROMOTION_GATE),
        "shadowNotionalUsd": 100,
        "eligibleStrategyIds": [STRATEGY_ID],
        "historicalEvidence": {
            "version": NATIVE_HISTORICAL_EVIDENCE_VERSION,
            "sourceSha256": NATIVE_HISTORICAL_REPORT_SHA256,
            "supplementalSourceSha256": NATIVE_HISTORICAL_SUPPLEMENT_SHA256,
            "xlmSupplementalSourceSha256": NATIVE_HISTORICAL_XLM_SUPPLEMENT_SHA256,
            "dataSupplementalSourceSha256": NATIVE_HISTORICAL_DATA_SUPPLEMENT_SHA256,
            "rsiSupplementalSourceSha256": NATIVE_HISTORICAL_RSI_SUPPLEMENT_SHA256,
        },
        "strategies": [
            {
                "strategyId": STRATEGY_ID,
                "realExecutorRegistered": True,
                "historicalEvidence": {"passed": True, "reasons": []},
                "evaluation": {"status": "passed", "entryAllowed": True},
                "decision": {
                    "shadowAction": "continue",
                    "realAction": "manual_canary_review",
                    "manualReviewRequired": True,
                },
            }
        ],
        "autoPromotion": False,
    }


class NativePromotionReportTest(unittest.TestCase):
    def check(self, report: object) -> str | None:
        return native_promotion_report_error(report, STRATEGY_ID, NOW_MS, 7_200_000)

    def test_exact_frozen_contract_passes(self) -> None:
        self.assertIsNone(self.check(valid_report()))

    def test_looser_gate_fails_closed(self) -> None:
        report = valid_report()
        report["gate"]["minProfitFactor"] = 1.0
        self.assertIn("minProfitFactor changed", self.check(report) or "")

    def test_wrong_notional_fails_closed(self) -> None:
        report = valid_report()
        report["shadowNotionalUsd"] = 1_000
        self.assertIn("notional 1000", self.check(report) or "")

    def test_stale_report_fails_closed(self) -> None:
        report = valid_report()
        report["generatedAt"] = "2026-01-01T00:00:00Z"
        self.assertIn("stale", self.check(report) or "")

    def test_id_alone_cannot_bypass_evidence(self) -> None:
        report = valid_report()
        report["strategies"][0]["evaluation"]["status"] = "collecting"
        self.assertIn("evaluation not passed", self.check(report) or "")

    def test_historical_failure_cannot_be_overridden_by_forward_result(self) -> None:
        report = valid_report()
        report["strategies"][0]["historicalEvidence"]["passed"] = False
        report["strategies"][0]["historicalEvidence"]["reasons"] = ["drawdown"]
        self.assertIn("historical evidence not passed", self.check(report) or "")

    def test_changed_historical_artifact_fails_closed(self) -> None:
        report = valid_report()
        report["historicalEvidence"]["sourceSha256"] = "0" * 64
        self.assertIn("historical evidence hash mismatch", self.check(report) or "")

    def test_changed_data_supplement_fails_closed(self) -> None:
        report = valid_report()
        report["historicalEvidence"]["dataSupplementalSourceSha256"] = "0" * 64
        self.assertIn("DATA supplemental", self.check(report) or "")

    def test_changed_rsi_supplement_fails_closed(self) -> None:
        report = valid_report()
        report["historicalEvidence"]["rsiSupplementalSourceSha256"] = "0" * 64
        self.assertIn("RSI supplemental", self.check(report) or "")

    def test_duplicate_strategy_evidence_fails_closed(self) -> None:
        report = valid_report()
        report["strategies"].append(copy.deepcopy(report["strategies"][0]))
        self.assertIn("duplicated", self.check(report) or "")

    def test_automatic_promotion_fails_closed(self) -> None:
        report = valid_report()
        report["autoPromotion"] = True
        self.assertIn("autoPromotion", self.check(report) or "")


if __name__ == "__main__":
    unittest.main()

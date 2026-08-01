import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))

from lighter_live_risk import (  # noqa: E402
    StrategyRiskPolicy,
    evaluate_strategy_risk,
    native_canary_config_error,
    native_registry_error,
)


class StrategyRiskTest(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = StrategyRiskPolicy()

    def test_collects_before_sample_when_drawdown_is_safe(self) -> None:
        decision = evaluate_strategy_risk([0.4, -0.2, 0.3], True, self.policy)
        self.assertFalse(decision.pause)
        self.assertEqual(decision.gate_status, "collecting")

    def test_irreversible_drawdown_pauses_before_sample(self) -> None:
        decision = evaluate_strategy_risk([2.0, -5.1], True, self.policy)
        self.assertTrue(decision.pause)
        self.assertEqual(decision.gate_status, "paused")
        self.assertIn("irreversible max drawdown", decision.reason or "")

    def test_recent_decay_pauses_despite_positive_cumulative_book(self) -> None:
        pnls = [1.0] * 20 + [-0.2] * 10
        decision = evaluate_strategy_risk(pnls, True, self.policy)
        self.assertGreater(decision.stats.net, 0)
        self.assertGreater(decision.stats.second_half, 0)
        self.assertTrue(decision.pause)
        self.assertIn("recent 10 net", decision.reason or "")

    def test_healthy_twenty_trade_canary_passes(self) -> None:
        pnls = [0.4, -0.1] * 10
        decision = evaluate_strategy_risk(pnls, True, self.policy)
        self.assertFalse(decision.pause)
        self.assertTrue(decision.passed)
        self.assertEqual(decision.gate_status, "passed")

    def test_disabled_strategy_never_reenables_automatically(self) -> None:
        decision = evaluate_strategy_risk([0.4, -0.1] * 10, False, self.policy)
        self.assertTrue(decision.passed)
        self.assertFalse(decision.pause)
        self.assertEqual(decision.gate_status, "paused")

    def test_native_canary_requires_frozen_notional_and_safe_leverage(self) -> None:
        self.assertIsNone(native_canary_config_error(100, 10))
        self.assertIn("notional", native_canary_config_error(1000, 10) or "")
        self.assertIn("leverage", native_canary_config_error(100, 11) or "")
        self.assertIn("leverage", native_canary_config_error(100, 0) or "")

    def test_native_registry_rejects_missing_and_same_market_owners(self) -> None:
        self.assertIsNone(native_registry_error({"a": 1, "b": 2}, {"a", "b"}))
        self.assertIn("not executor-registered", native_registry_error({"a": 1}, {"a", "b"}) or "")
        self.assertIn("collision", native_registry_error({"a": 1, "b": 1}, {"a", "b"}) or "")


if __name__ == "__main__":
    unittest.main()

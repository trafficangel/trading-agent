# Quant indicator validation — 2026-07-30

## Objective

Build a simple, symmetric, non-repainting 5-minute strategy in LuxAlgo Quant
for zero-commission Lighter, then validate it independently before creating
alerts or adding it to Shadow.

Common execution assumptions:

- completed candles only;
- signal on bar close, fill at the next bar open;
- no pyramiding or same-bar reversal;
- zero exchange commission;
- 0.05% base and 0.10% stressed round-trip spread/slippage;
- one shared parameter set across every coin;
- first 70% of BTC/ETH/SOL used for selection;
- last 30% of BTC/ETH/SOL is time-OOS;
- XRP/DOGE/SUI are untouched transfer-OOS symbols.

The independent sample contains 365 days and 105,120 five-minute candles per
symbol.

## Candidate 1 — Lighter ATR Donchian Dual

Quant hypothesis: EMA regime plus prior-channel breakout, ATR stop/target and
time exit.

The least-bad shared neighborhood was Donchian 18, trend separation 0.1 ATR,
2.5 ATR stop, 2.5R target and 144-bar time exit.

| Scope | Result after 0.05% RT costs |
|---|---|
| Train BTC / ETH / SOL | PF 0.97 / 0.97 / 1.03 |
| Time-OOS BTC / ETH / SOL | PF 0.80 / 0.86 / 0.80 |
| Transfer XRP / DOGE / SUI | PF 0.94 / 0.93 / 0.83 |

Verdict: **REJECT**. The next-bar delay removes the apparent breakout edge.

## Candidate 2 — Lighter Volatility Reversion Dual

Quant hypothesis: fade a one-ATR stretch beyond an EMA after a completed
reversal candle; exit on the mean, ATR safety stop or time stop.

LuxAlgo's short chart window showed 328 trades and PF 1.183, but the independent
365-day test found approximately zero gross expectancy. After the base
execution cost every train and validation symbol was negative.

| Scope | PF range after 0.05% RT costs |
|---|---:|
| Train BTC / ETH / SOL | 0.78–0.85 |
| Time-OOS BTC / ETH / SOL | 0.80–0.93 |
| Transfer XRP / DOGE / SUI | 0.86–0.96 |

Verdict: **REJECT**.

## Candidate 3 — Lighter Volume Exhaustion Reversion Dual

Quant added a causal exhaustion filter: the stretched event candle must have
volume at least 1.5× the mean of the 20 completed bars before it. The event
candle is excluded from its own baseline.

LuxAlgo's short chart window improved to 195 trades and PF 1.219, but the
independent result again failed everywhere:

| Scope | PF range after 0.05% RT costs |
|---|---:|
| Train BTC / ETH / SOL | 0.78–0.85 |
| Time-OOS BTC / ETH / SOL | 0.75–0.93 |
| Transfer XRP / DOGE / SUI | 0.85–0.94 |

Verdict: **REJECT**.

## Interim decision

No alert or Shadow strategy was created from the three failed shared-parameter
families above. Their 17-day Quant previews were too short and materially
overstated robustness.

Reproducible runners:

- `scripts/test-quant-atr-donchian.ts`
- `scripts/test-quant-volatility-reversion.ts`

## Candidate 4 — Lighter SOL Z60 Reclaim Dual

A second search used **native Lighter one-minute candles**, aggregated into
complete five-minute bars. It found one materially stronger, two-sided
coin-specific candidate:

- mean: population `SMA(60)` / standard deviation over 60 bars;
- long entry: prior Z-score below `-3`, current completed bar reclaims `-3`;
- short entry: prior Z-score above `+3`, current completed bar reclaims `+3`;
- entry and signal exits fill at the next bar open;
- exit when price reaches the current SMA(60);
- catastrophe stop: 1.5% from the actual entry;
- time exit: 240 bars;
- zero commission, 0.02% round-trip execution stress and 0.00125% per holding
  hour adverse funding.

| Lookback | Trades | Net after stress/funding | PF | WR | Long / short net |
|---:|---:|---:|---:|---:|---:|
| 30d | 66 | +9.51% | 1.54 | 72.7% | +5.44% / +4.07% |
| 60d | 144 | +31.81% | 1.61 | 68.1% | +17.73% / +14.08% |
| 90d | 215 | +27.16% | 1.34 | 67.0% | +14.64% / +12.53% |
| 120d | 290 | +41.35% | 1.43 | 68.3% | +24.05% / +17.29% |
| 180d | 446 | +49.06% | 1.28 | 65.2% | +31.99% / +17.07% |

At a larger 0.05% round-trip execution stress the 180-day result remains
+35.68% with PF 1.20. At 0.10% it remains nominally positive (+13.38%) but
fails the stability gate because the earlier in-sample partition and short
side become marginal. Nearby periods and thresholds form a positive plateau,
although not every neighbor passes the full gate.

The additive maximum drawdown at the base stress is 19.81 percentage points,
so the backtest does **not** justify leverage or live capital. The strategy is
admitted first to prospective Lighter Shadow under id `sol-z60-reclaim`
(`STRAT-030`). It later entered a separately risk-limited $100-notional live
canary; that promotion does not apply to adjacent variants.

The auditable Pine reference is
`research/lighter-quant/lighter-sol-z60-reclaim.pine`.

The native reproduction runner is `scripts/sweep-lighter-native-1m.ts`.

## Candidate 5 — Lighter SOL Z60 Touch Dual

The highest-frequency adjacent configuration that still clears the base
robustness gate enters on the completed candle **outside** the same three-sigma
band instead of waiting for a reclaim:

- long when current Z-score is below `-3`;
- short when current Z-score is above `+3`;
- next-bar execution, SMA(60) mean exit, 1.5% catastrophe stop and 240-bar time
  exit are unchanged;
- no regime filter, pyramiding or same-bar reversal.

| Lookback | Trades | Net after 0.02% stress/funding | PF | Long / short net |
|---:|---:|---:|---:|---:|
| 30d | 67 | +12.84% | 1.69 | +6.54% / +6.30% |
| 60d | 143 | +28.51% | 1.48 | +13.28% / +15.23% |
| 90d | 213 | +26.83% | 1.31 | +12.71% / +14.12% |
| 120d | 287 | +42.79% | 1.41 | +21.71% / +21.08% |
| 180d | 451 | +49.71% | 1.25 | +30.79% / +18.93% |

At 0.05% round-trip stress the 30/60/90/120-day windows still clear PF 1.2;
the full 180-day result remains positive at +36.18% but PF falls to 1.18. The
base-stress maximum drawdown is 23.84 percentage points.

Lower thresholds increase turnover but fail the robustness gate: at thresholds
2.6–2.9 the 180-day PF is only 1.07–1.17 and drawdown rises to 33.58–37.00
percentage points. Therefore `3.0` is the maximum-frequency point admitted;
it was not loosened merely to manufacture more trades.

This model is highly correlated with STRAT-030 and has the larger drawdown. It
is admitted only to prospective Shadow as `sol-z60-touch` (`STRAT-031`).
It is not allowlisted in the real Lighter executor.

The auditable Pine reference is
`research/lighter-quant/lighter-sol-z60-touch.pine`.

## Candidates 6–7 — cross-symbol native Z60 transfer

The same native-candle engine was then run on additional liquid Lighter
markets. BTC, ETH, ADA and WLD were rejected because at least one recent
window, direction, or adverse-cost test failed. AVAX was retained by a later,
stricter audit as a Shadow research candidate. Two two-sided candidates
survived without adding a regime filter:

| Strategy | Rule | Trades | Net after 0.02% stress/funding | PF | WR | DD | Long / short net |
|---|---|---:|---:|---:|---:|---:|---:|
| STRAT-032 · BNB | Z60 ±3 touch | 417 | +60.86% | 1.51 | 69.3% | 9.76% | +33.99% / +26.87% |
| STRAT-033 · LTC | Z60 ±2 touch | 968 | +107.39% | 1.37 | 69.5% | 27.57% | +64.74% / +42.65% |

BNB remained positive in every 30/60/90/120/180-day window. The 30-day
window produced 68 trades, +5.25% net and PF 1.40; the 180-day result remained
+48.35% with PF 1.39 under the larger 0.05% round-trip execution stress.

LTC also remained positive in every tested window. The 30-day result was 154
trades, +20.62% net and PF 1.59. Periods 50/60/70 and thresholds
1.75/2.0/2.25 were all two-sided positive, providing a broad local parameter
plateau. At 0.05% stress its 180-day result remained +78.35% with PF 1.26.

Both candidates were first admitted to the consolidated Native Quant portfolio
as prospective Shadow. On the user's explicit 2026-07-30 instruction they were
also allowlisted as separately risk-capped **$100-notional / 10× Real
canaries**, before the normal forward gate. Each uses an exchange-native 1.5%
reduce-only stop and remains subject to the $10 daily-loss and $15 portfolio
drawdown breakers. This early canary is an execution experiment, not evidence
that the historical edge survives live trading. STRAT-031 remains Shadow-only
because it would collide with STRAT-030 in the same one-way SOL market.

## Additional market and indicator sweep

The next sweep tested BTC, ETH, AVAX, WLD and XRP on completed 5-minute Lighter
candles. WLD RSI2 was very active and profitable at 0.02% round-trip execution
stress, but no variant passed every 30/60/90/120/180-day gate at 0.05%; it was
therefore rejected for live use. XRP produced no qualified candidate.

AVAX Z-reclaim was materially stronger. The Z50 ±3 reclaim neighborhood stayed
positive in both directions across every tested window and at 0.05% stress
(180 days: 454 trades, +36.98% stressed net, PF 1.21, 15.96% max drawdown).
It was registered as `avax-z50-reclaim` (`STRAT-034`) for prospective Shadow
on 2026-07-30. It is deliberately absent from the Real allowlist until its own
forward sample exists; these historical results do not authorize live orders.

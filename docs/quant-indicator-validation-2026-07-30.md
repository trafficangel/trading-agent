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
admitted only to prospective Lighter Shadow under id `sol-z60-reclaim`
(`STRAT-030`). Real execution remains disabled.

The auditable Pine reference is
`research/lighter-quant/lighter-sol-z60-reclaim.pine`.

The native reproduction runner is `scripts/sweep-lighter-native-1m.ts`.

# Lighter low-timeframe LuxAlgo research

Date: 2026-07-30

Status: original shared-parameter families **rejected**; four later
native-Lighter 5m variants are tracked in one consolidated portfolio, with new
BNB/LTC candidates admitted to **Shadow only**.

This research tested whether a simple, symmetric long/short candle strategy
could produce a robust edge suitable for Lighter on 1-minute and 5-minute
timeframes. It deliberately did not change the production strategy registry,
webhook routing, or order execution.

## LuxAlgo prototype

LuxAlgo Quant produced a Pine v6 prototype named `Lighter ATR Donchian Dual`:

- completed-candle EMA regime filter;
- prior-bar Donchian breakout;
- next-bar-open entry;
- symmetric ATR stop, profit target, and time exit;
- no pyramiding or same-bar reversal.

The first native 5-minute BTC test was already below the acceptance threshold:

| Net result | Trades | Profit factor | Win rate | Max drawdown |
|---:|---:|---:|---:|---:|
| -$1,046.50 | 161 | 0.940 | 32.92% | 0.28% |

The prototype was therefore treated as a hypothesis, not as evidence of an
edge.

## Independent adversarial validation

Two symmetric strategy families were reproduced in the local backtest engine:

1. ATR-normalized Donchian trend breakout.
2. ATR-filtered z-score range mean reversion.

Each family tested 243 nearby parameter sets on both 1-minute and 5-minute
data: 972 configurations in total. Every configuration used the same
parameters for BTCUSDT, ETHUSDT, and SOLUSDT.

Execution assumptions:

- signals use completed candles only;
- fills occur at the next candle open;
- base execution cost is 6 bps round trip plus 1 bp funding per 8 hours;
- stress cost is 12 bps round trip plus 2 bps funding per 8 hours;
- the final 20% of history is untouched out-of-sample data;
- results are checked in five contiguous time folds;
- long and short sides must each be profitable;
- all three assets must pass independently.

| Family | Timeframe | Parameter sets | Passed |
|---|---:|---:|---:|
| Donchian trend breakout | 1m | 243 | 0 |
| Donchian trend breakout | 5m | 243 | 0 |
| Range mean reversion | 1m | 243 | 0 |
| Range mean reversion | 5m | 243 | 0 |

The least-bad out-of-sample results still lost roughly 0.05%–0.08% per trade
on their weakest asset. Both long and short sides were negative, and none of
the candidates produced a positive fold profile.

## Data limits

The independent test uses Bybit perpetual OHLC data as a market-price proxy,
not Lighter-native fills. The 5-minute cache covers approximately January 2025
through July 2026 without detected gaps. The 1-minute caches cover a shorter
period and contain one or two large gaps depending on the asset, so the
1-minute result is supporting evidence rather than a production-grade final
measurement.

This limitation cannot rescue the candidates: they fail by substantially more
than a plausible venue-price difference, and they also fail under the lower
base-cost assumption.

## Decision

Do not add either strategy family to LuxAlgo alerts, shadow trading, or live
trading. There is no demonstrated 1–5 minute candle-only edge here.

The next defensible hypothesis is Lighter-native microstructure rather than
more indicator parameter search: order-book imbalance, aggressive trade flow,
short-horizon mark/index dislocation, and measured fill probability. If the
work must stay inside LuxAlgo, continue only on 5-minute candidates and require
verifiable long/short breakdown plus a fresh shadow gate before risking money.

That continuation later produced a small native-Lighter Z60 portfolio:
two SOL variants plus two transfer candidates on BNB and LTC. Their exact
rules and independent 30/60/90/120/180-day results are documented in
`docs/quant-indicator-validation-2026-07-30.md`. New candidates are admitted
only to prospective Shadow; the rejected families above remain rejected.

## LuxAlgo database follow-up

A separate LuxAlgo AI Backtesting database search was run for symmetric
five-minute candidates. This is discovery evidence only: the candidates were
selected from the same database on which their headline metrics were measured,
so the results remain exposed to selection bias.

### Candidate A — SUIUSDT

Exact conditions:
`OB Exited - Money Flow Below 50 - HyperWave Below 50`.

LuxAlgo reports 239 trades from 2026-04-07 through 2026-06-15, aggregate profit
factor 1.592, long profit factor 1.552, and short profit factor 1.631. Both
directions are profitable.

The entire trade log was normalized to percentage returns and tested after
synthetic round-trip execution costs:

| Assumption | Net return sum | Average/trade | Profit factor |
|---|---:|---:|---:|
| Raw trade log | +80.04% | +0.335% | 1.625 |
| 6 bps/trade | +65.70% | +0.275% | 1.496 |
| 12 bps/trade | +51.36% | +0.215% | 1.375 |

All five contiguous time folds remain positive at both 6 bps and 12 bps. At
12 bps their profit factors are 1.089, 1.216, 1.034, 1.632, and 2.208.

The exact unchanged condition set was also checked on other symbols. SOL
remains two-sided positive (228 trades, aggregate PF 1.521, long PF 1.365,
short PF 1.715), but it fails clearly on BTC and ETH and is only borderline on
BNB (short PF 1.136). This is not a universal cross-market rule.

**Decision:** strongest discovery candidate, eligible for shadow observation
only. It must not be fan-out/live enabled before a fresh 15–20 closed-trade
forward sample is net-positive after actual Lighter execution costs.

### Candidate B — SOLUSDT

Exact conditions:
`Smart Trail Switch - Trend Catcher - Trend Strength Ranging`.

LuxAlgo reports 109 trades, aggregate PF 1.675, long PF 1.437, short PF 1.898,
and both directions net-positive. Normalizing the full trade log gives:

| Assumption | Net return sum | Average/trade | Profit factor |
|---|---:|---:|---:|
| Raw trade log | +37.97% | +0.348% | 1.644 |
| 6 bps/trade | +31.43% | +0.288% | 1.504 |
| 12 bps/trade | +24.89% | +0.228% | 1.377 |

At 6 bps all five contiguous folds are positive, although one is nearly flat
(PF 1.037). At 12 bps that fold becomes negative (PF 0.925). The 12 bps long
side is also marginal at PF 1.178.

**Decision:** secondary shadow-only candidate, weaker than Candidate A. Do not
trade it live and do not run it beside another highly correlated SOL strategy
until its incremental portfolio value is measured.

### Rejected database cards

- XLM: both sides positive, but aggregate PF 1.513 missed the discovery gate.
- BCH: aggregate PF 1.669, but the long side lost money (PF 0.918).
- ETH: headline profit was positive, but the long side lost money (PF 0.830).
- BTC: the long side lost money and drawdown was excessive.
- BNB: both sides were positive, but the short PF was only 1.136 before costs.
- A second SOL candidate
  (`Trend Catcher Switch - Smart Trail - Trend Strength Ranging`) was weaker
  after costs and added no useful diversification.

## Reproduction

### Native Lighter Z60 variants

`STRAT-031 / sol-z60-touch` is the only additional native-candle candidate
admitted from the high-frequency sweep. It enters on a completed SOL 5m candle
outside the Z60 ±3 band, then uses the same SMA60 mean exit, 1.5% catastrophe
stop and 240-bar time exit as STRAT-030.

The 180-day native Lighter result is 451 trades and +49.71% after 0.02%
round-trip execution stress plus adverse funding (PF 1.25); both directions
and every 30/60/90/120/180-day window are positive. Lower Z thresholds created
more turnover but failed the PF/drawdown gate. Because the touch version is
highly correlated with STRAT-030 and has the larger drawdown, it is Shadow-only
and is not allowlisted in the real executor.

Pine reference:
`research/lighter-quant/lighter-sol-z60-touch.pine`.

The multi-symbol continuation also admitted:

- `STRAT-032 / bnb-z60-touch`: Z60 ±3 touch, 417 trades, +60.86% after
  0.02% execution stress and adverse funding, PF 1.51, both sides and every
  30/60/90/120/180-day window positive.
- `STRAT-033 / ltc-z60-touch`: Z60 ±2 touch, 968 trades, +107.39% after the
  same stress, PF 1.37, both sides and all tested windows positive.

Both run through the same completed-candle native runner and remain
Shadow-only. BTC, ETH, ADA, AVAX, and WLD were not admitted because they failed
at least one direction, recent-window, or adverse-cost stability check.

Run on the VPS, where the historical kline cache is populated:

```bash
pnpm tsx scripts/research-lighter-quant.ts 1
pnpm tsx scripts/research-lighter-quant.ts 5
pnpm tsx scripts/research-lighter-range.ts 1
pnpm tsx scripts/research-lighter-range.ts 5
```

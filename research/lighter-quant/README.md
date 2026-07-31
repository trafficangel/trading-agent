# Lighter low-timeframe LuxAlgo research

Date: 2026-07-31

Status: original shared-parameter families **rejected**. The current unified
15-market candidate is `Z60STACK-2.5-touch` (Portfolio P2), running in
**prospective Shadow only**. The historical sections below are retained to
show the rejected hypotheses and the path to P2.

The initial phase tested whether a simple, symmetric long/short candle strategy
could produce a robust edge suitable for Lighter on 1-minute and 5-minute
timeframes. That phase deliberately did not change production. Later candidates
were integrated only after their own validation, with Shadow/Real separation.

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

## 2026-07-31 Portfolio P2 preregistered challenger

P1 used one symmetric rule on 15 markets: buy a completed 5m close below
Z60 −2.5 only above EMA200, sell above Z60 +2.5 only below EMA200, exit at
SMA60, stop at 1.5%, and time-exit after 240 bars. A causal regime audit found
that P1's 47 mixed-trend trades lost 10.93 percentage points after measured
costs (PF 0.58), while clear bull and bear regimes were both profitable.

P2 was preregistered without a parameter sweep. It keeps P1's exact Z period,
threshold, entry mode, exit, stop, time limit, market list, and ten-position
capacity. Its sole change is the mirrored completed-bar trend stack:

- long only when `Z60 < -2.5` and `close > EMA200 > EMA400`;
- short only when `Z60 > +2.5` and `close < EMA200 < EMA400`.

Selection subtracts each market's measured immediately executable full-round-
trip L2 p95 at the target $100 Real-canary notional. It does not use a common
0.10% or 0.15% cost assumption. A separate `1.5 × p95` result is sensitivity
evidence only and is not a cost estimate. Prospective Shadow records actual
side-specific $1,000 VWAP and funding and therefore remains the authoritative
execution test.

| Test | N | Net | PF | Drawdown | Long / Short | Folds |
|---|---:|---:|---:|---:|---:|---:|
| P1 5m, market p95 | 806 | +112.46% | 1.38 | −2.58% capacity | +73.28% / +39.18% | 4/4 |
| P2 5m, market p95 | 759 | +123.39% | 1.45 | −2.45% capacity | +82.70% / +40.69% | 4/4 |
| P2 5m, 1.5× p95 | 759 | +104.71% | 1.38 | — | both positive | — |
| P2 1m transfer | 3,398 | −95.18% | 0.88 | −12.19% capacity | −58.07% / −37.11% | 1/4 |

Additional 5m checks: IS/OOS +65.33%/+58.06%, 13/15 profitable markets,
leave-one-market-out minimum +97.77%, six of six positive months, bull/bear
+82.70%/+40.69%, high/low volatility +67.10%/+56.30%, and zero signals
dropped by the predeclared ten-position cap. The 1m transfer is rejected and
must not be launched.

The live runner uses 1,500 gap-checked native 5m candles, fetched in three
500-bar pages. A 500-bar EMA400 seed produced a wrong EMA200/EMA400 side on
LIT; 1,500 bars matched the full-history side on all 15 markets and reduced
the observed EMA400 initialization difference to roughly 0.0013% or less.
P1 had zero prospective signals and zero trades before replacement, so P2
starts with a clean forward sample. Real remains physically disabled until the
predeclared forward gate passes.

### Full frozen-family rerun after the P2 launch

The complete shared-rule scanner was rerun on 2026-07-31 over the same 15
markets, the refreshed rolling 180-day native cache, the measured $100 p95
cost for each market, adverse funding, both sides, four chronological folds,
IS/OOS, bull/bear/mixed trend regimes, high/low volatility, 30/60/90-day
windows, leave-one-market-out, monthly stability and a ten-position capacity.

- **1m:** zero individual or portfolio candidates passed. The strongest
  headline rows failed OOS, recent windows, one side or drawdown. The best
  portfolio rule was still negative (`Z60T-3-touch`: −39.13%, PF 0.88); the
  exact P2 transfer lost 95.18% with PF 0.88. No 1m strategy was admitted.
- **5m:** 16 individual rows passed, but they were adjacent versions of the
  already registered HYPE/BTC/BNB/LTC Z/VWZ family and therefore add
  concentration rather than a new independent edge. Only one shared
  cross-market portfolio passed every gate: P2. On the refreshed rolling
  window it had 758 trades, +122.80%, PF 1.45, adverse +104.15%/PF 1.38,
  4/4 folds, IS/OOS +64.74%/+58.06%, both sides positive, 12/15 profitable
  markets, 20% dominance, six of six positive months and −2.45% capacity
  drawdown. The one-trade difference from the frozen launch card is caused by
  the rolling 180-day boundary; the launch card remains an immutable record.

Decision: do not add a correlated P3 merely because an adjacent parameter has
a larger in-sample total. Continue the clean P2 prospective sample and search
for a genuinely different information source before adding portfolio risk.

## Independent native microstructure track

The next research source is deliberately independent from the Z-score family.
`src/hft/lighter-microstructure-recorder.ts` is a public-data-only Lighter
recorder covering the same 15-market universe. It imports no signer, account,
API key or order client and therefore cannot trade.

The recorder follows the official public WebSocket contract:

- `order_book/{market}` supplies a full subscription snapshot followed by
  50ms state changes. Every delta must have `begin_nonce` equal to the prior
  `nonce`; a mismatch clears the local book and forces a fresh subscription.
- `trade/{market}` supplies public trades and liquidation trades. Aggressor
  direction is derived from the documented resting-maker flag:
  `is_maker_ask=true` means an aggressive buy, otherwise an aggressive sell.
- `market_stats/{market}` supplies mark/index price, estimated current funding
  and the last paid funding rate.

Only compact completed one-minute aggregates are retained: mid OHLC, average
and maximum executable spread, top-five quote depth and imbalance, taker buy
and sell USD flow/CVD, liquidation flow, basis/funding, book freshness and gap
quality counters. Five-minute features must be derived from consecutive
`quality_ok=1` one-minute rows; incomplete or gap-affected minutes are excluded,
not forward-filled. Default retention is 60 days.

Order-book updates are change-driven. Therefore a quiet market's unchanged
book age is retained as a feature but is not by itself treated as a broken
stream. Sampling is rejected only when the shared socket has been silent for
five seconds, the specific market has produced no channel message for 60
seconds, the book is missing/crossed, or continuity was broken.

This is a data-collection track, not a strategy launch. No entry rule may be
selected until enough strictly prospective rows exist for chronological
train/validation/test, execution-stressed evaluation, both-side checks and a
frozen Shadow gate.

`scripts/audit-lighter-microstructure.ts` enforces staged data gates across all
15 markets: 24 hours for collection-health assessment, seven days before any
exploratory hypothesis scan, and 21 days before frozen candidate research. The
minimum per-market 1m coverage, usable 1m share and strict consecutive 5m share
are each 95%. At least 95% of expected minutes must also contain rolling $100
execution-cost samples for at least 80% of their valid book snapshots. A
reported stream gap invalidates its affected minute; it is never filled or
included in a 5m row. These are data-readiness gates only and do not waive the
later execution-stressed backtest and prospective Shadow gate.

### Preregistered microstructure hypotheses

The rules below were frozen on 2026-07-31 before the first seven-day dataset
existed. They are deliberately six complete hypotheses rather than a broad
parameter optimizer:

- `OF-CONT-25-H1/H3`: follow aligned completed-bar taker-flow imbalance
  (absolute 0.25) and top-five depth imbalance (absolute 0.20), holding one or
  three five-minute bars;
- `ABSORB-55-H1/H3`: reverse extreme taker flow (absolute 0.55) only when the
  opposite side still owns at least 0.15 depth imbalance, holding one or three
  bars;
- `BASIS-4BP-H3/H6`: fade an absolute 0.04% mark/index basis dislocation when
  taker flow is not strongly fighting the reversion, holding three or six bars.

Every rule is exactly mirrored long/short. A signal uses only a completed 5m
row, entry is the next consecutive bar's mid-open, and exit is a later
consecutive mid-open. Recorder v3 continuously computes immediately executable
buy and sell VWAP for $100 from every one-second public L2 sample. Each 1m row
stores the observed avg/p95/max round-trip cost; the strict 5m row uses the
maximum of its five completed minute p95 values. Each simulated trade subtracts
that causal signal-time cost and funding; it never substitutes the short
40-sample launch estimate. The trade is rejected if the rolling cost is
missing, either top-five side has less than $500, the spread is outside the
preregistered liquidity envelope, any bar is missing, or a required field is
absent.

Qualification requires at least 120 trades, PF >=1.20, positive mean-return
L95, positive long and short books, three positive chronological thirds,
positive bull/bear and high/low-volatility regimes, at least four active
markets, majority-positive market breadth, <=60% winner dominance, positive
leave-one-market-out net, positive 1.5x-cost stress and <=5% drawdown at the
frozen ten-position capacity.

`scripts/sweep-lighter-microstructure.ts` is fail-closed. Exploratory mode
refuses to run before the seven-day audit gate and can never qualify a Shadow
candidate. Frozen mode refuses to run before the 21-day gate. A daily systemd
timer writes the immutable report but never edits strategy or Real state;
promotion remains a reviewed Shadow-only code change followed by the normal
20-close prospective gate.

## Preregistered cross-sectional residual pair

While the microstructure dataset accumulates, one additional independent
candle hypothesis was frozen before its first run. It is a market-neutral
cross-sectional pair rather than another own-price oscillator:

- use the same 15 native Lighter markets and BTC as the common factor;
- estimate each alt's causal rolling beta and correlation from the previous
  seven days only;
- every 15 minutes rank the completed one-hour beta residual move;
- when leader-to-laggard dispersion is at least 0.80%, buy the laggard and sell
  the leader with beta-neutral weights;
- enter both legs at the next bar open and exit exactly one hour later;
- express the same elapsed-time rule at 1m and strict 5m, with no per-market
  tuning and no overlapping portfolio trades.

Selection uses each leg's measured immediately executable $100 L2 p95,
adverse funding and a separate 1.5x-cost stress. Qualification requires
positive discovery and untouched final-30% OOS, PF >=1.20, positive mean L95,
at least three positive chronological folds, <=5% drawdown, positive bull,
bear, high- and low-volatility regimes, both long and short usage across the
asset breadth, <=60% winner dominance and positive leave-one-asset-out net.
The research script writes a report only and has no registration or trading
imports. A passing historical result would still enter prospective Shadow,
never Real.

### Frozen result

The one preregistered run used 179.889 strictly common days from
2026-02-01 through 2026-07-31. No gaps were filled. Neither timeframe passed:

| TF | N | Net at measured p95 | PF | 1.5x-cost net / PF | L95 | DD | Folds | Discovery / OOS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1m | 2,743 | -96.14% | 0.84 | -156.19% / 0.75 | -0.054% | -116.63% | 0/4 | -93.73% / -2.41% |
| 5m | 3,167 | -60.77% | 0.92 | -146.17% / 0.81 | -0.038% | -85.44% | 0/4 | -69.34% / +8.57% |

The isolated positive 5m OOS total is not an edge: its PF is only 1.05, its
L95 is negative, its stressed OOS is -17.69%, and the frozen discovery sample
lost 69.34%. Bull, bear, high-volatility and low-volatility slices were all
negative at both timeframes; only one of six months was positive. The result
file is `data/lighter-xs-residual-results.json`.

**Decision:** reject this family unchanged. Do not tune the dispersion,
lookback or hold after seeing these results, and do not add it to Native
Shadow or Real. The independent search remains focused on the preregistered
prospective microstructure hypotheses once their data-readiness gates open.

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

## Independent native-family rejection — 2026-07-31

Two predeclared, symmetric rule families that do not use the Z-score strategy
were evaluated on the same frozen 15-market universe. Every market supplied
180 complete days of native Lighter one-minute candles with no missing or
duplicated timestamps. Five-minute bars were aggregated from those minutes.
Entries execute at the next completed-bar open and each market pays its own
measured $100-notional p95 executable L2 round-trip cost plus adverse funding.

The selection gate required positive long and short results, positive IS and
OOS, at least three positive folds, positive 30/60/90-day windows, mean-return
L95 above zero, PF >= 1.20 and a portfolio drawdown no worse than 5%. The
portfolio gate additionally required broad market and regime contribution,
positive leave-one-market-out net, and robustness at 1.5x measured cost.

### RSI2 trend pullback

The rule buys an RSI2 oversold touch or reclaim only when
`EMA21 > EMA55 > EMA200`, and shorts the mirrored setup in a fully bearish
stack. Thresholds 5 and 10 were tested at one and five minutes.

- 1m: zero individual or portfolio qualifiers. Even BTC at the lowest measured
  cost lost 32.57 percentage points after cost for the least-bad variant.
- 5m: zero qualifiers. The strongest isolated result was HYPE threshold-5
  touch: +29.08 points after cost, PF 1.18, but drawdown was 12.18%, the gate PF
  was missed, and the same fixed rule lost 389.87 dollars in the 15-market
  $100-per-position portfolio.

### Squeeze breakout

The rule requires Bollinger Bands to remain inside a Keltner Channel for five
or ten bars, then enters a symmetric directional breakout, optionally with a
1.25x volume filter, and exits at EMA8 or EMA21. It was tested at one and five
minutes.

- 1m: zero qualifiers; every portfolio variant was negative after cost.
- 5m: zero qualifiers. The positive isolated rows failed OOS, recent windows,
  both-side consistency and/or drawdown. The least-bad fixed portfolio lost
  322.93 dollars and drew down 36.39%.

**Decision:** both families are rejected and are not added to Shadow or Real.
The HYPE and ZEC headline rows are retained only as examples of why an
in-sample positive result is insufficient.

Reproduce the four frozen scans:

```bash
ENABLE_TREND_PULLBACK=1 RULE_FILTER=RSI2PB BAR_MINUTES=1 pnpm tsx scripts/sweep-lighter-native-1m.ts
ENABLE_TREND_PULLBACK=1 RULE_FILTER=RSI2PB BAR_MINUTES=5 pnpm tsx scripts/sweep-lighter-native-1m.ts
ENABLE_SQUEEZE=1 RULE_FILTER=SQZ20 BAR_MINUTES=1 pnpm tsx scripts/sweep-lighter-native-1m.ts
ENABLE_SQUEEZE=1 RULE_FILTER=SQZ20 BAR_MINUTES=5 pnpm tsx scripts/sweep-lighter-native-1m.ts
```

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

Both run through the same completed-candle native runner. They briefly ran as
isolated $100-notional Real canaries with 1.5% exchange-native stops before the
normal forward gate. That early exception ended on 2026-07-31: new Real entries
for STRAT-030/032/033 are disabled until each strategy has at least 20 closed
prospective trades and passes the frozen gate. An already open position keeps
its exchange stop and normal exit handling. BTC, ETH, ADA, and WLD were not
admitted because they failed at least one direction, recent-window, or
adverse-cost stability check.

A subsequent multi-window audit retained AVAX Z50 ±3 reclaim as a Shadow
research candidate: it was positive on 30/60/90/120/180-day windows, both
directions, and 0.05% round-trip stress (180 days: 454 trades, +36.98%, PF
1.21). It is intentionally absent from the live allowlist pending forward
evidence. WLD RSI2 was rejected despite its high frequency because every
variant failed at least one 0.05%-stress window; XRP produced no qualified
candidate.

Run on the VPS, where the historical kline cache is populated:

```bash
pnpm tsx scripts/research-lighter-quant.ts 1
pnpm tsx scripts/research-lighter-quant.ts 5
pnpm tsx scripts/research-lighter-range.ts 1
pnpm tsx scripts/research-lighter-range.ts 5
```

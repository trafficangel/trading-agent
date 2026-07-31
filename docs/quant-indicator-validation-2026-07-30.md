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

A second search used **native Lighter candles** and complete five-minute bars.
It found one materially stronger, two-sided coin-specific candidate:

- mean: population `SMA(60)` / standard deviation over 60 bars;
- long entry: prior Z-score below `-3`, current completed bar reclaims `-3`;
- short entry: prior Z-score above `+3`, current completed bar reclaims `+3`;
- entry and signal exits fill at the next bar open;
- exit when price reaches the current SMA(60);
- catastrophe stop: 1.5% from the actual entry;
- time exit: 240 bars;
- zero commission, 0.05% round-trip execution stress and 0.00125% per holding
  hour adverse funding.

| Lookback | Trades | Net after 0.05% stress/funding | PF | WR | Long / short net |
|---:|---:|---:|---:|---:|---:|
| 30d | 67 | +5.36% | 1.28 | 67.2% | +3.42% / +1.94% |
| 60d | 146 | +24.80% | 1.44 | 65.1% | +15.44% / +9.35% |
| 90d | 220 | +18.49% | 1.22 | 64.5% | +10.95% / +7.54% |
| 120d | 299 | +31.08% | 1.31 | 66.2% | +19.28% / +11.79% |
| 180d | 457 | +37.93% | 1.21 | 63.9% | +29.13% / +8.80% |

These figures supersede the earlier cache-based results. A pagination audit
found one missing candle at every historical API page boundary. The cache was
repaired with end-exclusive Lighter request windows and revalidated with zero
five-minute gaps. The corrected reclaim model still clears the strict gate,
but only narrowly on the full 180-day PF.

The additive maximum drawdown at the base stress is 21.85 percentage points,
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

| Lookback | Trades | Net after 0.05% stress/funding | PF | Long / short net |
|---:|---:|---:|---:|---:|
| 30d | 68 | +7.44% | 1.35 | +3.86% / +3.58% |
| 60d | 144 | +22.09% | 1.35 | +10.67% / +11.42% |
| 90d | 218 | +18.16% | 1.20 | +8.61% / +9.56% |
| 120d | 297 | +33.65% | 1.30 | +16.68% / +16.97% |
| 180d | 462 | +39.46% | 1.19 | +28.32% / +11.13% |

The corrected full-window PF is below the 1.20 gate. It remains Shadow-only
and is not eligible for Real promotion.

Lower thresholds increase turnover but fail the robustness gate. Therefore
`3.0` was not loosened merely to manufacture more trades.

This model is highly correlated with STRAT-030 and has the larger drawdown. It
is admitted only to prospective Shadow as `sol-z60-touch` (`STRAT-031`).
It is not allowlisted in the real Lighter executor.

The auditable Pine reference is
`research/lighter-quant/lighter-sol-z60-touch.pine`.

## Candidates 6–7 — cross-symbol native Z60 transfer

The same native-candle engine was then run on additional liquid Lighter
markets. BTC, ETH, ADA, WLD and AVAX were rejected because at least one recent
window, direction, or adverse-cost test failed. Two two-sided candidates
survived without adding a regime filter:

| Strategy | Rule | Trades | Net after 0.05% stress/funding | PF | WR | DD | Long / short net |
|---|---|---:|---:|---:|---:|---:|---:|
| STRAT-032 · BNB | Z60 ±3 touch | 415 | +45.95% | 1.37 | 68.2% | 11.87% | +25.18% / +20.77% |
| STRAT-033 · LTC | Z60 ±2 touch | 972 | +80.40% | 1.27 | 68.0% | 28.22% | +51.08% / +29.32% |

BNB remains positive in aggregate, but the corrected recent sample is weaker:
30 days produced 67 trades, +2.54% and PF 1.18, with long −0.75% and short
+3.29%. It must not be scaled while that directional weakness persists.

LTC remains positive and two-sided in every tested 30/60/90/120/180-day
window. Its corrected 30-day result is 153 trades, +16.06% and PF 1.44.

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

AVAX Z50 ±3 reclaim remained profitable and two-sided after the cache repair
(180 days: 453 trades, +33.60% stressed net, PF 1.19, 15.00% max drawdown),
but now misses the strict PF gate. It was therefore **not** added to Shadow or
Real.

WLD RSI7 20/80 with EMA400 looked promising on the full window (224 trades,
+20.23%, PF 1.25), but failed the 30-day stress window and had a negative
recent long side. It was rejected.

Two additional standard, causal indicator families were tested on BTC, ETH,
SOL, BNB, LTC, XRP, AVAX and WLD:

- stochastic 14/3 oversold/overbought crossover, with and without EMA400;
- CCI20 ±100 reclaim, with and without EMA400.

Neither family produced a candidate that survived 0.05% round-trip stress,
adverse funding, both directions, chronological folds and IS/OOS checks.

## Candidate 8 — BTC volume-weighted Z60 touch

A predeclared volume-weighted variant was tested without changing the common
entry threshold or exit horizon for any individual coin:

- each completed 5-minute close is weighted by its native Lighter volume;
- long below volume Z `−3`, short above volume Z `+3`;
- next-bar execution, exit at the rolling 60-bar volume-weighted mean;
- 1.5% catastrophe stop and 240-bar time exit;
- 0.065% round-trip execution/funding stress.

BTC was the only market to clear the strengthened gate:

| Window | Trades | Net | PF |
|---:|---:|---:|---:|
| 30d | 22 | +1.79% | 1.45 |
| 60d | 36 | +5.91% | 1.85 |
| 90d | 52 | +7.03% | 1.84 |
| 180d | 103 | +12.94% | 1.58 |

The full sample had 4/4 positive chronological folds, IS/OOS
`+11.07% / +1.87%`, Long/Short `+6.85% / +6.08%`, 68.0% win rate and
5.90% additive maximum drawdown. The one-sided 95% lower confidence bound of
mean net trade was only `+0.0010%`, so this is not sufficient evidence for
capital. It is admitted as `btc-vwz60-touch` (`STRAT-034`) in prospective
Shadow only.

XRP produced positive aggregate results but failed the same confidence gate
(mean-trade L95 `−0.0219%`) and was rejected.

During this audit the Lighter candles API was also observed returning only ten
candles when `count_back=0`. Both the production Native runner and resumable
research downloader now request `count_back=500` explicitly. Bulk historical
downloads run from an isolated research host so WAF/rate-limit pressure cannot
interfere with live signal polling.

## Candidate 9 — HYPE volume-weighted Z60 touch

The isolated downloader produced 259,200 consecutive native HYPE one-minute
candles covering 180 days with no gaps or duplicate timestamps. The predeclared
two-sided sweep tested the same data at both one- and five-minute aggregation.
No one-minute rule qualified after 0.065% round-trip execution/funding stress.

On five-minute candles, the volume-weighted Z60 touch rule at `±2.5σ` passed
every strengthened gate:

| Stress per round trip | Net | PF | Mean-trade L95 | Positive folds |
|---:|---:|---:|---:|---:|
| 0.065% | +74.52% | 1.47 | +0.0954% | 4/4 |
| 0.100% | +62.06% | 1.38 | +0.0604% | 4/4 |
| 0.150% | +44.26% | 1.26 | +0.0104% | 4/4 |

At the base stress the 356-trade sample had a 64.3% win rate, 13.62%
additive maximum drawdown, IS/OOS `+44.55% / +29.98%`, Long/Short
`+43.28% / +31.24%`, and positive 30/60/90-day windows. Neighboring touch
thresholds `2.25`, `2.5`, and `2.75` remained profitable after 0.10% stress,
which reduces single-parameter peak risk.

The model is admitted as `hype-vwz60-touch` (`STRAT-035`) in prospective
Shadow only. It is absent from the Real allowlist until its own forward fills
provide enough evidence under the predeclared promotion gates.

The same sweep added RSI14 trend-reclaim, Bollinger breakout/reclaim and
Keltner breakout families before evaluating HYPE. None qualified on BTC, ETH,
SOL or HYPE at one minute, so no one-minute strategy was launched.

Gap-free 180-day LINK and XRP samples were then evaluated with the same frozen
rules. Neither produced a qualified one- or five-minute candidate. LINK's best
five-minute aggregate result failed the IS, direction and L95 gates. XRP
volume-Z `3σ` touch made +17.44% with PF 1.21 after base stress, but its
mean-trade L95 was `−0.0219%`; it remains rejected rather than being promoted
from headline PnL alone.

## Extended liquid-market control sweep

Gap-free 180-day one-minute samples for BNB, UNI, AAVE and LTC were downloaded
from the native Lighter candles API and evaluated with the same causal rules.
Lighter Standard commission remains zero. The research output now separates a
`0.02%` measured-cost discovery reserve from a non-blocking `0.065%` adverse
sensitivity column; both also include `0.00125%` adverse funding per holding
hour. The 0.10% and 0.15% HYPE rows above are robustness scenarios, not assumed
exchange costs and not automatic rejection thresholds. Final eligibility is
decided by prospective executable VWAP, spread, slippage and funding recorded
for the specific market.

A fresh 40-snapshot control on 2026-07-31 confirmed that those old scenarios
are materially above the observed book cost. At `$100` notional, executable
round-trip p95 was BTC `0.0067%`, SOL `0.0095%`, BNB `0.0220%`, LTC `0.0333%`
and HYPE `0.0320%`. HYPE p95 at `$1,000` was `0.0395%`. Consequently the
scanner now uses the measured market/notional p95 as its blocking cost and
derives the non-blocking adverse scenario as `1.5 × p95`; fixed `0.10%` and
`0.15%` values are not eligibility filters. Funding remains a separate
time-weighted deduction.

No new one-minute candidate qualified:

- LTC contained 259,200 consecutive candles with zero gaps. Even its best
  headline rule, Z60 `3σ` touch, fell to `−28.71%`, PF `0.91`, L95
  `−0.0360%`, one positive chronological fold out of four and negative long
  and short sides after execution reserve and funding.
- UNI and AAVE produced no rule that simultaneously passed L95, IS/OOS,
  both directions and the recent windows. AAVE's best five-minute reclaim
  headline was rejected because its latest 30-day window was negative
  (`−3.69%`, PF `0.88`).
- BNB produced no additional qualified model. Its existing five-minute
  `STRAT-032` remains under prospective monitoring rather than being replaced
  by a weaker high-frequency variant.

The existing five-minute LTC `STRAT-033` was reconfirmed as the stronger
timeframe choice. The failed one-minute transfer is useful negative evidence:
greater signal frequency did not survive realistic execution reserve, so no
one-minute strategy was added merely to increase trade count.

### Per-market executable-cost calibration

The next control batch replaced the common execution reserve with a measured
reserve for each market. Forty live Lighter L2 snapshots per symbol were
sampled, and every snapshot simulated an immediate `$1,000` buy and sell
against available depth. The value below is the p95 round-trip loss from
executable VWAP versus mid; it is spread plus book slippage, not an exchange
commission:

| Symbol | Median | p90 | p95 used by scan | Maximum |
|---|---:|---:|---:|---:|
| ZEC | 0.0428% | 0.0491% | 0.0520% | 0.0522% |
| DOGE | 0.0477% | 0.0653% | 0.0724% | 0.0760% |
| NEAR | 0.0438% | 0.0625% | 0.0685% | 0.1038% |
| JUP | 0.0711% | 0.0926% | 0.0934% | 0.0985% |

Each market then received a gap-free 180-day history of 259,200 native
one-minute candles and was scanned independently at one and five minutes using
its own measured p95. The adverse sensitivity column remained non-blocking.
No candidate qualified:

- ZEC's strongest one-minute headline had PF 1.09 and an effectively flat
  latest 30-day window; its adverse-sensitivity result was negative. Its best
  five-minute candidates failed confidence, OOS or direction gates.
- DOGE was negative after its measured p95 at both timeframes.
- NEAR five-minute volume-Z `2.25σ` touch was a genuine near-miss
  (`+132.15%`, PF 1.30, 4/4 folds, positive IS/OOS and both directions), but
  the latest 30 days were `−0.13%`, PF 1.00. The `3σ` reclaim variant also
  failed the frozen 90-day PF gate at 1.04. Neither was launched.
- JUP produced no qualified rule. Its best five-minute headline, Z60 `2.5σ`
  touch, had only PF 1.06, negative IS, a negative short side and a negative
  mean-trade confidence bound after the measured 0.0934% p95 cost.

This calibration supersedes use of `0.10%` or `0.15%` as universal eligibility
costs. Those values are retained only as optional adverse scenarios. Final
evidence still comes from prospective Shadow fills and their recorded
market-specific executable costs.

### Second executable-cost market batch

The next batch expanded the liquid native universe to LIT, PUMP, GRAM and XMR.
As above, forty live Lighter L2 snapshots per market simulated an immediate
`$1,000` buy and sell. The scan used the observed p95 executable round-trip
loss rather than a common arbitrary stress:

| Symbol | Median | p95 used by scan |
|---|---:|---:|
| LIT | 0.0458% | 0.0586% |
| PUMP | 0.1005% | 0.1376% |
| GRAM | 0.0208% | 0.0460% |
| XMR | 0.0636% | 0.0970% |

Each market has at least 259,200 consecutive native one-minute candles with
zero gaps or duplicate timestamps. The scan evaluated one- and five-minute
bars, both Long and Short trades, chronological IS/OOS folds, recent
30/60/90-day windows, confidence bounds and a separate non-blocking adverse
cost scenario. A maximum 15% historical additive drawdown is now a mandatory
research gate; this prevents a high headline return from hiding an unsuitable
risk path.

No model from this batch qualified:

- LIT's best five-minute Z20 `2.5σ` touch model made `+84.34%`, but PF was only
  1.13 and maximum drawdown was `−26.79%`.
- PUMP remained weak after its measured 0.1376% p95 executable cost. Its best
  five-minute families had PF around 1.03–1.05 and failed recent, direction,
  confidence or drawdown gates.
- GRAM produced the closest risk-adjusted near-miss. Five-minute
  `VWZ60-3-reclaim` had 292 trades, `+35.58%`, PF 1.38, robust `+28.57%`,
  3/4 positive folds, `+28.75% / +6.84%` IS/OOS, positive aggregate Long and
  Short results, `−12.88%` drawdown and a positive `+0.0253%` mean-trade L95.
  However, its latest 30-day Long result was `−0.30%` while Short was
  `+2.98%`. It therefore fails the frozen two-sided recent gate and was not
  admitted to Shadow.
- XMR produced no qualified model. Several five-minute rules were profitable
  in aggregate, but failed the PF, confidence, drawdown or recent
  direction-balance gates.

The engine also added a predeclared, causal Kaufman efficiency-ratio filter to
the two-sided volume-weighted Z-score family. It is intended to avoid fading
strongly directional paths, uses completed closes only, and was evaluated on
the earlier ZEC/DOGE/NEAR/JUP set as well as this batch. It did not create a
qualified candidate. No strategy was added merely because a new indicator
improved one headline metric.

### Third executable-cost market batch

POPCAT, ENA, ARB and TAO were sampled next with the same forty-snapshot,
`$1,000` executable round-trip method:

| Symbol | Median | p95 |
|---|---:|---:|
| POPCAT | 0.1016% | 0.1634% |
| ENA | 0.0507% | 0.0737% |
| ARB | 0.0507% | 0.1066% |
| TAO | 0.0827% | 0.0970% |

POPCAT was rejected before historical testing because the live book was too
expensive for the intended high-frequency use. ENA, ARB and TAO each received
259,200 consecutive one-minute candles with zero gaps or duplicate timestamps.
They were scanned at one and five minutes using their individual p95 costs.
No rule qualified:

- every one-minute TAO, ENA and ARB rule was negative after its measured
  executable cost;
- TAO five-minute Z20 `3σ` touch was the best near-miss (`+37.14%`, PF 1.25,
  4/4 positive folds, `−14.60%` drawdown), but had negative aggregate Short
  (`−4.73%`), negative latest 30-day Short (`−2.03%`) and negative L95;
- ENA five-minute Z60 `2σ` touch made `+81.59%`, but PF was only 1.10, L95 was
  negative and drawdown reached `−49.58%`. The lower-frequency `3σ` variant
  improved PF to 1.16 but still had negative L95 and `−20.94%` drawdown;
- ARB five-minute RSI14 `25/75` made `+27.17%`, but PF was 1.11, drawdown was
  `−33.89%`, L95 was negative and aggregate Long was `−4.66%`.

These failures reinforce that zero exchange commission is useful but not
sufficient: executable spread/book slippage and an unstable or one-sided
return path can still erase the apparent indicator edge. No strategy from this
batch was registered for prospective Shadow.

### Additional two-sided indicator families

Three causal, symmetric families were then tested against the same native
one- and five-minute data and market-specific executable costs:

- a TTM-style Bollinger/Keltner compression breakout with EMA200 direction;
- an EMA21/55/200 trend stack with RSI2 pullback and reclaim entries;
- Z60 and volume-weighted Z60 mean reversion restricted to pullbacks aligned
  with EMA200 (`Z60T` / `VWZ60T`).

The squeeze and RSI2 families were broadly negative after measured costs and
are disabled by default. The trend-filtered Z families materially improved
risk-adjusted results on several five-minute markets, but remained too sparse
or recently one-sided for admission:

- ZEC `Z60T-2.5-reclaim`: 78 trades, `+26.73%`, PF 1.99, drawdown `-4.66%`,
  but only 13 trades in the latest 30 days and negative Long over 60 days;
- NEAR `VWZ60T-2.5-touch`: 110 trades, `+31.28%`, PF 1.88, drawdown `-5.92%`,
  but only 15 recent trades and negative Long over 60 and 90 days;
- JUP `Z60T-2.5-touch`: 68 trades, `+20.69%`, PF 1.79, positive aggregate
  Long/Short, but only 8 trades in the latest 30 days;
- BTC `VWZ60T-2.5-reclaim`: 46 trades, `+6.34%`, PF 1.93 and drawdown
  `-2.65%`, but only 10 trades in the latest 30 days.

No frequency or direction gate was relaxed to make any individual market pass.
The same preregistered `Z60T-2.5-touch` rule was then evaluated as one fixed-
notional cross-market portfolio instead of selecting individual winners. All
15 liquid markets had the full 180-day, gap-free history and used their own
measured `$100` executable p95 cost plus time-weighted adverse funding. The
prospective Shadow ledger deliberately uses the larger `$1,000` notional and
records its side-specific live VWAP, so it is a stricter execution transfer
check rather than an understated replica of the candidate-selection cost.

The five-minute portfolio qualified without dropping a signal or tuning a
parameter by market:

- 806 closed trades, 69.1% win rate, `+109.19` percentage-points of net PnL
  (`+$109.19` at `$100` fixed notional per leg), PF `1.37`;
- `+87.81` and PF `1.29` when every market's execution reserve is increased to
  `1.5 ×` its measured p95;
- maximum ten naturally concurrent positions and `−2.63%` drawdown relative
  to that observed `$1,000` peak capacity;
- four of four chronological folds, positive IS/OOS (`+58.02 / +51.18`) and
  positive Long/Short (`+71.97 / +37.23`);
- 13 of 15 active markets profitable, largest contributor 18% of positive
  PnL, leave-one-market-out minimum `+88.50`, and all six calendar months
  positive;
- latest 30/60/90-day windows all positive on both sides.

The identical one-minute transfer failed decisively (3,582 trades,
`−128.75%`, PF `0.85`, `−24.23%` drawdown, zero of four positive folds and
negative Long and Short books). It was rejected rather than promoted for
frequency. Only the five-minute portfolio `P1` is registered for prospective
Shadow. Its 15 market legs are shown as one consolidated model; all are absent
from the Real allowlist until the combined forward gate passes and a separate
Real-capacity decision is made.

## Prospective Native Shadow continuation gate

Native strategies now have an automatic continuation gate in the actual
Shadow entry path, not only a dashboard label. Until 20 closed prospective
trades the strategy continues collecting evidence, except for the frozen
maximum-drawdown ceiling: because an observed maximum drawdown cannot improve
with more trades, breaching it blocks the next entry immediately. Starting
with close 20, negative performance or execution-quality evidence blocks new
entries. A profitable model remains in Shadow collection, without Real
eligibility, until the following coverage conditions also hold:

- the prospective sample spans at least seven calendar days;
- at least three Long and three Short trades are closed;
- portfolio P2 has closed trades from at least four distinct markets (an
  individual strategy naturally requires one).

After both the performance and coverage requirements mature, every attempted
new entry is admitted only when all remaining frozen conditions hold:

- cumulative net PnL is positive and PF is at least 1.20;
- both chronological halves are positive;
- maximum drawdown is at most 5% of frozen allocated capacity (one unit for an
  individual strategy and ten fixed-notional units for portfolio P1);
- L2 capture errors are at most 2% of signals;
- every closed trade has a valid executable round-trip spread/slippage sample;
- p95 age of the captured order book is at most 2,000ms;
- there is at least one valid execution-quality sample per closed trade.

If any condition fails, the signal is still captured and remains auditable,
but a new Shadow position is not opened and the exact gate failure is saved on
the signal. An opposite signal may still close the existing position before
the gate is evaluated, and explicit exits plus safety stops are never blocked.
There is deliberately no universal execution-cost ceiling: actual executable
VWAP and funding are already deducted in each trade's net PnL, and a common
number would incorrectly treat BTC and less liquid markets as equivalent.
The observed average cost remains reported for diagnosis. This prevents a
strategy that deteriorates after initially passing from
continuing to accumulate risk merely because it remains registered.

Portfolio P1 additionally refuses an eleventh simultaneous Shadow entry. Its
historical maximum was ten, so this frozen cap did not drop a backtest signal;
it keeps the prospective drawdown denominator and future capacity claim fixed
instead of allowing apparent risk to improve by silently adding exposure.

## Preregistered volatility-compression breakout challenger

Before its first result was inspected on 2026-07-31, the next independent
Native Quant family was frozen as a small eight-rule set named `SQZ20`. It is
deliberately a two-sided trend/breakout challenger to the existing Z-score
reversion book, not another threshold variation of that book.

- markets: the same 15 liquid P2 markets, with one shared rule and no
  market-specific parameters;
- timeframes: five minutes is the primary hypothesis; the identical one-minute
  transfer is a separate falsification control and cannot replace it;
- compression: completed-candle Bollinger `2σ` width must have been inside a
  `1.5 × ATR14` Keltner envelope during one of the preceding 5 or 10 bars and
  must be released on the signal bar;
- entry: completed close through the preceding 20-bar high above EMA200 for
  Long, mirrored through the low below EMA200 for Short; optional volume gate
  is either none or `volume >= 1.25 × SMA20(volume)`;
- execution: next-bar open, 1% safety stop, maximum 90 bars, exit on a completed
  close through EMA8 or EMA21 against the position;
- costs and gates: market-specific measured `$100` executable p95, adverse
  funding, separate `1.5 × p95` sensitivity, PF, mean L95, 4 chronological
  folds, IS/OOS, Long/Short, 30/60/90-day windows, drawdown, breadth,
  leave-one-market-out, dominance, calendar months and causal trend/volatility
  regimes. The same maximum-six-position portfolio capacity is used for every
  rule.

No rule may be changed after viewing this run. A complete failure closes this
family; a passing rule may enter prospective Shadow only after the frozen
result and its exact parameters are recorded here.

### Frozen result: rejected

The single preregistered run rejected all eight rules on both timeframes. The
least-negative portfolio was `SQZ20-L5-V1.25-E8`, but it was not close to an
admission boundary:

- 5m: 4,479 trades, net `−318.32%`, PF `0.76`, adverse net `−406.07%` / PF
  `0.71`, drawdown `−53.86%`, 0/4 folds, IS/OOS `−191.97 / −126.35`,
  Long/Short `−101.80 / −216.52`, one of 15 markets positive and 0/6 positive
  calendar months;
- 1m falsification control: 14,340 trades, net `−771.75%`, PF `0.64`, adverse
  net `−1009.38%` / PF `0.56`, drawdown `−129.49%`, 0/4 folds, IS/OOS
  `−565.84 / −205.92`, Long/Short `−374.85 / −396.91`, one of 15 markets
  positive and 0/6 positive months.

Every causal trend and volatility regime was negative. No individual-market
rule qualified either. The family is closed without a rescue grid, is not
registered in prospective Shadow and cannot enter Real.

## Preregistered RSI2 trend-pullback challenger

Before viewing its first result on 2026-07-31, a four-rule `RSI2PB` family was
frozen as a second independent candidate. It attempts to buy a short
counter-trend shock inside a fully aligned bull trend and sell the mirrored
shock inside a fully aligned bear trend.

- one shared rule over the same 15 markets; 5m is primary and the identical 1m
  transfer is a falsification control;
- trend is strictly `EMA21 > EMA55 > EMA200` for Long and the mirrored stack
  for Short;
- RSI2 threshold is 5 or 10, with either immediate touch or completed-candle
  reclaim; no other thresholds are allowed;
- exit when RSI2 reaches 50, otherwise a 1% safety stop or a maximum of 60 bars;
- execution is at the next bar open with market-specific measured `$100` p95,
  adverse funding and separate `1.5 × p95` sensitivity;
- the unchanged portfolio qualification requires PF, mean L95, 4 folds,
  IS/OOS, both sides, recent windows, drawdown, breadth, leave-one-out,
  dominance, months and causal trend/volatility regimes with a maximum of six
  simultaneous positions.

This is one frozen run. Complete failure closes the family without adding a
larger RSI/EMA grid; only a fully qualified rule may enter prospective Shadow.

### Frozen result: rejected

No portfolio or individual rule qualified. The least-negative five-minute
portfolio, `RSI2PB-5-touch+STACK21/55/200`, had 16,320 trades, net `−387.83%`,
PF `0.86`, adverse net `−806.88%` / PF `0.72`, drawdown `−69.47%`, 0/4 folds,
negative IS/OOS and negative Long/Short books. Its one-minute transfer was
worse: 78,559 trades, net `−2673.63%`, PF `0.64`, drawdown `−447.41%` and 0/4
folds.

HYPE 5m under the `5-touch` rule was the strongest individual row (`+29.08%`,
positive IS/OOS and Long/Short), but still failed the frozen PF gate at `1.18 <
1.20`; it therefore remains a rejected observation rather than a post-hoc
single-market strategy. The family is closed without retuning and is not added
to Shadow or Real.

## Execution sensitivity policy correction

On 2026-07-31 the remaining arbitrary cost sensitivity was removed from future
Native Quant scans. The blocking execution deduction remains each market's
measured executable `$100` round-trip p95. The separate non-blocking adverse
column now uses the maximum round-trip cost actually observed in the same
market/notional sample, not a fixed `0.10%`/`0.15%` value and not `1.5 × p95`.

The historical SQZ20 and RSI2PB result records above retain their original
`1.5 × p95` labels because changing a completed frozen result would be false
reporting. This policy correction applies prospectively. Once the continuously
recorded L2 dataset passes its frozen 21-day quality gate, its longer-window
tail estimate supersedes the short discovery samples; until then no new
candidate can use that dataset for promotion.

The last arbitrary funding deduction was then removed as well. The public
Lighter `/api/v1/fundings` history is fetched in sub-750-row chunks, checked for
at least 99% internal hourly coverage and required to span every tested candle.
Each backtest trade receives the exact signed settlements in `(entry, exit]`;
the payer side comes from the historical `direction` field. Missing or stale
funding now fails a qualifying run closed. The old `0.00125%/h` assumption is
available only behind an explicit exploratory flag and cannot qualify a
strategy.

The unchanged P2 rule was rerun after both corrections. Its blocking p95
result remains qualified: 759 trades, net `+125.27%`, PF `1.46`, 4/4 folds,
Long/Short `+83.14 / +42.14`, high/low-volatility regimes
`+67.85 / +57.43`, maximum capacity drawdown `−2.43%`, and all six months
positive. Exact funding contributed `−0.1412%` across all 759 trades. Replacing
p95 with each market's observed maximum produced `+118.32%` and PF `1.43`;
this remains non-blocking sensitivity evidence and does not alter the
prospective Shadow gate. The reproducible structured output is frozen in
`data/lighter-p2-portfolio-results.json`.

Prospective funding is now held to the same standard. A newly closed `$100`
Native Shadow trade first carries only a provisional entry/exit-rate estimate.
The 15-minute promotion job then reads the public hourly Lighter settlements,
requires at least 99% internal coverage spanning the trade, recalculates signed
funding over `(entry, exit]`, and atomically replaces `funding_pnl_pct` and net
PnL. A closed trade is excluded from every Native promotion gate until its
`funding_source` is `lighter_api_settlements`. API failure therefore delays the
sample instead of silently promoting on an estimate; it never blocks exits or
changes the price fill.

Native execution capacity is now cohort-consistent end to end. Selection,
prospective Shadow, promotion evidence and the future isolated Real canary all
use `$100` executable VWAP. Earlier Native `$1,000` Shadow rows are preserved
for auditability but excluded from the new promotion cohort. Any legacy open
position continues to be marked, stopped and closed against `$1,000` depth;
after a reverse signal the replacement Native position opens at `$100`.
LuxAlgo-sourced Shadow remains an independent `$1,000` cohort.

### ER60 challenger: rejected as a second strategy, retained as telemetry

A symmetric Kaufman efficiency-ratio filter was tested on the existing
two-sided VWZ60 family at both 1m and 5m. It did not produce an independent
portfolio: no common 15-market rule qualified and every 1m variant failed.
On HYPE, `ER60 < 0.35` kept 352 of the existing strategy's 356 trades and
improved 180-day net by only `0.98` percentage points. On BTC it kept 100 of
103 trades; the `1.88` point improvement came entirely from older trades,
while the 30/60/90-day windows were unchanged. Running these variants beside
their parent strategies would therefore double-count substantially identical
exposure.

The separate Shadow candidates are rejected. Instead, every future Native
signal stores the completed-bar `ER60` value in
`lighter_lux_signals.native_er60`. This creates a clean prospective dataset
for deciding whether the filter should eventually replace part of a parent
rule, without opening a duplicate position or using the historical selection
sample as if it were new OOS evidence. Frozen evidence lives in
`data/lighter-er60-results.json`.

### BTC-shock alt catch-up: rejected

An independent two-leg lead/lag hypothesis was preregistered before its first
run. After a two-standard-deviation 15-minute BTC shock, the model selected
the single most delayed beta-adjusted alt (`residual z <= -1` in the shock
direction), traded that alt toward BTC, hedged with BTC, entered at the next
bar open and exited after 30 minutes. The same rule was tested at 1m and 5m
over all 15 markets with a seven-day causal beta, no overlapping pair,
market-specific `$100` p95 execution costs and adverse funding.

Neither timeframe passed. The 1m path produced 618 pairs, `-3.78%`, PF `0.94`
and `-9.27%` under adverse execution. The 5m path produced 848 pairs,
`-1.89%`, PF `0.98`, `-12.47%` adverse net, a negative mean-trade L95,
`-11.10%` drawdown and only one positive chronological fold of four. Although
its final 30% OOS slice was positive, discovery, bull and low-volatility
segments were negative. That isolated OOS observation is insufficient to
override the frozen multidimensional gate. No Shadow or Real strategy was
registered; the evidence is frozen in
`data/lighter-btc-shock-catchup-results.json` without retuning.

The transition to long-window costs is now mechanical. The exporter
`scripts/export-lighter-native-execution-costs.ts` refuses to create a scanner
cost file unless the audit is fresh, all 15 markets are present, the notional
is exactly `$100`, at least 21 days are covered, and 1m coverage, 1m quality,
execution-cost coverage and valid 5m rollups are each at least 95%. Its output
is loaded after the discovery file and therefore supersedes the short sample
only after those conditions pass. A production audit with less than one day of
history was verified to return `not_ready` and create no file.

Forward decay is evaluated separately from the cumulative promotion sample.
After 40 prospective closes, the latest 20 must remain net-positive with PF at
least 1.00; otherwise new Shadow entries stop and require manual re-research,
while existing positions can still exit. Operational execution health uses the
latest 100 resolved signals and starts after 20: capture errors must stay at or
below 2%, every captured row must have book age, and book-age p95 must stay at
or below two seconds. This operational pause is recoverable only when unhealthy
rows age out of the fixed recent window. Whole-cohort execution failures still
prevent Real promotion, but no longer keep a recovered Shadow feed disabled.
Real remains manual and is never enabled by the audit itself.

The isolated `$100` Real-canary has a second, independent fail-closed layer.
The Python executor verifies the promotion report version, `$100` notional,
every frozen threshold, freshness, explicit strategy evidence and the manual
canary-review decision. A schema or threshold change therefore blocks new
Native Real entries until it is independently reviewed in the executor; an ID
appearing in `eligibleStrategyIds` alone is not sufficient.
Each strategy is permanently paused for manual review as soon as its observed
maximum Real drawdown reaches `$5`, even before ten closes. Starting at ten
closes, cumulative net/PF, the chronological second half and the most recent
ten exact Real trades must remain positive with PF at least `1.00`; starting at
twenty, the full Real book needs PF at least `1.20` to show `passed`. The
existing `$10` daily and `$15` portfolio-drawdown breakers remain additional
ceilings. A paused strategy is never re-enabled automatically, and disabling
entries never blocks reconciliation, reduce-only stops or exits for an open
position.

### Frozen breakout-family rejection (2026-07-31)

The next independent hypothesis was symmetric trend/breakout rather than
another P2 mean-reversion variation. A frozen common grid tested Donchian
breakouts, Keltner reclaim/trend breakouts and strong-candle impulse
continuation on the same 15 markets at both 1m and 5m. Entries used the next
bar, costs used each market's measured `$100` full-round-trip p95 plus adverse
funding, and the same individual/portfolio OOS, side, fold, regime, drawdown and
concentration gates applied.

Nothing qualified. The best portfolio result in each family remained deeply
negative: Donchian `-601.12%`/PF `0.83` at 5m and `-2956.99%`/PF `0.69` at 1m;
Keltner `-717.77%`/PF `0.87` and `-5259.53%`/PF `0.65`; impulse continuation
`-531.11%`/PF `0.73` and `-2362.19%`/PF `0.72`. Both sides and OOS were red and
no variant passed more than one of four folds. The full frozen record is in
`data/lighter-breakout-family-results.json`. These families are rejected and
must not be added to Shadow or revisited through per-market parameter fitting.

### Failed-breakout liquidity sweep: rejected (2026-07-31)

The next independent two-sided hypothesis was frozen before its first run and
used no parameter grid. On a completed candle, price had to penetrate the
prior 20-bar Donchian boundary by at least `0.25 ATR14`, close back inside the
old range in the reversal direction and print volume at or above its trailing
20-bar mean. Entry was the next bar open; exit was SMA20, a 1.5% safety stop or
a fixed 60-minute timeout. Long and Short rules were exact mirrors.

The same rule was tested across the common 15-market portfolio at 1m and 5m,
using each market's measured executable `$100` p95 full-round-trip cost,
separate worst-observed sensitivity and adverse time-weighted funding. Both
timeframes failed decisively. The 1m portfolio produced 26,568 trades,
`-849.67%`, PF `0.78`, `-992.05%` under observed-maximum execution and 0/4
positive chronological folds. The 5m portfolio produced 7,472 trades,
`-286.54%`, PF `0.87`, `-333.28%` adverse net, 0/4 folds, negative IS/OOS,
negative Long/Short books and negative bull, bear, mixed, high- and
low-volatility regimes.

HYPE 5m was the best individual row but was not a valid exception: PF was only
`1.08`, mean-trade L95 was `-0.0277%`, only 2/4 folds were positive, Short
generated `+13.59%` versus only `+1.69%` Long, and drawdown reached `-17.38%`.
The family is therefore rejected without post-hoc retuning and is not added to
Shadow or Real. Frozen evidence is in
`data/lighter-failed-breakout-results.json`.

### UTC hour-boundary fade: rejected, including independent holdout

One fixed symmetric rule faded only the first completed candle of each UTC
hour when its body was at least ATR14 and volume was at least SMA20. Entry was
next-bar open, with a 30-minute timeout and 1.5% safety stop. The common
15-market discovery portfolio failed: 1m returned `-348.03%`/PF `0.83`; 5m
returned `-50.15%`/PF `0.97`. The 5m diagnostic split was positive in high
volatility (`+92.60%`, PF `1.12`) and negative in low volatility (`-142.76%`,
PF `0.84`). Because that split was observed after the run, it was not treated
as validated evidence.

A single follow-up was frozen before inspecting seven markets excluded from
discovery. It kept all mechanics unchanged and admitted a signal only when
completed-bar ATR14/close exceeded its causal trailing 288-bar mean. Fresh
40-snapshot `$100` L2 samples supplied each holdout market's own p95 and
worst-observed full-round-trip costs. The high-volatility 1m holdout failed at
`-117.76%`, PF `0.70`, negative OOS and 0/4 folds. The 5m holdout had positive
headline net (`+45.92%`, PF `1.15`) but failed the frozen gate: mean L95
`-0.0025%`, OOS `-14.37%`, latest 30 days `-12.37%`/PF `0.80`, and only 2/4
folds.

AAVE was the strongest individual holdout but was not selected: its Short book
was negative in both the 60- and 90-day windows, and choosing the best market
after viewing holdout results would be post-hoc cherry-picking. The entire
family is rejected without Shadow or Real registration. Frozen evidence is in
`data/lighter-hourfade-results.json`.

### P2 external-market transfer: rejected

The already frozen `Z60STACK-2.5-touch` rule was then tested unchanged on six
liquid markets excluded from the original 15-market P2 selection: AAVE, ARB,
LINK, PUMP, UNI and XRP. No threshold, stop, holding period or exit was
altered. Each market used a fresh 40-snapshot `$100` executable p95 and
worst-observed cost sample.

Transfer failed at both timeframes after replacing assumed funding with exact
hourly settlements. The 1m holdout produced 1,388 trades, `-45.00%`, PF
`0.85`, L95 `-0.0587%`, negative Long/Short books and only 1/4 positive folds.
The 5m holdout produced 297 trades, `-15.41%`, PF `0.89`, L95 `-0.1566%`, OOS
`-3.95%`, negative Long/Short books and 2/4 folds. The
latest 30/60-day 5m windows were positive, but the 90-day window remained
negative and no individual market passed the full frozen gate.

No external leg is added. The failure does not rewrite the original P2 sample,
but it prevents any claim that the rule transfers universally and reinforces
the decision to keep P2 prospective Shadow-only. Frozen evidence is in
`data/lighter-p2-transfer-holdout-results.json`.

## Preregistered cross-sectional reversal pair

Before inspecting any result, the next independent family was frozen as one
market-neutral rule rather than another per-coin Z-score variation:

- universe: the same 15 P2 markets, with synchronized gap-free candles;
- at the final completed candle of each UTC hour, rank every market by its
  trailing one-hour close-to-close return;
- require the winner/loser return spread to be at least `2%`; buy the laggard
  and short the leader at the next candle open, `$100` per leg;
- allow only one pair at a time; close both legs at the first next-bar open
  after one hour, or after completed-bar pair PnL breaches `−2%`;
- run the exact same clock-time rule at 1m and 5m, so lookback/holding periods
  remain one hour rather than changing economic meaning with timeframe;
- subtract each selected leg's market-specific measured `$100` full-round-trip
  p95, sum exact signed hourly Lighter funding for both legs and separately
  report the two observed-maximum execution costs;
- no parameter grid, per-market tuning, replacement of losing legs or rescue
  run is permitted after viewing the result.

Qualification requires at least 100 pairs, positive net, PF at least `1.20`,
positive mean-trade L95, 4/4 positive chronological folds, positive IS/OOS,
positive long-leg and short-leg contributions after allocating each leg's own
cost and funding, positive 30/60/90-day windows, maximum additive drawdown no
worse than `−5%` of the fixed `$200` pair capacity, at least five positive
calendar months, positive causal BTC 30-day bull/bear segments, and positive
high/low-volatility segments where the trailing seven-day hourly BTC realized
volatility is compared only with its own trailing 30-day value. Passing
historical evidence can admit prospective Shadow only; Real still requires the
separate frozen forward gate.

### Cross-sectional reversal pair: rejected

The single preregistered run failed at both timeframes and was not retuned. At
1m it produced 2,411 pairs, `−29.94%`, PF `0.96`, mean-pair L95 `−0.0423%`,
2/4 positive chronological folds and a `−99.01%` maximum additive drawdown on
the fixed `$200` pair capacity. The 5m clock produced the same 2,411 hourly
pairs, `−18.06%`, PF `0.98`, L95 `−0.0374%`, 2/4 folds and `−93.13%` drawdown.
Observed-maximum execution sensitivity was also negative at `−52.97%` (1m)
and `−41.09%` (5m).

The apparent recent improvement is not admissible as a rescue rule. The 5m
OOS slice was `+39.18%` and its latest 30/60/90-day windows were all positive,
but IS was `−57.25%`; only two calendar months were positive; the Short-leader
leg lost `−62.83%`; bull markets lost `−36.70%`; and low-volatility periods
lost `−15.39%`. Selecting only the later sample, the Long leg, bear markets or
high-volatility periods after viewing the result would be post-hoc
optimization rather than independent evidence.

The family is rejected with no Shadow or Real registration. The failure leaves
the existing frozen P2 prospective test unchanged. Reproducible summary
evidence is in `data/lighter-cross-sectional-reversal-results.json`.

## Preregistered BTC+ETH factor-residual hedge

Before calculating any result, one independent three-leg mean-reversion rule
was frozen. It models alt returns rather than price levels so that a persistent
uptrend cannot manufacture cointegration. The exact same clock-time rule is
tested at 1m and 5m:

- universe: the 13 non-BTC/ETH markets from the common 15-market gap-free
  Native dataset; BTC and ETH are the two hedge factors;
- estimate a causal centered two-factor OLS on bar log returns over the prior
  seven days, using a fixed `1e-6 × trace` diagonal ridge only to stabilize the
  highly correlated BTC/ETH covariance matrix;
- accept an alt estimate only when rolling multiple R-squared is at least
  `0.30` and both factor betas are finite with absolute value at most `3`;
- sum each alt's causal OLS residual returns over one hour and standardize that
  sum against its own trailing seven-day history; every 15 minutes select the
  single most extreme eligible absolute residual Z-score;
- at `|Z| >= 2.5`, take the opposite residual exposure at the next bar open:
  alt exposure `d`, BTC `−d × betaBTC`, ETH `−d × betaETH`, where `d=+1` for a
  negative residual and `d=−1` for a positive residual;
- normalize absolute leg notionals to one fixed `$100` gross package. A leg
  below `$100` is charged its market's measured `$100` p95 full-round-trip
  percentage, which is conservative because it does not assume better
  percentage execution for the smaller order;
- close all legs at the next bar open after the residual crosses zero, reaches
  `|Z| >= 4` against the position, or after 60 minutes. Only one package may be
  open, and no same-bar execution is permitted;
- deduct each weighted leg's measured p95 cost and exact signed hourly Lighter
  funding; report weighted observed-maximum execution separately;
- no threshold, beta window, Z window, exit, market subset or regime may be
  changed after the first result is viewed, and no rescue run is permitted.

Qualification requires at least 120 closed packages, positive net, PF at least
`1.20`, positive mean-trade L95, positive observed-maximum net with PF at least
`1.10`, maximum additive drawdown no worse than `−5%` of the fixed `$100`
package capacity, 4/4 positive chronological folds, positive IS and untouched
final-30% OOS with PF at least `1.10`, positive negative-Z and positive-Z books,
positive 30/60/90-day windows on both directions, at least five positive
calendar months, positive causal BTC bull/bear and high/low-volatility regimes,
at least six active alts, leave-one-alt-out minimum above zero and positive-PnL
dominance no higher than `60%`. A historical pass can enter prospective Shadow
only; Real remains governed by the separate frozen forward gate.

### BTC+ETH factor-residual hedge: rejected

The preregistration was committed as `2afe7f9` and the matching implementation
as `122d940` before the first result was generated. The single frozen run
failed at both timeframes. At 1m it produced 784 packages, `−8.26%`, PF `0.88`,
mean-pair L95 `−0.0241%`, 0/4 positive folds and `−12.58%` maximum additive
drawdown. At 5m it produced 1,426 packages, `−32.98%`, PF `0.81`, L95
`−0.0372%`, 1/4 folds and `−38.27%` drawdown. Observed-maximum execution
sensitivity remained negative at `−10.27%` and `−38.30%` respectively.

The final 30% OOS slice was mildly positive (`+3.28%` at 1m and `+3.76%` at
5m), but this cannot override the deeply negative IS (`−11.54%` and
`−36.74%`). The 1m negative-Z book lost `−9.67%`, its latest 30 and 90 days
were negative, bull/bear and low-volatility segments were negative, and only
two months were positive. Both 5m directions, all recent windows, bear/high-
and low-volatility segments and all calendar months were negative. Selecting
only positive-Z 1m, high-volatility 1m, HYPE or the final OOS after observing
the report would be an unregistered rescue rule.

The family is rejected without Shadow, Real or website registration. Exact
funding was economically immaterial (`+0.0095%` at 1m and `+0.0201%` at 5m);
the failure is the signal rather than an assumed fee reserve. Reproducible
summary evidence is in `data/lighter-factor-residual-hedge-results.json`.

## Closed cross-sectional residual directions

Two earlier preregistered directions used the same fixed 15-market universe,
seven-day causal BTC beta, one-hour residual move, 15-minute decision clock,
one-hour hold and next-bar execution. Residual reversion bought the laggard
and sold the leader; residual momentum did the exact reverse. Both used the
then-current market-specific `$100` executable p95 costs and a deliberately
adverse funding allowance.

Neither direction is a candidate for a corrected-cost rescue run. Residual
reversion lost `−96.14%`/PF `0.84` at 1m and `−60.77%`/PF `0.92` at 5m, with
0/4 positive folds at both timeframes. Residual momentum lost `−150.92%`/PF
`0.76` at 1m and `−288.76%`/PF `0.66` at 5m, with negative IS, OOS, bull,
bear, high- and low-volatility segments. Replacing the old non-blocking
`1.5× p95` sensitivity and small adverse funding allowance with the current
observed-maximum/exact-funding reporting cannot repair the blocking p95 net or
PF. The families are closed without Shadow or Real registration. Frozen
evidence is in `data/lighter-xs-residual-results.json` and
`data/lighter-xs-momentum-results.json`.

## Preregistered dynamic pair-spread mean reversion

Before calculating any result, the next independent two-sided hypothesis is
frozen as a dynamically selected market-neutral pair rather than a BTC-factor
residual or a winner/loser return rank:

- universe: all unordered pairs among the same 15 synchronized, gap-free
  Native markets;
- every 15 completed minutes, estimate each pair's causal return beta and
  correlation over the prior 30 days; require positive beta in `[0.20, 3.00]`
  and correlation at least `0.75`;
- form the causal log-price spread `log(A) − beta × log(B)` and standardize it
  against its trailing seven-day mean and variance;
- select only the single eligible pair with the largest absolute spread
  Z-score and require `|Z| >= 3.0`; sell the rich leg and buy the cheap leg,
  with absolute leg notionals normalized to one fixed `$100` gross package;
- enter at the next bar open, permit only one package at a time and close both
  legs after six hours or at the first next-bar open after completed-bar
  package PnL reaches `−2%` of package capacity;
- run the same clock-time economics at 1m and 5m, deduct each weighted leg's
  market-specific measured `$100` full-round-trip p95 and exact signed Lighter
  funding, and report observed-maximum execution as a separate adverse
  sensitivity;
- no correlation threshold, beta window, spread window, Z threshold, holding
  period, stop, pair subset, timeframe or regime may be changed after the
  first result is inspected. A failed run closes the family without a rescue
  grid.

Qualification requires at least 120 packages, positive p95 net, PF at least
`1.20`, positive mean-trade L95, positive observed-maximum net with PF at
least `1.10`, maximum additive drawdown no worse than `−5%` of the fixed `$100`
package capacity, 4/4 positive chronological folds, positive IS and untouched
final-30% OOS with PF at least `1.10`, positive rich-A and rich-B directions,
positive 30/60/90-day windows on both directions, at least five positive
calendar months, positive causal BTC bull/bear and high/low-volatility
segments, at least six active markets, leave-one-market-out minimum above zero
and positive-PnL dominance no higher than `60%`. A historical pass may create
prospective Shadow only; Real remains disabled and requires its separate frozen
forward gate.

### Dynamic pair-spread mean reversion: rejected

The preregistration was committed as `20749d2` and the matching implementation
as `908c853` before the first result was calculated. The frozen rule found no
eligible 1m packages: over the 30-day causal window, no pair simultaneously
met the `0.75` return-correlation requirement and reached a three-sigma
seven-day level spread at an otherwise available decision. This is a valid
zero-sample rejection, not permission to lower the gate after seeing it.

The 5m path produced only six packages and also failed economically: net
`−1.21%`, PF `0.50`, observed-maximum net `−1.22%`, mean-trade L95
`−0.6584%`, 2/4 positive folds and IS/OOS `−1.62% / +0.40%`. Only the
`rich_a` direction traded and it was negative; the required two-sided breadth,
minimum sample, regimes and recent windows therefore failed as well. Exact
funding was included but cannot explain the absence of signals or the negative
price result.

No threshold, lookback, holding period or pair subset is retuned. The family is
closed without Shadow, Real or website registration. Frozen evidence is in
`data/lighter-dynamic-pair-spread-results.json`.

## Prospective L2 microstructure research cost policy

The continuously recorded gap-free Lighter L2 dataset has not yet reached its
first seven-day exploratory gate or its 21-day frozen candidate gate. Before
either result could be inspected, the preregistered microstructure sweep was
aligned with the corrected Native execution policy:

- blocking net deducts the completed signal bar's causal `$100` executable
  round-trip p95 for that market;
- the separate adverse column deducts the worst `$100` round trip actually
  observed inside the same completed signal bar;
- no fixed `0.10%`/`0.15%` reserve and no `1.5 x p95` multiplier can qualify or
  reject a rule;
- missing observed-maximum execution data rejects that signal rather than
  falling back to an assumed value.
- holding-period funding is the exact signed public Lighter hourly settlement
  in `(entry, exit]`; the recorded current rate remains a causal signal feature
  but is not interpolated into trade PnL.

This is a preregistration correction, not a result-dependent rescue: the sweep
was still `not_ready`, and no microstructure rule had produced an eligible
evaluation when the policy was changed. The first future output will therefore
use measured p95 for the blocking economics and observed maximum only as
non-blocking sensitivity from its first admissible run.

The operational outputs are deliberately separated. A daily seven-day
exploratory sweep writes
`data/lighter-native-microstructure-exploratory.json`; its implementation
always emits an empty `shadowEligibleRules` list and cannot promote anything.
The independent 21-day frozen sweep continues to write
`data/lighter-native-microstructure-sweep.json`. Exploratory results therefore
cannot overwrite or relax the frozen candidate gate.

The frozen timer is a one-shot selection despite running daily. The first
report produced after every 21-day readiness condition passes is marked
`immutableSelection=true` and is returned unchanged on every later run. An
evaluated file without the immutable marker or with a mismatched schema causes
the sweep to fail closed rather than overwrite it. Thus an initially rejected
rule cannot become a candidate merely because the same holdout was inspected
again on a longer rolling window.

After that immutable selection, a separate fail-closed preparation timer
creates `data/lighter-native-microstructure-shadow-manifest.json`. Its
activation timestamp is later than the selection timestamp, its rule IDs must
have exactly one matching qualified evaluation, and its frozen-report hash may
never change. An empty first selection is persisted as `no_candidates` rather
than waiting for a later rerun. The manifest fixes `$100`, ten maximum
concurrent Shadow positions, `autoPromotion=false` and `realEnabled=false`;
historical selection-period trades cannot enter the prospective cohort.

The five-minute Shadow accounting timer is dormant until that manifest exists.
Once active, it reconstructs only entries at or after `activatedAt`, uses the
same causal next-bar fills, measured market/bar `$100` p95, `$500` depth gate,
exact settled funding and frozen holds, and enforces the ten-position limit
once across the complete cohort. It writes only completed prospective trades
to `data/lighter-native-microstructure-shadow-report.json`; the report carries
`prospectiveOnly=true`, `exactFunding=true`, `autoPromotion=false` and
`realEnabled=false`. Pre-activation data is used only for the 240-minute causal
feature warm-up and can never appear as a Shadow trade.

## Preregistered dual-timeframe L2 protocol

Before the first seven-day microstructure result was available, the six frozen
L2 hypotheses were extended from a five-minute-only implementation to two
independent timeframe paths. This is not a larger parameter grid: every rule
keeps the same economic meaning at `1m` and `5m`.

- signal features use only the completed bar and require an unbroken native
  sequence; 1m never comes from interpolating a 5m candle, while 5m is built
  only from all five consecutive quality-approved 1m rows;
- trend uses causal 60-minute and 240-minute EMAs on each timeframe; volatility
  compares the trailing 60-minute return dispersion with its own causal
  240-minute absolute-return EMA;
- `OF-CONT-25-H1` and `ABSORB-55-H1` hold five clock minutes,
  `OF-CONT-25-H3`, `ABSORB-55-H3` and `BASIS-4BP-H3` hold 15 minutes, and
  `BASIS-4BP-H6` holds 30 minutes. Thus a suffix is an economic horizon, not a
  raw bar count that changes when the timeframe changes;
- every signal enters only at the next bar open and exits at the first bar open
  after the frozen holding horizon. Missing intermediate bars reject the trade;
- the portfolio admits at most ten overlapping `$100` positions. Capacity is
  released when an exit timestamp is reached; simultaneous entries are ordered
  by immutable numeric Lighter market ID and every proposal after slot ten is
  skipped. Reported drawdown therefore cannot assume more capital than the
  executable portfolio;
- each timeframe/rule is evaluated separately. A positive 1m result cannot
  repair a failed 5m result or vice versa, and results may not be pooled to pass
  a gate;
- the first seven calendar days form a diagnostic discovery segment that can
  never qualify a strategy. Frozen research starts only after 21 complete days
  and requires the subsequent 14-day OOS segment to be independently positive
  with PF at least `1.10`;
- the existing total-sample gates remain: at least 120 trades, net positive, PF
  at least `1.20`, positive mean-trade L95, positive Long and Short books with
  at least 30 trades each, three positive chronological thirds, drawdown no
  worse than 5% of ten fixed `$100` capacity units, positive bull/bear and
  high/low-volatility regimes, at least four active markets, majority-positive
  breadth, dominance at most 60% and positive leave-one-market-out net;
- OOS additionally requires at least 60 trades and positive Long and Short
  contributions with at least 15 trades per side. Observed-maximum execution is
  reported but remains non-blocking; p95 and exact funding determine the gate.

Only a timeframe/rule that passes every frozen condition may be registered in
prospective Shadow. Historical qualification cannot enable Real; the separate
prospective `$100` forward gate remains mandatory.

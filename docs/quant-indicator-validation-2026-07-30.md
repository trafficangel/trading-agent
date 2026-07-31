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

The unchanged P2 rule was rerun immediately after the policy correction. Its
blocking p95 result remains qualified: 758 trades, net `+122.80%`, PF `1.45`,
4/4 folds, Long/Short `+82.70 / +40.10`, high/low-volatility regimes
`+67.10 / +55.71`, maximum capacity drawdown `−2.45%`, and all six months
positive. Replacing `1.5 × p95` with each market's observed maximum produced
`+115.86%` and PF `1.42`; this is reported as sensitivity evidence and does not
alter the prospective Shadow gate.

Native execution capacity is now cohort-consistent end to end. Selection,
prospective Shadow, promotion evidence and the future isolated Real canary all
use `$100` executable VWAP. Earlier Native `$1,000` Shadow rows are preserved
for auditability but excluded from the new promotion cohort. Any legacy open
position continues to be marked, stopped and closed against `$1,000` depth;
after a reverse signal the replacement Native position opens at `$100`.
LuxAlgo-sourced Shadow remains an independent `$1,000` cohort.

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

# Lighter low-timeframe LuxAlgo research

Date: 2026-07-30

Status: **rejected for shadow and live trading**.

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

## Reproduction

Run on the VPS, where the historical kline cache is populated:

```bash
pnpm tsx scripts/research-lighter-quant.ts 1
pnpm tsx scripts/research-lighter-quant.ts 5
pnpm tsx scripts/research-lighter-range.ts 1
pnpm tsx scripts/research-lighter-range.ts 5
```


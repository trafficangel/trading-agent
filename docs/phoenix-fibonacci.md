# Phoenix Fibonacci

Status: rejected research. This is a high-risk moonshot progression test, not a
capital-preserving trading system.

## Frozen setup

- Entry family: impulse candle, volume spike, BTC alignment, pullback to the
  0.5 Fibonacci retracement of the impulse candle.
- Stake progression: 10, 10, 20, 30, 50, 80 USDT.
- Target: +300% on isolated margin.
- Loss: invalidation/liquidation/timeout, then advance one Fibonacci step.
- Reset to base stake after a profitable trade.
- Fees/stress: 11 bps Bybit taker round-trip plus 8 bps adverse slippage.
- Symbols: 20 liquid Bybit USDT perps.
- Test window: 180 days.

## Initial full-stop result

VPS Bybit kline replay, 2026-01-14 through 2026-07-13 approximately:

| Profile | Trades | Win rate | Net | PF | Max DD | Liquidations | Dead cycles |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1m-L20 | 685 | 15.8% | -13,787.86 | 0.08 | 13,852.62 | 0 | 71 |
| 1m-L30 | 1,501 | 13.9% | -30,178.53 | 0.13 | 30,510.38 | 0 | 175 |
| 1m-L50 | 1,713 | 14.5% | -31,476.08 | 0.20 | 31,809.17 | 11 | 193 |
| 3m-L20 | 461 | 20.6% | -6,994.05 | 0.16 | 6,995.41 | 0 | 41 |
| 3m-L30 | 973 | 22.8% | -12,208.35 | 0.28 | 12,404.27 | 6 | 78 |
| 3m-L50 | 992 | 23.5% | -8,782.49 | 0.48 | 10,533.08 | 29 | 79 |

Verdict: reject. The Fibonacci progression amplifies a negative-entry edge; it
does not repair it. This configuration should not be paper-traded or live-traded
without a different entry edge.

## Variant sweep

I retested the idea with partial stop accounting, lower targets, reclaim entry,
and breakout-after-pullback entry. Partial stops fixed an overly pessimistic
assumption in the first replay: invalidation before liquidation should lose only
the realized margin loss, not necessarily the full stake.

Best 180-day variants:

| Profile | Variant | Net | PF | Max DD | Dead cycles | Read |
|---|---|---:|---:|---:|---:|---|
| 3m-L50 | fib300-partial | +716.60 | 1.10 | 2,602.69 | 79 | small positive, large DD |
| 3m-L30 | fib200-partial | +407.24 | 1.09 | 1,641.75 | 78 | small positive, fragile |
| 3m-L20 | fib200-partial | +52.51 | 1.02 | 1,099.61 | 78 | near zero |
| 3m-L20 | breakout150 | -132.70 | 0.92 | 611.13 | 14 | less bad, still negative |

Recent 60-day sanity check:

| Profile | Variant | Net | PF | Max DD | Dead cycles |
|---|---|---:|---:|---:|---:|
| 3m-L50 | fib300-partial | -2,377.38 | 0.38 | 2,377.38 | 49 |
| 3m-L30 | fib200-partial | -1,511.76 | 0.34 | 1,511.76 | 49 |
| 3m-L20 | fib200-partial | -1,014.07 | 0.34 | 1,014.07 | 49 |
| 3m-L20 | breakout150 | -548.02 | 0.34 | 548.02 | 11 |

Updated verdict: reject for live and paper. Partial stops make the idea much
less destructive, but the edge is not stable. The small 180-day positives fail
the recent-window check and carry drawdowns far too large for a 10 USDT base
stake.

Run:

```bash
pnpm tsx scripts/phoenix-fibonacci.ts 180
```

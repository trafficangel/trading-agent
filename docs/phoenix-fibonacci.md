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

## Latest result

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

Run:

```bash
pnpm tsx scripts/phoenix-fibonacci.ts 180
```

# Post-Shock Absorption v1

Status: read-only research. This track has no private exchange client and no
order path.

## Latest frozen result

Tokyo Tardis replay, 2025-12-01 through 2026-06-01 rotating 4-hour windows,
8 coins, 3,031,944 250 ms points, 100% exact Bybit print coverage:

- detected signals: 105;
- stress-500ms OOS: 9 signals, 4 fills, -63.97 bps net, PF 0.21;
- stress-500ms all data: 51 fills, -540.47 bps net, PF 0.28;
- verdict: no live monitor and no capital allocation for this frozen version.

The research code is kept to support future variants, but this parameter set is
not a candidate for deployment.

## Mechanism

The strategy does not fade an initial price shock. It waits for evidence that
the forced flow was absorbed:

1. Bybit moves at least 15 bps over 2 seconds and at least 3x its volatility
   baseline.
2. Trade flow is at least 4x its 60-second baseline and at least 75% aligned
   with the move.
3. Impacted L5 depth falls to 80% or less of its pre-shock value.
4. Within 0.5-3 seconds, price reclaims at least 30% of the move, impacted L5
   depth recovers to at least 60%, the book is not strongly opposed, and the
   original aggressor flow decays to at most 60% of its shock rate.

All inputs are available at or before the signal timestamp.

## Execution replay

- Venue: Bybit linear futures.
- Entry: post-only at the observed BBO after 250/500/1000 ms latency.
- Queue: visible top-level size multiplied by 1.25/1.5/2.0. Same-price prints
  must consume the queue; a strict trade-through fills immediately.
- Entry TTL: 2 seconds.
- Target: the valid pre-shock opposite BBO, modeled as a maker order. An off-BBO target fills
  only on a strict trade-through because its queue is unknown.
- Stop: another 50% of the original shock beyond the shock extreme.
- Taker exits occur after the same 250/500/1000 ms latency as entry.
- Time stop: 20 seconds plus execution latency, crossed at the observed BBO.
- Fees: 2 bps maker and 5.5 bps taker. Stress profiles add 2.5 or 4.5 bps.
- Data gaps never fill or exit a synthetic trade.

Bybit RPI liquidity is not visible in the public book. Queue multipliers are a
deliberate penalty for that hidden queue, not a claim that displayed size is
our exact queue position.

## Frozen gates

Research pass uses the 500 ms stress profile on untouched OOS dates:

- at least 30 conservative fills;
- positive net and positive net after removing the best trade;
- profit factor at least 1.20;
- cumulative 1x trade-return drawdown no greater than 200 bps;
- at least three positive coins;
- at least two-thirds of traded OOS dates positive.

Live-canary review additionally requires at least 500 OOS fills across at
least 30 OOS dates. No result can enable live trading automatically.

Run:

```bash
pnpm hft:post-shock <replay-directory> all
```

The analyzer writes `post-shock-analysis.json` atomically in the replay
directory.

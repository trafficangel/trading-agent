# Cascade Lead-Lag v1

Status: read-only research. This track has no private exchange client and no
order path.

## Latest frozen result

Tokyo Tardis replay, 2025-12-01 through 2026-06-01 rotating 4-hour windows,
3 leaders, 7 laggers, 250 ms points:

- raw signals: 48 across all leader-lagger pairs;
- stress-500ms all data: 48 attempts, 6 fills, -55.42 bps net, PF 0.39;
- stress-500ms OOS: 7 attempts, 0 fills;
- verdict: reject this frozen version, no live monitor and no capital
  allocation.

The idea remains researchable, but this exact taker catch-up formulation is not
a deployment candidate.

## Mechanism

The strategy follows delayed propagation, not funding and not same-tick
arbitrage. A leader coin must move first on strong flow; a related lagger is
eligible only if it has not yet completed its beta-implied catch-up.

Frozen signal:

1. Leader is BTC, ETH, or SOL.
2. Leader moves at least 18 bps over 4 seconds.
3. Leader Bybit flow is at least 3x its 60-second baseline and at least 70%
   aligned with the move.
4. Lagger beta to leader is estimated causally from the previous 7.5 minutes and
   must be between 0.2 and 2.5.
5. Beta-implied lagger move must be at least 14 bps.
6. Lagger has completed less than 45% of the expected move.
7. Lagger spread is no wider than 6 bps and the top-5 book is not strongly
   opposed to the trade.

## Execution replay

- Venue model: Bybit linear futures.
- Entry: taker after 250/500/1000 ms latency.
- Exit: taker target, stop, or time exit after the same latency.
- Target: 70% of the beta-implied catch-up from the pre-shock lagger mid.
- Stop: 55% of the expected move against entry.
- Max hold: 120 seconds.
- Fees: 5.5 bps per taker side. Stress profiles add 3 or 6 bps.
- Minimum remaining edge at entry: 16 bps before fees.

## Frozen gates

Research pass uses the 500 ms stress profile on untouched OOS dates:

- at least 30 conservative fills;
- positive net and positive net after removing the best trade;
- profit factor at least 1.20;
- cumulative 1x trade-return drawdown no greater than 250 bps;
- at least three positive leader-lagger pairs;
- at least two-thirds of traded OOS dates positive.

Live-canary review additionally requires at least 500 OOS fills across at
least 30 OOS dates. No result can enable live trading automatically.

Run:

```bash
pnpm hft:cascade <replay-directory> all
```

The analyzer writes `cascade-leadlag-analysis.json` atomically in the replay
directory.

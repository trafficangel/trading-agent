# Lighter LuxAlgo exit-overlay audit — 2026-07-27

## Scope

- 15 two-sided LuxAlgo strategies.
- 2,254 complete historical trades.
- One-minute Bybit candles used as the liquid historical price-path proxy.
- Lighter trading fee: 0%.
- Conservative execution-friction stress: 0.05% round trip.
- Same-minute ordering is conservative: the hard stop and an already-armed
  trailing stop are evaluated before a new intrabar extreme can arm or tighten
  the trail.

## Portfolio result

| Exit rule | Net | Delta vs native | Max drawdown |
|---|---:|---:|---:|
| Native LuxAlgo reverse/exit signal | +685.22% | — | -19.66% |
| TP 4% | +631.95% | -53.26 pp | -25.45% |
| Trail: arm 4%, gap 1% | +628.92% | -56.30 pp | -26.92% |
| Trail: arm 3%, gap 1% | +605.59% | -79.63 pp | -28.90% |
| Configured safety stop | +581.89% | -103.33 pp | -29.69% |
| TP 1% | +277.49% | -407.73 pp | -36.70% |

The native LuxAlgo exit is the best portfolio-level rule. The apparent benefit
of a 4% trailing arm in the first chronological third reverses in the next two
thirds:

- trail arm 4% / gap 1%: +15.27 pp, -9.01 pp, -62.56 pp versus native;
- TP 4%: +8.10 pp, -8.36 pp, -53.00 pp versus native.

Therefore neither a universal take-profit nor a universal trailing overlay
should be added to Real or to the primary Shadow accounting.

## Strategy-specific exception worth prospective Shadow testing

Only `bnb-cntr-hw-weak` passed all of these gates:

- positive total delta;
- positive delta in both chronological halves;
- positive delta in every chronological third;
- at least five historical overlay exits.

| Candidate | Delta | Halves | Thirds | Altered exits |
|---|---:|---:|---:|---:|
| Trail arm 4% / gap 1% | +10.25 pp | +3.83 / +6.43 | +1.19 / +5.82 / +3.24 | 6 |
| Trail arm 3% / gap 1% | +9.99 pp | +3.16 / +6.82 | +0.53 / +5.33 / +4.13 | 11 |
| Trail arm 3% / gap 1.5% | +7.87 pp | +2.84 / +5.02 | +0.73 / +4.78 / +2.36 | 8 |

The 3% / 1% candidate has the larger effective sample and is the preferred
prospective Shadow A/B candidate. It must remain hypothetical and must not
change the native shadow position or any Real order until enough prospective
overlay exits accumulate.

## Decision

1. Keep native LuxAlgo exits for the portfolio.
2. Do not add a universal fixed take-profit.
3. Do not tighten the existing safety stops based on this study.
4. Prospectively observe `bnb-cntr-hw-weak` with an independent hypothetical
   trailing overlay: arm at +3%, follow the best executable exit price by 1%.
5. Reconsider only after at least 15 prospective overlay exits and require the
   overlay to improve net PnL without worsening drawdown.


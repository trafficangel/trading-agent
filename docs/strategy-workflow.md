# Workflow: adding a new strategy

This is the canonical process for evaluating and adding a Track C
strategy. The hard rule (Phase Q, May 28, 2026): **safety SL ≤ 8%**.
Strategies that can't be made profitable under an 8% cap are rejected.

The verdict is based on **PnL simulation**, not cut rate. We simulate
the strategy's net PnL at each candidate cap using MAE data (worst
intra-trade excursion). The cap that maximises sim PnL within the 8%
ceiling becomes the recommended slPct.

## Step 1 — Find a candidate in LuxAlgo

Operator finds a strategy in LuxAlgo AI Strategy Builder. Note:
- the chat URL,
- target ticker + timeframe.

## Step 2 — Run the importer

```bash
pnpm tsx scripts/import-strategy.ts <chat-url> --code 0XX --slug <slug>
```

The importer:
1. Scrapes Performance, Trades Analysis, and the full Trades Log.
2. Saves the raw data to `src/strategies/data/<slug>.json`.
3. Prints to stdout a ready-to-paste `StrategyConfig` block (no MAE
   yet — slPct will need refinement after Step 3).

## Step 2.5 — Backfill MAE (max adverse excursion)

```bash
pnpm tsx scripts/backfill-mae.ts <slug>
```

Fetches 5-minute Bybit klines for every trade's entry-to-exit window
and computes the worst price against the position. Saves `maePct` per
trade back into the JSON. Required for accurate SL simulation —
without MAE, the audit falls back to realized loss (under-counts).

## Step 3 — Audit + simulation

```bash
pnpm tsx scripts/audit-sl-distribution.ts <slug>
```

The auditor:
1. Reads MAE-enriched trades log.
2. Simulates net PnL at every candidate cap (3, 4, 5, 6, 7, 8, 10, 15%).
3. Picks the cap that maximises sim PnL ≤ MAX_SAFE_SL_PCT (8%).
4. Prints the full simulation table (PnL, PF, win rate, max DD,
   worst trade, stop-outs, killed-winners, saved-from-loss per cap).
5. Outputs the verdict — **COMPATIBLE**, **BORDERLINE**, or
   **INCOMPATIBLE** — plus recommended slPct.

## Step 4 — Read the verdict

| Verdict | Meaning | Action |
|---|---|---|
| ✅ **COMPATIBLE** | Sim PnL at recommended cap ≥ 80% of no-cap PnL. Cap costs little or actually helps. | Safe to enable in any tier per `minTier`. |
| ⚠ **BORDERLINE** | Sim PnL 50-80% of no-cap PnL. Cap saves from catastrophe but costs significant EV. | Acceptable. Set `minTier: 'prof'` (manual users only) until ≥ 20 live trades validate. |
| ❌ **INCOMPATIBLE** | Sim PnL ≤ 0 OR < 50% of no-cap. The cap is too tight for this strategy. | **Do NOT enable.** Find a tighter variant on LuxAlgo or skip. |

## Step 5 — Re-audit at any time

```bash
pnpm tsx scripts/audit-sl-distribution.ts                # all strategies
pnpm tsx scripts/audit-sl-distribution.ts <strategy-id>  # one
pnpm tsx scripts/audit-sl-distribution.ts --cap 10       # explore a different cap
```

Use when:
- The trades log has grown (LuxAlgo accumulated more history).
- You suspect a live-vs-backtest divergence in an existing strategy.
- You want to see whether raising the global cap would change the
  picture for a borderline strategy.

## The math (one paragraph)

For each historical trade we compute `mae = max adverse excursion %`
(worst price against the position during the trade's life, sourced
from Bybit 5-min klines). For each candidate cap, we simulate: if
`mae ≥ cap` the trade is force-closed at `−cap`; else exits at its
natural realized PnL. Sum across trades minus 0.11% commission (Bybit
taker × 2 sides) = simulated net PnL. Compare to the no-cap baseline:
ratio ≥ 80% → compatible, 50-80% → borderline, < 50% or negative →
incompatible. The recommended `slPct` is the cap that maximises net
PnL within MAX_SAFE_SL_PCT.

## Why a hard cap?

UNI#002 once sat at −10.96% unrealized P&L for several days, even
though that was statistically «inside the strategy's natural range»
(p90 MAE 17%, worst observed 24%). The visible drawdown was
psychologically unacceptable. Phase Q enforces: no enabled strategy
may have slPct > 8% (`MAX_SAFE_SL_PCT` in
`src/strategies/track-c-config.ts`). The validator runs at server
startup — a violation kills the service before it accepts a webhook.

The cap is **8%** (not 5% like Phase P) because the PnL-simulation
analysis showed that 5% caps cost too much EV on the higher-volatility
strategies: HBAR, TON, UNI, XRP all hit their best PnL at 6-8%.
Operator's stated tolerance was «до 7-8%» — 8% picked as the
ceiling.

## Files

- `src/lib/sl-distribution.ts` — analysis library
- `scripts/audit-sl-distribution.ts` — CLI auditor
- `scripts/import-strategy.ts` — LuxAlgo importer (calls the audit
  on every import)
- `src/strategies/track-c-config.ts` — `MAX_SAFE_SL_PCT` constant +
  startup validator
- `src/strategies/data/<id>.json` — raw trades log for each strategy

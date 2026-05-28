# Workflow: adding a new strategy

This is the canonical process for evaluating and adding a Track C
strategy. The hard rule (Phase P, May 28, 2026): **safety SL ≤ 5%**.
Strategies whose natural loss distribution doesn't fit the cap are
rejected at the audit stage.

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
3. Runs the SL-distribution audit on the trades log
   (`src/lib/sl-distribution.ts`).
4. Prints to stderr a verdict — **COMPATIBLE**, **BORDERLINE**, or
   **INCOMPATIBLE**.
5. Prints to stdout a ready-to-paste `StrategyConfig` block with
   `slPct` already set to the recommendation.

## Step 3 — Read the verdict

| Verdict | Meaning | Action |
|---|---|---|
| ✅ **COMPATIBLE** | p90 loss fits under 5%; cap clips ≤ 10% of historical losses. | Safe to enable. Paste the config, set `enabled: true`, deploy. |
| ⚠ **BORDERLINE** | Cap clips 10–25% of historical losses. Backtest stats won't be 1:1 in live. | Acceptable, but run a small live trial (≥ 20 trades) before promoting to paying tiers. Either keep `enabled: false` until validated, or set `minTier: 'prof'` so only manual users see it. |
| ❌ **INCOMPATIBLE** | Cap clips > 25% of historical losses — strategy needs wide SL by design. | **Do NOT enable.** Look for a tighter variant on LuxAlgo (different timeframe / different exit conditions), or skip this strategy. |

## Step 4 — Re-audit at any time

```bash
pnpm tsx scripts/audit-sl-distribution.ts                    # all strategies
pnpm tsx scripts/audit-sl-distribution.ts <strategy-id>      # one
pnpm tsx scripts/audit-sl-distribution.ts --cap 7            # explore a different cap
```

Use this when:
- The trades log has grown (LuxAlgo accumulated more history).
- You want to see whether raising the global cap would unlock more
  strategies (run with `--cap 7` or `--cap 10`).
- You suspect a live-vs-backtest divergence in an existing strategy.

## The math (one paragraph)

For each historical losing trade we compute `(exitPrice − entryPrice) /
entryPrice × sideSign`, take the absolute value (a positive %
magnitude), sort ascending, and compute percentiles. The **percentile
X** is the loss magnitude that's bigger than X% of observed losses
(`p90 = 3.7%` means «only 10% of losses were bigger than 3.7%»). The
**cut@cap** is the fraction of historical losses that would have been
force-closed by a safety SL at `cap` instead of letting the strategy
exit naturally. The recommendation is `p90 × 1.2` (rounded up to
0.5%, clamped at the global cap). Buffer factor 1.2 absorbs minor
slippage and execution noise. Compatibility verdict is purely a
function of `cut@cap` vs. the operator's tolerance threshold (default
10%).

## Why a hard cap?

UNI#002 once sat at −10.96% unrealized P&L for several days. Even
though the strategy was statistically «inside its natural range»
(p90 = 17%, worst observed = 24%), the visible drawdown was
psychologically unacceptable for both operator and subscribers.
Phase P enforces: no enabled strategy may have slPct > 5%
(`MAX_SAFE_SL_PCT` in `src/strategies/track-c-config.ts`). The
validator runs at server startup — a violation kills the service
before it can open a position.

## Files

- `src/lib/sl-distribution.ts` — analysis library
- `scripts/audit-sl-distribution.ts` — CLI auditor
- `scripts/import-strategy.ts` — LuxAlgo importer (calls the audit
  on every import)
- `src/strategies/track-c-config.ts` — `MAX_SAFE_SL_PCT` constant +
  startup validator
- `src/strategies/data/<id>.json` — raw trades log for each strategy

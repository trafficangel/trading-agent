# Funding-flip → LIVE promotion checklist

The funding-flip runner (`src/jobs/funding-flip-runner.ts`) is the one kill-battery +
placebo-verified HL edge, currently forward-validating in **HL testnet** with the
OI-build-up gate + Kelly-tilt sizing. This is the gate to promote it to **real money**.
Do NOT flip `FF_CONFIG.mode` to `'live'` until every box below is checked.

## 0. Promotion gate (don't start until this is met)
- [ ] **≥15–20 closed trades** in `funding_flip_log` (`reason='open'`, `closed_at IS NOT NULL`).
- [ ] **Net positive after cost**: `SELECT COUNT(*), ROUND(SUM(pnl_pct),2), ROUND(AVG(pnl_pct),3) FROM funding_flip_log WHERE reason='open' AND pnl_pct IS NOT NULL;` — sum > 0, avg meaningfully > 0.
- [ ] **No single-coin domination**: per-coin `SUM(pnl_pct)` — the positive result isn't one lucky coin. ETH/ADA (durable core) should carry their weight; XRP/AVAX (gate-only) are the riskier tail.
- [ ] **Gate behaving**: `⏸ OI-gate BLOCKED` lines appear in the journal (the gate is actually filtering, not passing everything) and `sizeMult` varies across opens.

## 1. Code changes REQUIRED before `mode='live'`
These are the "accepted testnet-realism" shortcuts — each MUST be fixed for real money.
- [ ] **Exit at real fill avgPx, not mid.** `stepCoin` close branch books PnL off `midBefore` (the pre-close mid). Replace with the actual close fill price from `hlFetchPosition`/order response after the close fills. Mid ≈ fill on testnet but slippage is real live.
- [ ] **Leverage read-back.** `hlSetLeverage` is fire-and-forget; confirm the effective leverage from `clearinghouseState` before sizing, so a silently-rejected setLeverage can't mis-size.
- [ ] **(Optional) Entry at the hour close, not the cron tick.** Currently enters on the */5 tick after a flip hour closes (≤~5min late). The backtest enters at close[i]. Acceptable, but tightening reduces entry slippage vs the backtest.
- [ ] **`mode='live'` currently THROWS** (`startFundingFlipRunner`). Remove the throw deliberately and gate live behind an explicit env confirmation, not just the const.

## 2. Portfolio margin budget (NEW — required by the Kelly-tilt)
The OI-tilt scales per-coin margin up to `oiSizeMax`× (currently 2.0×) the base allocation
(`capitalUsd / coins.length`). With 4 coins that's up to 4 × (base×2) = **8× base concurrent**,
which can exceed `capitalUsd` if several coins flip high-OI at once. On testnet the extra order
just rejects (harmless); **live needs a real cap.**
- [ ] Add a **portfolio margin guard**: before opening, sum the margin of all open funding-flip
      positions + the new one; skip (or shrink) if it would exceed `capitalUsd × maxPortfolioUtil` (e.g. 0.8).
- [ ] Or reduce the base allocation so `base × oiSizeMax × coins.length ≤ capitalUsd`.

## 3. Capital, leverage, risk
- [ ] **Start small** — real money. Size `capitalUsd` to what you can lose; the live track record is the brand ([[lab-edge-finding]] / CLAUDE.md: don't market until green).
- [ ] **Leverage ≤ 2** (backtest ungated maxDD ~7% at 2x; the OI-tilt RAISED pooled maxDD from −21 to −29..−39 in % terms, so concentration risk is higher — keep lev conservative or lower `oiSizeMax`).
- [ ] **Daily-loss kill-switch**: the runner is independent of `risk-control.ts`. Add a simple guard — if the day's realized funding-flip PnL < −X%, set `mode='off'` (or skip new entries) until reviewed.
- [ ] **One-position-per-coin** is already enforced; confirm no collision with any other strategy trading the same coins on the same HL account (One-Way mode).

## 4. Endpoint / account safety (mirror the testnet guard)
- [ ] Live order routing requires `HL_USE_TESTNET=false` AND a **funded mainnet** HL account with a **trade-only** API wallet (no withdraw).
- [ ] Keep the endpoint assertion (mode vs `config.HL_USE_TESTNET`) so a stale .env can't cross-route. For live: `mode='live'` must pair with `HL_USE_TESTNET=false` (the inverse of today's guard).
- [ ] Verify the API wallet has **no withdrawal** permission (same invariant as the Bybit copytrading keys).

## 5. Cutover & rollback
- [ ] Promote in one commit: `mode='live'` + capital + the fixes above. Deploy via the standard flow (validate → push from local → VPS pull/build/restart as `trader`).
- [ ] **Rollback**: set `mode='off'` (idle) or `'testnet'`, redeploy. Open live positions: let them run to the 24h time-stop, or close manually on HL, then reconcile.
- [ ] Watch the first few live entries closely (`journalctl -u trading-agent | grep funding-flip`): confirm real fills, correct sizeMult, PnL booked off real exit price.

## Quick monitoring queries
```sql
-- closed trades, net, win rate
SELECT COUNT(*) n, ROUND(SUM(pnl_pct),2) net, ROUND(AVG(pnl_pct),3) avg,
       ROUND(100.0*SUM(pnl_pct>0)/COUNT(*),0) wr
FROM funding_flip_log WHERE reason='open' AND pnl_pct IS NOT NULL;
-- per coin
SELECT coin, COUNT(*) n, ROUND(SUM(pnl_pct),2) net FROM funding_flip_log
WHERE reason='open' AND pnl_pct IS NOT NULL GROUP BY coin ORDER BY net DESC;
-- currently open
SELECT coin, side, datetime(opened_at/1000,'unixepoch') opened FROM funding_flip_pos;
```

_Research backing: [[hl-micro-layer]] (the edge + OI-gate + sizing/maker/cross-window analysis),
[[multishuffle-null-vs-single-placebo]] (why the gate/tilt are real, not artifacts)._

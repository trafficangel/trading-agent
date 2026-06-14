# CLAUDE.md — operator/agent map for Robot Claude (trading-agent)

Read this first every session. It's the map: what the project is, where things
live, how to deploy, how to audit, and the gotchas that have cost real time.

## What this is (current reality — README is stale)

**Robot Claude** (robotclaude.biz) — a crypto **copytrading SaaS** on Bybit
USDT-perps. Subscribers connect a trade-only API key; we replay our strategies
on their account. Strategies come from **LuxAlgo AI Strategy Builder** webhooks,
each validated by our own MAE/SL pipeline before it touches money. We also have
an **in-house backtest engine** (`src/backtest/`) to build/validate custom
strategies without LuxAlgo.

- Stack: Node 20 + TypeScript + Fastify + better-sqlite3.
- Prod: VPS (vdsina), systemd service **`trading-agent`**, behind Caddy, repo at
  **`/home/trader/apps/trading-agent`**, DB at `data/trading.sqlite`.
- The public "honest track record" (live PnL net of commission) is the brand.
  As of Jun 2026 the live track is **negative** — don't market until green.

## Architecture (src/)

| Dir | What |
|---|---|
| `strategies/` | **Core.** `track-c-config.ts` = STRATEGY_CONFIGS (the strategy registry). `strategy-trader.ts` = webhook → shadow decision + fan-out. `user-fanout.ts` = per-user Bybit orders. `risk-control.ts` = circuit breaker/cooldown/probation. `kelly-allocator.ts` = margin tilt. `tier-config.ts` = tiers. `live-stats.ts` = PnL (commission-net). `landing.ts`/`home.ts`/`autotrading.ts` = public site. `predict.ts` = prediction-markets track. |
| `backtest/` | In-house engine: `klines.ts` (cached fetch), `indicators.ts`, `strategy.ts` (CustomStrategy interface), `engine.ts` (bar-by-bar, native MAE), `strategies/`. |
| `user/` | Cabinet: `routes.ts`, `dashboard.ts`, `strategies.ts`, `subscription.ts`, `api-key.ts`, `tier-assignment.ts`. |
| `admin/` | `routes.ts` — /admin (users), /admin/tiers, /admin/portfolio. Basic auth. |
| `auth/` | Phone-OTP (Telegram Gateway), sessions, `crypto.ts` (AES-GCM key vault), `vip-allowlist.ts`. |
| `exchange/` | `bybit-private.ts` (orders), `bybit-public.ts` (price/qtyStep). |
| `jobs/` | Crons: `tpsl-monitor.ts`, `balance-monitor.ts`, `daily-wrap.ts`, `self-review.ts`. |
| `webhooks/` | `luxalgo.route.ts` + `luxalgo.schema.ts` (entry/exit discriminated union). |
| `lib/` | Pure helpers (no I/O, unit-tested): `pnl.ts`, `risk-rules.ts`, `kelly-math.ts`, `strategy-pnl.ts`, `slippage.ts`. |
| `db/` | `client.ts` + `migrations/` (run via `pnpm migrate`). |

## Strategy lifecycle (the pipeline)

1. **Add** a LuxAlgo strategy: `scripts/import-strategy.ts <chat-url> --code NNN --slug <id>`
   (scrapes Trades Log; needs a fresh LuxAlgo session — see gotchas).
2. **MAE**: `scripts/backfill-mae.ts <id>` (fetches Bybit klines, fills maePct+mfePct).
3. **Audit**: `scripts/audit-sl-distribution.ts <id>` → MAE distribution + optimal SL + verdict
   (COMPATIBLE / BORDERLINE / INCOMPATIBLE).
4. **Add config** to STRATEGY_CONFIGS with **`fanOut: false`** (shadow-only) + `minTier: null`.
5. After **15–20 closed shadow trades net-positive** → flip `fanOut: true` + set `minTier` + deploy.
6. **Rules:** one enabled strategy per symbol (One-Way collision); SL ≤5% standard for new
   strategies (XRP/BNB grandfathered at 8% — their MAE is wide and they're our best);
   no fixed take-profit (data showed it doesn't help the contrarian book).

Custom (non-LuxAlgo) strategies: author in `src/backtest/strategies/`, run
`scripts/backtest-custom.ts`, same audit → shadow gate.

## Risk layer (always-on, entry-path)

`risk-control.ts`, enforced in `strategy-trader.ts` (exits never blocked):
- **Circuit breaker**: 2 safety-SL hits on different symbols within 24h → block ALL entries 48h.
- **SL cooldown**: 24h (5m) / 48h (15m+) after an SL hit, per strategy.
- **Probation**: last 10 closed trades net < −5% → pause; one probe entry after 72h idle.

`kelly-allocator.ts` tilts the tier margin pool toward live-validated winners
(factor 0.4×–1.8×, MIN_SAMPLE=15, equal until data engages).

## Operator scripts (`scripts/`)

- `status.ts` — **one-glance dashboard** (run on VPS): aggregate PnL, per-strategy, risk gates, weights, open positions. **Start here for any audit.**
- `risk-status.ts` — circuit-breaker/cooldown/probation state (`--at <iso>` to replay).
- `audit-sl-distribution.ts` — per-strategy MAE + SL verdict.
- `kelly-analysis.ts` / `tp-sl-sweep.ts` / `regime-filter-backtest.ts` / `vol-gate-backtest.ts` — research analyses (read-only).
- `import-strategy.ts` / `backfill-mae.ts` / `backtest-custom.ts` — strategy onboarding.
- `announce-strategy.ts <code>` — publish a strategy to the Signals channel (**must run on VPS** — Telegram creds live there).
- `luxalgo-login.ts` — refresh the LuxAlgo scraper session (run locally, GUI).
- `migrate.ts` — apply DB migrations (`pnpm migrate`).
- Admin one-offs: `delete-user.ts`, `manual-user-entry.ts`, `debug-position.ts`, `migrate-vip-overrides.ts`, `backfill-user-pnl.ts`, `edit-entry-post.ts`, `replay-strategy-webhooks.ts`.

## Validate + deploy

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # always before deploy
./scripts/deploy.sh                                       # validate→push→VPS pull/build/restart/verify
```

Manual deploy (what deploy.sh does):
```bash
git push origin main
ssh trading-vps "cd /home/trader/apps/trading-agent && sudo -u trader git pull && sudo -u trader pnpm build && sudo systemctl restart trading-agent && sleep 3 && sudo systemctl is-active trading-agent"
```

## ⚠ Gotchas (these cost real time — read before touching ops)

1. **VPS deploy key is READ-ONLY.** VPS can `git pull` but NOT `push`. Push from
   LOCAL only. To bring a VPS-side commit back: `git fetch ssh://trading-vps/home/trader/apps/trading-agent main && git merge --ff-only FETCH_HEAD && git push`.
2. **All VPS git/build ops run as `trader`** (`sudo -u trader ...`). A build run as
   root leaves `dist/` root-owned → next build fails EACCES. Fix: `sudo chown -R trader:trader dist`.
3. **`api.bybit.com` is geo-blocked from the local/agent environment** (CloudFront).
   Any kline/MAE/backtest fetch must run **on the VPS**.
4. **`backfill-mae.ts` writes tracked data files** (`src/strategies/data/*.json`).
   Never `git stash`/`pull` on the VPS while it runs — you'll capture/lose partial
   state. Let it finish; long runs go in background with `ssh -o ServerAliveInterval=20`.
5. **`pkill -f backfill` kills your own ssh shell** (its argv contains the pattern).
   Kill by PID via `ps aux | grep '[b]ackfill'` (bracket trick) instead.
6. **Local `.env` ≠ VPS `.env`** (WEBHOOK_SECRET and Telegram creds differ). The VPS
   values are authoritative for prod. ⇒ run `announce-strategy.ts` and anything
   needing the real webhook secret / Telegram on the VPS. **Never edit `.env` without explicit instruction.**
7. **A parallel "predict" workstream commits to `main`.** Expect to rebase; resolve
   conflicts keeping the predict side in `predict.ts`/`landing.ts`. Always
   `git pull --rebase` before push.
8. **Never tighten an open position's SL** to a level already breached — instant stop-out.
   SL config changes apply to NEW entries only.

## Invariants / safety

- Commission: every live aggregate subtracts `TRACK_C_COMMISSION_RT_PCT` (0.11% round-trip).
- API keys: trade-only, no-withdraw, AES-256-GCM encrypted; decrypted only in-request.
- Authed pages set `Cache-Control: private, no-store`.
- `validateStrategyConfigs()` runs at boot; rejects enabled strategy with `slPct > MAX_SAFE_SL_PCT` (0.08).

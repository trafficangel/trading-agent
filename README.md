# Robot Claude (trading-agent)

Crypto **copytrading SaaS** on Bybit USDT-perps. Subscribers connect a
trade-only API key; we replay validated strategies on their account.
Strategies come from LuxAlgo AI Strategy Builder webhooks (each passed through
our own MAE/SL validation) plus an in-house backtest engine for custom
strategies. Auth via Telegram phone-OTP; public site at robotclaude.biz.

> **Agents/operators: read [CLAUDE.md](CLAUDE.md) first** — it's the live map
> (architecture, strategy lifecycle, risk layer, operator scripts, deploy
> procedure, and the gotchas).

## Commands

```bash
pnpm dev                  # local dev server
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # validate
pnpm migrate              # apply DB migrations
pnpm status               # one-glance operator dashboard (run on VPS)
pnpm risk                 # circuit-breaker / cooldown / probation state
pnpm deploy "msg"         # validate → push → VPS pull/build/restart/verify
```

## Stack & layout

Node 20 · TypeScript · Fastify · better-sqlite3. Prod on a VPS (systemd
`trading-agent`, behind Caddy). Source map and per-directory responsibilities
are in [CLAUDE.md](CLAUDE.md). Deep docs in [`docs/`](docs/) (tiers, strategy
workflow, Bybit setup, deployment, consensus-engine spec).

## Strategy pipeline (short)

import (LuxAlgo) → backfill MAE → audit (SL verdict) → add to `STRATEGY_CONFIGS`
with `fanOut:false` (shadow-only) → 15–20 net-positive shadow trades →
`fanOut:true`. Risk layer (circuit breaker / cooldown / probation) guards all
entries. See [docs/strategy-workflow.md](docs/strategy-workflow.md).

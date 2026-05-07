# trading-agent

LuxAlgo (TradingView) → Confluence → Claude vision → Bybit USDT-perp → Telegram.

## Stages

- **Stage 1 — Telemetry only** *(current)*: webhook receiver + SQLite + Telegram (raw to Logs, summaries to Signals). No LLM, no orders.
- Stage 2 — Confluence + LLM in shadow mode (Claude decides, no orders).
- Stage 3 — Paper trading on Bybit testnet.
- Stage 4 — Semi-auto on mainnet (manual Approve in Telegram).
- Stage 5 — Full auto.

## Quick start (local dev)

```bash
pnpm install
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_*, WEBHOOK_SECRET
pnpm migrate
pnpm dev
# in another shell:
curl -X POST http://localhost:3000/webhook/luxalgo/$WEBHOOK_SECRET \
  -H 'Content-Type: application/json' \
  -d @tests/fixtures/sample-signal.json
```

## TradingView alerts

See [docs/tradingview-alerts.md](docs/tradingview-alerts.md) for the full alert list and copy-paste JSON message templates.

## Deployment

Production runs on a Hetzner-class VPS behind Caddy. See [docs/deployment.md](docs/deployment.md).

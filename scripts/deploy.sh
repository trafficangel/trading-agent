#!/usr/bin/env bash
# Deploy trading-agent to the VPS — the ONE correct sequence.
#
#   validate (typecheck/lint/test/build) → push origin (local has push rights;
#   the VPS deploy key is READ-ONLY) → VPS pull+build+restart AS trader →
#   health check.
#
# Usage: ./scripts/deploy.sh ["commit message"]
#   - with a message: stages all, commits, then deploys.
#   - without: assumes you've already committed; just pushes + deploys.
#
# Gotchas baked in: build runs as `trader` (root-owned dist → EACCES);
# rebase before push (parallel predict workstream); push from local only.
set -euo pipefail

VPS=trading-vps
APP=/home/trader/apps/trading-agent
MSG="${1:-}"

echo "▶ validating…"
pnpm typecheck
pnpm lint
pnpm test
pnpm build

if [[ -n "$MSG" ]]; then
  git add -A
  git commit -m "$MSG"
fi

echo "▶ syncing with origin…"
git pull --rebase origin main
git push origin main

echo "▶ deploying on VPS (as trader)…"
ssh -o ServerAliveInterval=20 "$VPS" "cd $APP \
  && sudo -u trader git pull \
  && sudo -u trader pnpm build \
  && sudo -u trader pnpm migrate \
  && sudo systemctl restart trading-agent \
  && sleep 3 \
  && echo -n 'service: ' && sudo systemctl is-active trading-agent"

echo "▶ post-deploy errors (last 1 min):"
ssh "$VPS" "sudo journalctl -u trading-agent --since '1 min ago' --no-pager | grep -ciE 'error|fatal' || true"
echo "✅ deploy done"

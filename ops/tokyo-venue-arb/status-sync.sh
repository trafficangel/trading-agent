#!/usr/bin/env bash
set -euo pipefail

source_dir=/home/trader/apps/venue-arb-tokyo/data/candidate-routes
destination=trader@144.124.250.47:/home/trader/apps/trading-agent/data/venue-arb/
sync_key=/home/trader/.ssh/status_sync
ssh_args="ssh -i ${sync_key} -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 -o ControlMaster=auto -o ControlPersist=60 -o ControlPath=/home/trader/.ssh/venue-arb-sync-%C"

while true; do
  files=()
  for name in live-status.json live-trades.json; do
    [[ -f "${source_dir}/${name}" ]] && files+=("${source_dir}/${name}")
  done
  if ((${#files[@]})); then
    rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
      "${files[@]}" "$destination"
  fi
  sleep 1
done

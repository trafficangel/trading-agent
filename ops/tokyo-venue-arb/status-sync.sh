#!/usr/bin/env bash
set -euo pipefail

source_dir=/home/trader/apps/venue-arb-tokyo/data/candidate-routes
target_dir=/home/trader/apps/venue-arb-tokyo/data/pacifica-extended-shadow
extended_lighter_dir=/home/trader/apps/venue-arb-tokyo/data/extended-lighter-shadow
destination=trader@144.124.250.47:/home/trader/apps/trading-agent/data/venue-arb/
sync_key=/home/trader/.ssh/status_sync
ssh_args="ssh -i ${sync_key} -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=10 -o ControlMaster=auto -o ControlPersist=60 -o ControlPath=/home/trader/.ssh/venue-arb-sync-%C"

while true; do
  files=()
  for name in status.json execution-status.json live-status.json live-trades.json; do
    [[ -f "${source_dir}/${name}" ]] && files+=("${source_dir}/${name}")
  done
  if ((${#files[@]})); then
    rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
      "${files[@]}" "$destination"
  fi
  [[ -f "${target_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${target_dir}/status.json" "${destination}pacifica-extended-status.json"
  [[ -f "${target_dir}/gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${target_dir}/gate-status.json" "${destination}pacifica-extended-gate-status.json"
  [[ -f "${target_dir}/extended-pacifica-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${target_dir}/extended-pacifica-maker-gate-status.json" "${destination}extended-pacifica-maker-gate-status.json"
  [[ -f "${extended_lighter_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${extended_lighter_dir}/status.json" "${destination}extended-lighter-status.json"
  [[ -f "${extended_lighter_dir}/extended-lighter-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${extended_lighter_dir}/extended-lighter-maker-gate-status.json" "${destination}extended-lighter-maker-gate-status.json"
  sleep 1
done

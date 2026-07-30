#!/usr/bin/env bash
set -euo pipefail

source_dir=/home/trader/apps/venue-arb-tokyo/data/candidate-routes
candidate_dir=/home/trader/apps/venue-arb-tokyo/data/extended-lighter-shadow
aster_dir=/home/trader/apps/venue-arb-tokyo/data/binance-bybit-shadow
hibachi_dir=/home/trader/apps/venue-arb-tokyo/data/hibachi-lighter-shadow
coinbase_dir=/home/trader/apps/venue-arb-tokyo/data/coinbase-lighter-shadow
ethereal_dir=/home/trader/apps/venue-arb-tokyo/data/ethereal-lighter-shadow
hotstuff_dir=/home/trader/apps/venue-arb-tokyo/data/hotstuff-lighter-shadow
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
  [[ -f "${candidate_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${candidate_dir}/status.json" "${destination}cex-dex-status.json"
  [[ -f "${aster_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${aster_dir}/status.json" "${destination}aster-lighter-status.json"
  [[ -f "${hibachi_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${hibachi_dir}/status.json" "${destination}hibachi-lighter-status.json"
  [[ -f "${coinbase_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${coinbase_dir}/status.json" "${destination}coinbase-lighter-status.json"
  [[ -f "${ethereal_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${ethereal_dir}/status.json" "${destination}ethereal-lighter-status.json"
  [[ -f "${hotstuff_dir}/status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${hotstuff_dir}/status.json" "${destination}hotstuff-lighter-status.json"
  for gate_file in \
    extended-lighter-maker-gate-status.json \
    extended-lighter-taker-gate-status.json \
    lighter-extended-taker-gate-status.json \
    grvt-lighter-maker-gate-status.json; do
    [[ -f "${candidate_dir}/${gate_file}" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
      "${candidate_dir}/${gate_file}" "${destination}${gate_file}"
  done
  [[ -f "${aster_dir}/aster-lighter-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${aster_dir}/aster-lighter-maker-gate-status.json" "${destination}aster-lighter-maker-gate-status.json"
  [[ -f "${hibachi_dir}/hibachi-lighter-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${hibachi_dir}/hibachi-lighter-maker-gate-status.json" "${destination}hibachi-lighter-maker-gate-status.json"
  [[ -f "${hibachi_dir}/hibachi-lighter-capacity-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${hibachi_dir}/hibachi-lighter-capacity-gate-status.json" "${destination}hibachi-lighter-capacity-gate-status.json"
  [[ -f "${coinbase_dir}/coinbase-lighter-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${coinbase_dir}/coinbase-lighter-maker-gate-status.json" "${destination}coinbase-lighter-maker-gate-status.json"
  [[ -f "${ethereal_dir}/ethereal-lighter-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${ethereal_dir}/ethereal-lighter-maker-gate-status.json" "${destination}ethereal-lighter-maker-gate-status.json"
  [[ -f "${hotstuff_dir}/hotstuff-lighter-maker-gate-status.json" ]] && rsync -az --timeout=5 --chmod=F600 -e "$ssh_args" \
    "${hotstuff_dir}/hotstuff-lighter-maker-gate-status.json" "${destination}hotstuff-lighter-maker-gate-status.json"
  sleep 1
done

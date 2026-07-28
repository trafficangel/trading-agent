#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

destination="/etc/trading-agent/extended-arb.env"
install -d -o root -g trader -m 0750 "$(dirname "$destination")"

read -r -s -p "Extended API Key: " api_key
printf '\n'
read -r -s -p "Extended Private Stark Key: " stark_private_key
printf '\n'
read -r -p "Extended Vault Number: " vault_number

if [[ -z "$api_key" || -z "$stark_private_key" || -z "$vault_number" ]]; then
  printf 'Ошибка: все три значения обязательны.\n' >&2
  exit 1
fi
if [[ ! "$vault_number" =~ ^[0-9]+$ ]]; then
  printf 'Ошибка: Vault Number должен содержать только цифры.\n' >&2
  exit 1
fi

umask 077
temporary="$(mktemp /etc/trading-agent/.extended-arb.env.XXXXXX)"
trap 'rm -f "$temporary"' EXIT
printf '%s\n' \
  "EXTENDED_API_KEY=$api_key" \
  "EXTENDED_STARK_PRIVATE_KEY=$stark_private_key" \
  "EXTENDED_VAULT_NUMBER=$vault_number" \
  "EXTENDED_BASE_URL=https://api.starknet.extended.exchange/api/v1" \
  > "$temporary"
install -o root -g trader -m 0640 "$temporary" "$destination"

unset api_key stark_private_key vault_number
printf 'Готово: данные сохранены в %s (root:trader, 0640).\n' "$destination"

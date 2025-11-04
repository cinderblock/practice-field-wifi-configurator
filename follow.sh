#!/bin/bash

# Follow journalctl logs for the two related services.
# Usage:
#   ./follow.sh           # follow both (interleaved)
#   ./follow.sh -w        # wifi-configurator only
#   ./follow.sh -m        # management-system only
#   ./follow.sh -h        # help

set -euo pipefail

WIFI_SERVICE="practice-field-wifi-configurator.service"
MGMT_SERVICE="practice-field-management-system.service"

show_help() {
  echo "Usage: $0 [-w|-m]"
  echo
  echo "  No flags  Follow both services"
  echo "  -w        Follow $WIFI_SERVICE only"
  echo "  -m        Follow $MGMT_SERVICE only"
  echo "  -h        Show this help"
}

want_wifi=false
want_mgmt=false

while getopts ":wmh" opt; do
  case "$opt" in
    w) want_wifi=true ;;
    m) want_mgmt=true ;;
    h) show_help; exit 0 ;;
    :) echo "Error: -$OPTARG requires an argument" >&2; exit 2 ;;
    \?) echo "Error: Invalid option -$OPTARG" >&2; show_help; exit 2 ;;
  esac
done

# Default to both if none specified
if ! $want_wifi && ! $want_mgmt; then
  want_wifi=true
  want_mgmt=true
fi

# Build a single journalctl command with multiple -u arguments
services=()
$want_wifi && services+=("$WIFI_SERVICE")
$want_mgmt && services+=("$MGMT_SERVICE")

if [ ${#services[@]} -eq 0 ]; then
  echo "No services selected" >&2
  exit 2
fi

printf "===== journalctl -f for: %s =====\n" "${services[*]}" >&2

args=( -f -n 50 --output=short-iso )
for svc in "${services[@]}"; do
  args+=( -u "$svc" )
done

# Run a single invocation; caller may prefix with sudo if needed
exec journalctl "${args[@]}"

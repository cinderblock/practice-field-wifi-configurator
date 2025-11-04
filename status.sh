#!/bin/bash

# Show systemd status for the two related services.
# Usage:
#   ./status.sh           # show both
#   ./status.sh -w        # wifi-configurator only
#   ./status.sh -m        # management-system only
#   ./status.sh -h        # help

set -euo pipefail

WIFI_SERVICE="practice-field-wifi-configurator.service"
MGMT_SERVICE="practice-field-management-system.service"

show_help() {
  echo "Usage: $0 [-w|-m]"
  echo
  echo "  No flags  Show both services"
  echo "  -w        Show $WIFI_SERVICE only"
  echo "  -m        Show $MGMT_SERVICE only"
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

show_status() {
  local svc="$1"
  echo "===== systemctl status: $svc ====="
  if sudo systemctl list-units --type=service --all | grep -q "^\s*${svc}\s"; then
    sudo systemctl --no-pager --full status "$svc" || true
  else
    echo "Service $svc not found (skipping)"
  fi
  echo
}

$want_wifi && show_status "$WIFI_SERVICE"
$want_mgmt && show_status "$MGMT_SERVICE"

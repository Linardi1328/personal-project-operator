#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="ppo-openclaw.service"
REQUIRED_CONFIRMATION="systemd-service-control"

fail() {
  printf 'Phase 4A service control failed: %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run as root on the target Ubuntu VPS."
  fi
}

require_mutation_confirmation() {
  if [[ "${PPO_SERVICE_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
    printf 'Refusing mutating service action without explicit owner confirmation.\n' >&2
    printf 'Run on the VPS only with: PPO_SERVICE_CONFIRM=%s %s %s\n' "$REQUIRED_CONFIRMATION" "$0" "$1" >&2
    exit 2
  fi
}

action="${1:-}"

case "$action" in
  status)
    systemctl status --no-pager "$SERVICE_NAME"
    ;;
  logs)
    journalctl -u "$SERVICE_NAME" -n 120 --no-pager
    ;;
  start|restart|stop|enable|disable)
    require_root
    require_mutation_confirmation "$action"
    systemctl "$action" "$SERVICE_NAME"
    ;;
  *)
    printf 'Usage: %s {status|logs|start|restart|stop|enable|disable}\n' "$0" >&2
    exit 2
    ;;
esac

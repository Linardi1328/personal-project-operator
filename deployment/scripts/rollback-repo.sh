#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
SERVICE_NAME="ppo-openclaw.service"
REQUIRED_CONFIRMATION="rollback-last-good"

fail() {
  printf 'Phase 4A rollback failed: %s\n' "$1" >&2
  exit 1
}

require_confirmation() {
  if [[ "${PPO_ROLLBACK_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
    printf 'Refusing rollback without explicit owner confirmation.\n' >&2
    printf 'Run on the VPS only with: PPO_ROLLBACK_CONFIRM=%s %s\n' "$REQUIRED_CONFIRMATION" "$0" >&2
    exit 2
  fi
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run as root on the target Ubuntu VPS."
  fi
}

main() {
  require_confirmation
  require_root

  [[ -d "${INSTALL_DIR}/.git" ]] || fail "repo checkout is missing at ${INSTALL_DIR}."
  [[ -f "${STATE_DIR}/last-good-revision" ]] || fail "last-good revision file is missing."

  local revision
  revision="$(tr -d '\n\r' <"${STATE_DIR}/last-good-revision")"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "last-good revision is malformed."

  git -C "$INSTALL_DIR" switch --detach "$revision"
  chown -R root:root "$INSTALL_DIR"
  find "$INSTALL_DIR" -type d -exec chmod 0755 {} +
  find "$INSTALL_DIR" -type f -exec chmod 0644 {} +
  find "${INSTALL_DIR}/deployment/scripts" -type f -name '*.sh' -exec chmod 0755 {} +
  find "${INSTALL_DIR}/deployment/scripts" -type f -name '*.mjs' -exec chmod 0755 {} +
  find "${INSTALL_DIR}/local-operator" -maxdepth 1 -type f -name '*.mjs' -exec chmod 0755 {} +
  systemctl restart "$SERVICE_NAME"
  printf 'Rolled back PPO checkout to last-good revision and restarted %s.\n' "$SERVICE_NAME"
}

main "$@"

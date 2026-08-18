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
  lock_runtime_checkout_permissions
  systemctl restart "$SERVICE_NAME"
  printf 'Rolled back PPO checkout to last-good revision and restarted %s.\n' "$SERVICE_NAME"
}

lock_runtime_checkout_permissions() {
  chown -R root:root "$INSTALL_DIR"
  find "$INSTALL_DIR" -type d -exec chmod 0755 {} +
  find "$INSTALL_DIR" -type f -exec chmod 0644 {} +

  local entry mode path
  while IFS= read -r -d '' entry; do
    mode="${entry%% *}"
    path="${entry#*$'\t'}"

    case "$mode" in
      100644)
        chmod 0644 "${INSTALL_DIR}/${path}"
        ;;
      100755)
        chmod 0755 "${INSTALL_DIR}/${path}"
        ;;
    esac
  done < <(git -C "$INSTALL_DIR" ls-files -z -s)
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

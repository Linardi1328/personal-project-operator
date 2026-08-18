#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
BRANCH="main"
REQUIRED_CONFIRMATION="install-or-update-main"

fail() {
  printf 'Phase 4A repo update failed: %s\n' "$1" >&2
  exit 1
}

require_confirmation() {
  if [[ "${PPO_REPO_UPDATE_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
    printf 'Refusing to install/update without explicit owner confirmation.\n' >&2
    printf 'Run on the VPS only with: PPO_REPO_UPDATE_CONFIRM=%s %s\n' "$REQUIRED_CONFIRMATION" "$0" >&2
    exit 2
  fi
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run as root on the target Ubuntu VPS."
  fi
}

require_service_user() {
  id "$SERVICE_USER" >/dev/null 2>&1 || fail "service user '${SERVICE_USER}' does not exist; run bootstrap first."
  getent group "$SERVICE_GROUP" >/dev/null || fail "service group '${SERVICE_GROUP}' does not exist; run bootstrap first."
}

record_last_good_revision() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    local revision
    revision="$(sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" rev-parse HEAD)"
    if [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
      install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
      printf '%s\n' "$revision" >"${STATE_DIR}/last-good-revision"
      chown "$SERVICE_USER:$SERVICE_GROUP" "${STATE_DIR}/last-good-revision"
      chmod 0640 "${STATE_DIR}/last-good-revision"
    fi
  fi
}

clone_or_update() {
  install -d -m 0755 "$INSTALL_DIR"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"

  if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
    rmdir "$INSTALL_DIR" 2>/dev/null || true
    sudo -u "$SERVICE_USER" git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
    return
  fi

  record_last_good_revision
  sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" fetch --prune origin "$BRANCH"
  sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" checkout "$BRANCH"
  sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
}

main() {
  require_confirmation
  require_root
  require_service_user
  clone_or_update

  printf 'Phase 4A repo install/update completed for %s.\n' "$INSTALL_DIR"
  printf 'Review changes, then use service-control.sh for explicit start or restart.\n'
}

main "$@"

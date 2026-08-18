#!/usr/bin/env bash
set -Eeuo pipefail

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
  getent group "$SERVICE_GROUP" >/dev/null || fail "service group '${SERVICE_GROUP}' does not exist; run bootstrap first."
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

record_last_good_revision() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    local revision
    revision="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    if [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
      install -d -m 0750 -o root -g "$SERVICE_GROUP" "$STATE_DIR"
      printf '%s\n' "$revision" >"${STATE_DIR}/last-good-revision"
      chown root:"$SERVICE_GROUP" "${STATE_DIR}/last-good-revision"
      chmod 0640 "${STATE_DIR}/last-good-revision"
    fi
  fi
}

clone_or_update() {
  install -d -m 0755 -o root -g root "$INSTALL_DIR"

  if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
    rmdir "$INSTALL_DIR" 2>/dev/null || true
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
    lock_runtime_checkout_permissions
    return
  fi

  record_last_good_revision
  git -C "$INSTALL_DIR" fetch --prune origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
  lock_runtime_checkout_permissions
}

main() {
  require_confirmation
  require_root
  require_service_user
  clone_or_update

  printf 'Phase 4A repo install/update completed for %s.\n' "$INSTALL_DIR"
  printf 'Review changes, then use service-control.sh for explicit start or restart.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

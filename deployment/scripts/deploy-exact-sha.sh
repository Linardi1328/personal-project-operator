#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
REMOTE_NAME="origin"
MAIN_BRANCH="main"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
SERVICE_NAME="ppo-openclaw.service"
SERVICE_CONFIRMATION="systemd-service-control"
PREFLIGHT_SCRIPT="${INSTALL_DIR}/deployment/scripts/preflight-openclaw-runtime.sh"
SERVICE_CONTROL_SCRIPT="${INSTALL_DIR}/deployment/scripts/service-control.sh"
EXPECTED_SHA="${1:-}"

fail() {
  printf 'Phase 6H exact-SHA deployment failed: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "run as root on the target Ubuntu VPS."
}

require_service_identity() {
  id "$SERVICE_USER" >/dev/null 2>&1 || fail "service user '${SERVICE_USER}' does not exist; run bootstrap first."
  getent group "$SERVICE_GROUP" >/dev/null 2>&1 || fail "service group '${SERVICE_GROUP}' does not exist; run bootstrap first."
}

require_exact_sha() {
  [[ "$#" -eq 1 ]] || fail "expected exactly one deployment SHA."
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "deployment SHA is malformed."
}

verify_checkout_identity() {
  [[ -d "${INSTALL_DIR}/.git" ]] || fail "repo checkout is missing at ${INSTALL_DIR}."

  local remote_url
  remote_url="$(git -C "$INSTALL_DIR" remote get-url "$REMOTE_NAME")"
  [[ "$remote_url" == "$REPO_URL" ]] || fail "repo origin does not match the approved PPO repository."
}

lock_runtime_checkout_permissions() {
  find "$INSTALL_DIR" -type d -exec chmod 0755 {} +
  find "$INSTALL_DIR" -type f -exec chmod 0644 {} +

  while IFS= read -r tracked_file; do
    [[ -n "$tracked_file" ]] || continue
    [[ -f "${INSTALL_DIR}/${tracked_file}" ]] || continue
    chmod 0755 "${INSTALL_DIR}/${tracked_file}"
  done < <(git -C "$INSTALL_DIR" ls-files -s | awk '$1 == "100755" {print $4}')

  chown -R root:"$SERVICE_GROUP" "$INSTALL_DIR"
  chmod 0755 "$INSTALL_DIR"
}

record_previous_revision() {
  install -d -m 0750 -o root -g "$SERVICE_GROUP" "$STATE_DIR"

  local previous_sha
  if previous_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD 2>/dev/null)"; then
    [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || return 0
    printf '%s\n' "$previous_sha" > "${STATE_DIR}/last-deploy-previous-revision"
    chown root:"$SERVICE_GROUP" "${STATE_DIR}/last-deploy-previous-revision"
    chmod 0640 "${STATE_DIR}/last-deploy-previous-revision"
  fi
}

verify_expected_commit() {
  git -C "$INSTALL_DIR" fetch --prune "$REMOTE_NAME" "${MAIN_BRANCH}:refs/remotes/${REMOTE_NAME}/${MAIN_BRANCH}"
  git -C "$INSTALL_DIR" cat-file -e "${EXPECTED_SHA}^{commit}"
  git -C "$INSTALL_DIR" merge-base --is-ancestor "$EXPECTED_SHA" "${REMOTE_NAME}/${MAIN_BRANCH}"
}

deploy_exact_sha() {
  record_previous_revision
  git -C "$INSTALL_DIR" switch --detach "$EXPECTED_SHA"
  lock_runtime_checkout_permissions
  sudo -u "$SERVICE_USER" "$PREFLIGHT_SCRIPT"
  env PPO_SERVICE_CONFIRM="$SERVICE_CONFIRMATION" "$SERVICE_CONTROL_SCRIPT" restart

  local deployed_sha
  deployed_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD)"
  [[ "$deployed_sha" == "$EXPECTED_SHA" ]] || fail "deployment checkout HEAD does not equal expected SHA."
}

main() {
  require_exact_sha "$@"
  require_root
  require_service_identity
  verify_checkout_identity
  verify_expected_commit
  deploy_exact_sha
  printf 'Phase 6H exact-SHA deployment completed.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

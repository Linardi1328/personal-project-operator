#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
REMOTE_NAME="origin"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
SERVICE_NAME="ppo-openclaw.service"
SERVICE_CONFIRMATION="systemd-service-control"
PREFLIGHT_SCRIPT="${INSTALL_DIR}/deployment/scripts/preflight-openclaw-runtime.sh"
SERVICE_CONTROL_SCRIPT="${INSTALL_DIR}/deployment/scripts/service-control.sh"
EXPECTED_DEPLOYMENT_SHA="${1:-}"
ROLLBACK_SHA="${2:-}"

observed_checkout_sha=""
service_enabled=false
service_active=false
service_running=false
service_main_pid_nonzero=false
repository="not_run"
current_checkout="not_run"
detached="not_run"
clean="not_run"
previous_revision="not_run"
rollback_commit="not_run"
checkout_switch="not_run"
permission_contract="not_run"
runtime_preflight="not_run"
service_restart="not_run"
postrollback_checkout="not_run"
rollback_invoked=false

emit_result() {
  local ok="$1"
  local failure_class="$2"

  printf '{"schemaVersion":1,"ok":%s,"failureClass":"%s","observedCheckoutSha":"%s","serviceName":"%s","serviceEnabled":%s,"serviceActive":%s,"serviceRunning":%s,"serviceMainPidNonZero":%s,"repository":"%s","currentCheckout":"%s","detached":"%s","clean":"%s","previousRevision":"%s","rollbackCommit":"%s","checkoutSwitch":"%s","permissionContract":"%s","runtimePreflight":"%s","serviceRestart":"%s","postrollbackCheckout":"%s","rollbackInvoked":%s,"deploymentInvoked":false,"githubWriteInvoked":false,"modelInvoked":false,"routeInvoked":false,"networkRefreshInvoked":false,"legacyRollbackInvoked":false}\n' \
    "$ok" \
    "$failure_class" \
    "$observed_checkout_sha" \
    "$SERVICE_NAME" \
    "$service_enabled" \
    "$service_active" \
    "$service_running" \
    "$service_main_pid_nonzero" \
    "$repository" \
    "$current_checkout" \
    "$detached" \
    "$clean" \
    "$previous_revision" \
    "$rollback_commit" \
    "$checkout_switch" \
    "$permission_contract" \
    "$runtime_preflight" \
    "$service_restart" \
    "$postrollback_checkout" \
    "$rollback_invoked"
}

fail_result() {
  emit_result false "$1"
  exit 0
}

valid_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

read_first_line() {
  local path="$1"
  local value
  IFS= read -r value <"$path" || return 1
  printf '%s\n' "$value"
}

require_exact_inputs() {
  [[ "$#" -eq 2 ]] || fail_result "invalid_rollback_inputs"
  valid_sha "$EXPECTED_DEPLOYMENT_SHA" || fail_result "malformed_deployment_sha"
  valid_sha "$ROLLBACK_SHA" || fail_result "malformed_rollback_sha"
  [[ "$EXPECTED_DEPLOYMENT_SHA" != "$ROLLBACK_SHA" ]] || fail_result "rollback_sha_matches_deployment"
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail_result "root_required"
}

require_service_identity() {
  id "$SERVICE_USER" >/dev/null 2>&1 || fail_result "service_identity_failed"
  getent group "$SERVICE_GROUP" >/dev/null 2>&1 || fail_result "service_identity_failed"
}

lock_runtime_checkout_permissions() {
  local executable_files tracked_file

  find "$INSTALL_DIR" -type d -exec chmod 0755 {} + || return 1
  find "$INSTALL_DIR" -type f -exec chmod 0644 {} + || return 1

  executable_files="$(git -C "$INSTALL_DIR" ls-files -s | awk '$1 == "100755" {print $4}')" || return 1
  while IFS= read -r tracked_file; do
    [[ -n "$tracked_file" ]] || continue
    [[ -f "${INSTALL_DIR}/${tracked_file}" ]] || continue
    chmod 0755 "${INSTALL_DIR}/${tracked_file}" || return 1
  done <<<"$executable_files"

  chown -R root:"$SERVICE_GROUP" "$INSTALL_DIR" || return 1
  chmod 0755 "$INSTALL_DIR" || return 1
}

validate_repository_and_current_checkout() {
  local remote_url

  [[ -d "${INSTALL_DIR}/.git" ]] || fail_result "repository_identity_failed"
  remote_url="$(git -C "$INSTALL_DIR" remote get-url "$REMOTE_NAME" 2>/dev/null)" ||
    fail_result "repository_identity_failed"
  [[ "$remote_url" == "$REPO_URL" ]] || fail_result "repository_identity_failed"
  repository="passed"

  observed_checkout_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD 2>/dev/null)" ||
    fail_result "current_checkout_missing"
  valid_sha "$observed_checkout_sha" || fail_result "current_checkout_missing"
  [[ "$observed_checkout_sha" == "$EXPECTED_DEPLOYMENT_SHA" ]] ||
    fail_result "current_checkout_mismatch"
  current_checkout="passed"

  if git -C "$INSTALL_DIR" symbolic-ref -q HEAD >/dev/null 2>&1; then
    fail_result "checkout_not_detached"
  fi
  detached="passed"

  [[ -z "$(git --no-optional-locks -C "$INSTALL_DIR" -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames 2>/dev/null)" ]] ||
    fail_result "dirty_checkout"
  clean="passed"
}

validate_previous_revision_marker() {
  local marker_path="${STATE_DIR}/last-deploy-previous-revision"
  local marker_value

  [[ -f "$marker_path" ]] || fail_result "previous_revision_mismatch"
  marker_value="$(read_first_line "$marker_path")" || fail_result "previous_revision_mismatch"
  [[ "$marker_value" == "$ROLLBACK_SHA" ]] || fail_result "previous_revision_mismatch"
  previous_revision="passed"
}

validate_rollback_commit() {
  git -C "$INSTALL_DIR" rev-parse --verify --quiet "${ROLLBACK_SHA}^{commit}" >/dev/null ||
    fail_result "rollback_commit_missing"
  rollback_commit="passed"
}

switch_to_rollback() {
  rollback_invoked=true
  git -C "$INSTALL_DIR" switch --detach "$ROLLBACK_SHA" >/dev/null 2>&1 ||
    fail_result "checkout_switch_failed"
  observed_checkout_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  checkout_switch="passed"
}

restore_permissions() {
  lock_runtime_checkout_permissions || fail_result "permission_contract_failed"
  permission_contract="passed"
}

run_runtime_preflight() {
  sudo -u "$SERVICE_USER" "$PREFLIGHT_SCRIPT" >/dev/null 2>&1 ||
    fail_result "runtime_preflight_failed"
  runtime_preflight="passed"
}

restart_fixed_service() {
  env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" PPO_SERVICE_CONFIRM="$SERVICE_CONFIRMATION" "$SERVICE_CONTROL_SCRIPT" restart >/dev/null 2>&1 ||
    fail_result "service_restart_failed"
  service_restart="passed"
}

verify_postrollback_checkout() {
  observed_checkout_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD 2>/dev/null)" ||
    fail_result "postrollback_checkout_mismatch"
  valid_sha "$observed_checkout_sha" || fail_result "postrollback_checkout_mismatch"
  [[ "$observed_checkout_sha" == "$ROLLBACK_SHA" ]] || fail_result "postrollback_checkout_mismatch"

  if git -C "$INSTALL_DIR" symbolic-ref -q HEAD >/dev/null 2>&1; then
    fail_result "postrollback_checkout_mismatch"
  fi
  postrollback_checkout="passed"
}

verify_service_running() {
  local sub_state main_pid

  if systemctl is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_enabled=true
  fi

  if systemctl is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_active=true
  else
    fail_result "service_not_running"
  fi

  sub_state="$(systemctl show "$SERVICE_NAME" --property=SubState --value 2>/dev/null)" ||
    fail_result "service_not_running"
  [[ "$sub_state" == "running" ]] || fail_result "service_not_running"
  service_running=true

  main_pid="$(systemctl show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null)" ||
    fail_result "service_not_running"
  [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" != "0" ]] || fail_result "service_not_running"
  service_main_pid_nonzero=true
}

main() {
  require_exact_inputs "$@"
  require_root
  require_service_identity
  validate_repository_and_current_checkout
  validate_previous_revision_marker
  validate_rollback_commit
  switch_to_rollback
  restore_permissions
  run_runtime_preflight
  restart_fixed_service
  verify_postrollback_checkout
  verify_service_running
  emit_result true "none"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
REMOTE_NAME="origin"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
SERVICE_NAME="ppo-openclaw.service"
PREFLIGHT_SCRIPT="${INSTALL_DIR}/deployment/scripts/preflight-openclaw-runtime.sh"
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
checkout_switch="not_applicable"
permission_contract="not_run"
runtime_preflight="not_run"
service_restart="not_applicable"
postrollback_checkout="not_run"

emit_result() {
  local ok="$1"
  local failure_class="$2"

  printf '{"schemaVersion":1,"ok":%s,"failureClass":"%s","observedCheckoutSha":"%s","serviceName":"%s","serviceEnabled":%s,"serviceActive":%s,"serviceRunning":%s,"serviceMainPidNonZero":%s,"repository":"%s","currentCheckout":"%s","detached":"%s","clean":"%s","previousRevision":"%s","rollbackCommit":"%s","checkoutSwitch":"%s","permissionContract":"%s","runtimePreflight":"%s","serviceRestart":"%s","postrollbackCheckout":"%s","rollbackInvoked":false,"deploymentInvoked":false,"githubWriteInvoked":false,"modelInvoked":false,"routeInvoked":false,"networkRefreshInvoked":false,"legacyRollbackInvoked":false}\n' \
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
    "$postrollback_checkout"
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

path_contract() {
  local path="$1"
  local expected_user="$2"
  local expected_group="$3"
  local expected_mode="$4"
  local actual_user actual_group actual_mode

  [[ -e "$path" ]] || return 1
  read -r actual_user actual_group actual_mode < <(stat -c '%U %G %a' "$path" 2>/dev/null) || return 1
  [[ "$actual_user" == "$expected_user" && "$actual_group" == "$expected_group" && "$actual_mode" == "$expected_mode" ]]
}

check_repository() {
  local remote_url

  [[ -d "${INSTALL_DIR}/.git" ]] || return 0
  remote_url="$(git -C "$INSTALL_DIR" remote get-url "$REMOTE_NAME" 2>/dev/null)" || return 0
  [[ "$remote_url" == "$REPO_URL" ]] || return 0
  repository="passed"
}

check_checkout() {
  observed_checkout_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  valid_sha "$observed_checkout_sha" || return 0

  if [[ "$observed_checkout_sha" == "$EXPECTED_DEPLOYMENT_SHA" ]]; then
    current_checkout="passed"
  else
    current_checkout="failed"
  fi

  if [[ "$observed_checkout_sha" == "$ROLLBACK_SHA" ]]; then
    postrollback_checkout="passed"
  else
    postrollback_checkout="failed"
  fi

  if git -C "$INSTALL_DIR" symbolic-ref -q HEAD >/dev/null 2>&1; then
    detached="failed"
  else
    detached="passed"
  fi

  if [[ -z "$(git --no-optional-locks -C "$INSTALL_DIR" -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames 2>/dev/null)" ]]; then
    clean="passed"
  else
    clean="failed"
  fi
}

check_previous_revision_marker() {
  local marker_path="${STATE_DIR}/last-deploy-previous-revision"
  local marker_value

  marker_value="$(read_first_line "$marker_path" 2>/dev/null || true)"
  if [[ "$marker_value" == "$ROLLBACK_SHA" ]]; then
    previous_revision="passed"
  else
    previous_revision="failed"
  fi
}

check_rollback_commit() {
  if git -C "$INSTALL_DIR" rev-parse --verify --quiet "${ROLLBACK_SHA}^{commit}" >/dev/null 2>&1; then
    rollback_commit="passed"
  else
    rollback_commit="failed"
  fi
}

check_permissions() {
  if path_contract "$INSTALL_DIR" root "$SERVICE_GROUP" 755; then
    permission_contract="passed"
  else
    permission_contract="failed"
  fi
}

check_runtime() {
  if sudo -u "$SERVICE_USER" "$PREFLIGHT_SCRIPT" >/dev/null 2>&1; then
    runtime_preflight="passed"
  else
    runtime_preflight="failed"
  fi
}

check_service() {
  local sub_state main_pid

  if systemctl is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_enabled=true
  fi

  if systemctl is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_active=true
  fi

  sub_state="$(systemctl show "$SERVICE_NAME" --property=SubState --value 2>/dev/null || true)"
  if [[ "$sub_state" == "running" ]]; then
    service_running=true
  fi

  main_pid="$(systemctl show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null || true)"
  if [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" != "0" ]]; then
    service_main_pid_nonzero=true
  fi
}

main() {
  if [[ "$#" -ne 2 ]] || ! valid_sha "$EXPECTED_DEPLOYMENT_SHA" || ! valid_sha "$ROLLBACK_SHA" || [[ "$EXPECTED_DEPLOYMENT_SHA" == "$ROLLBACK_SHA" ]]; then
    emit_result false "invalid_rollback_inputs"
    return 0
  fi

  check_repository
  check_checkout
  check_previous_revision_marker
  check_rollback_commit
  check_permissions
  check_runtime
  check_service

  if [[ "$repository" == "passed" &&
        "$postrollback_checkout" == "passed" &&
        "$detached" == "passed" &&
        "$clean" == "passed" &&
        "$previous_revision" == "passed" &&
        "$rollback_commit" == "passed" &&
        "$permission_contract" == "passed" &&
        "$runtime_preflight" == "passed" &&
        "$service_active" == true &&
        "$service_running" == true &&
        "$service_main_pid_nonzero" == true ]]; then
    emit_result true "none"
  elif [[ "$observed_checkout_sha" == "$EXPECTED_DEPLOYMENT_SHA" ]]; then
    emit_result false "rollback_not_started"
  else
    emit_result false "rollback_incomplete"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

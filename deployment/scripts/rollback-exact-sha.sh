#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
CONTROL_DIR="${STATE_DIR}/phase6j-control"
RECOVERY_SOURCE="${INSTALL_DIR}/deployment/scripts/phase6j-recovery-inspect-readonly.sh"
RECOVERY_ARTIFACT="${CONTROL_DIR}/phase6j-recovery-inspect-readonly.sh"
RECOVERY_ARTIFACT_SHA256="7e374a8de73c44261888fef6282844b30de30e8fd6fc55c67de08a7ed32dbc3f"
CONFIG_DIR="/etc/personal-project-operator"
OPENCLAW_PREFIX="/home/ppo/.local/openclaw"
NODE_BIN="${OPENCLAW_PREFIX}/tools/node/bin/node"
OPENCLAW_BIN="${OPENCLAW_PREFIX}/bin/openclaw"
REMOTE_NAME="origin"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
SERVICE_NAME="ppo-openclaw.service"
SYSTEMCTL_BIN="/usr/bin/systemctl"
INSTALL_BIN="/usr/bin/install"
MV_BIN="/bin/mv"
STAT_BIN="/usr/bin/stat"
SHA256SUM_BIN="/usr/bin/sha256sum"
AWK_BIN="/usr/bin/awk"
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

sha256_file() {
  local path="$1"
  local value
  value="$("$SHA256SUM_BIN" "$path" 2>/dev/null | "$AWK_BIN" '{print $1}')" || return 1
  printf '%s\n' "$value"
}

path_contract() {
  local path="$1"
  local expected_user="$2"
  local expected_group="$3"
  local expected_mode="$4"
  local actual_user actual_group actual_mode

  [[ -e "$path" ]] || return 1
  read -r actual_user actual_group actual_mode < <("$STAT_BIN" -c '%U %G %a' "$path" 2>/dev/null) || return 1
  [[ "$actual_user" == "$expected_user" && "$actual_group" == "$expected_group" && "$actual_mode" == "$expected_mode" ]]
}

require_executable() {
  local path="$1"
  [[ -x "$path" ]]
}

parse_node_version() {
  local version
  version="${1#v}"
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  printf '%s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
}

is_supported_node_version() {
  local raw_version="$1"
  local parsed major minor patch
  parsed="$(parse_node_version "$raw_version")" || return 1
  read -r major minor patch <<<"$parsed"

  case "$major" in
    22)
      (( minor > 22 || (minor == 22 && patch >= 3) ))
      ;;
    24)
      (( minor > 15 || (minor == 15 && patch >= 0) ))
      ;;
    25)
      (( minor > 9 || (minor == 9 && patch >= 0) ))
      ;;
    *)
      (( major >= 26 ))
      ;;
  esac
}

node_version_string() {
  local version
  version="$(sudo -u "$SERVICE_USER" "$NODE_BIN" --version 2>/dev/null)" || return 1
  version="${version#v}"
  parse_node_version "$version" >/dev/null || return 1
  printf '%s\n' "$version"
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

  executable_files="$(git -C "$INSTALL_DIR" ls-files -s | "$AWK_BIN" '$1 == "100755" {print $4}')" || return 1
  while IFS= read -r tracked_file; do
    [[ -n "$tracked_file" ]] || continue
    [[ -f "${INSTALL_DIR}/${tracked_file}" ]] || continue
    chmod 0755 "${INSTALL_DIR}/${tracked_file}" || return 1
  done <<<"$executable_files"

  chown -R root:"$SERVICE_GROUP" "$INSTALL_DIR" || return 1
  chmod 0755 "$INSTALL_DIR" || return 1
}

validate_repository_and_current_checkout() {
  local remote_url status_output

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

  status_output="$(git --no-optional-locks -C "$INSTALL_DIR" -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames 2>/dev/null)" ||
    fail_result "dirty_checkout"
  [[ -z "$status_output" ]] ||
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

validate_recovery_artifact() {
  path_contract "$RECOVERY_ARTIFACT" root "$SERVICE_GROUP" 550 ||
    return 1
  [[ "$(sha256_file "$RECOVERY_ARTIFACT")" == "$RECOVERY_ARTIFACT_SHA256" ]] ||
    return 1
}

stage_recovery_artifact() {
  local source_hash staged_hash temp_path

  [[ "$RECOVERY_SOURCE" == "${INSTALL_DIR}/deployment/scripts/phase6j-recovery-inspect-readonly.sh" ]] ||
    fail_result "recovery_artifact_stage_failed"
  [[ "$RECOVERY_ARTIFACT" == "${CONTROL_DIR}/phase6j-recovery-inspect-readonly.sh" ]] ||
    fail_result "recovery_artifact_stage_failed"
  [[ -f "$RECOVERY_SOURCE" ]] ||
    fail_result "recovery_artifact_stage_failed"

  source_hash="$(sha256_file "$RECOVERY_SOURCE")" ||
    fail_result "recovery_artifact_integrity_failed"
  [[ "$source_hash" == "$RECOVERY_ARTIFACT_SHA256" ]] ||
    fail_result "recovery_artifact_integrity_failed"

  "$INSTALL_BIN" -d -o root -g "$SERVICE_GROUP" -m 0750 "$CONTROL_DIR" ||
    fail_result "recovery_artifact_stage_failed"

  temp_path="${CONTROL_DIR}/.phase6j-recovery-inspect-readonly.$$"
  "$INSTALL_BIN" -o root -g "$SERVICE_GROUP" -m 0550 "$RECOVERY_SOURCE" "$temp_path" ||
    fail_result "recovery_artifact_stage_failed"

  staged_hash="$(sha256_file "$temp_path")" ||
    fail_result "recovery_artifact_integrity_failed"
  [[ "$staged_hash" == "$RECOVERY_ARTIFACT_SHA256" ]] ||
    fail_result "recovery_artifact_integrity_failed"

  "$MV_BIN" -f "$temp_path" "$RECOVERY_ARTIFACT" ||
    fail_result "recovery_artifact_stage_failed"

  validate_recovery_artifact ||
    fail_result "recovery_artifact_integrity_failed"
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
  local node_version

  [[ -d "$INSTALL_DIR" && -d "$CONFIG_DIR" ]] ||
    fail_result "runtime_preflight_failed"
  require_executable "$NODE_BIN" ||
    fail_result "runtime_preflight_failed"
  require_executable "$OPENCLAW_BIN" ||
    fail_result "runtime_preflight_failed"

  node_version="$(node_version_string)" ||
    fail_result "runtime_preflight_failed"
  is_supported_node_version "$node_version" ||
    fail_result "runtime_preflight_failed"
  sudo -u "$SERVICE_USER" "$OPENCLAW_BIN" --version >/dev/null 2>&1 ||
    fail_result "runtime_preflight_failed"
  runtime_preflight="passed"
}

restart_fixed_service() {
  "$SYSTEMCTL_BIN" restart "$SERVICE_NAME" >/dev/null 2>&1 ||
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

  if "$SYSTEMCTL_BIN" is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_enabled=true
  fi

  if "$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_active=true
  else
    fail_result "service_not_running"
  fi

  sub_state="$("$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=SubState --value 2>/dev/null)" ||
    fail_result "service_not_running"
  [[ "$sub_state" == "running" ]] || fail_result "service_not_running"
  service_running=true

  main_pid="$("$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null)" ||
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
  stage_recovery_artifact
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

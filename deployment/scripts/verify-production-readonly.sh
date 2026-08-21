#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
WRITE_DATA_DIR="${STATE_DIR}/write-data"
CONFIG_DIR="/etc/personal-project-operator"
OPENCLAW_PREFIX="/home/ppo/.local/openclaw"
NODE_BIN="${OPENCLAW_PREFIX}/tools/node/bin/node"
OPENCLAW_BIN="${OPENCLAW_PREFIX}/bin/openclaw"
REMOTE_NAME="origin"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
SERVICE_NAME="ppo-openclaw.service"
SYSTEMD_UNIT="/etc/systemd/system/ppo-openclaw.service"
REVIEWED_UNIT="${INSTALL_DIR}/deployment/systemd/ppo-openclaw.service"
PREFLIGHT_SCRIPT="${INSTALL_DIR}/deployment/scripts/preflight-openclaw-runtime.sh"
BRIDGE_HELP_CHECK="${INSTALL_DIR}/deployment/scripts/verify-ppo-local-help.mjs"
EXPECTED_SHA="${1:-}"
EXPECTED_PREVIOUS_SHA="${2:-}"

observed_checkout_sha=""
service_enabled=false
service_active=false
service_running=false
service_main_pid_nonzero=false
repository="not_run"
checkout="not_run"
clean="not_run"
previous_revision="not_applicable"
runtime_preflight="not_run"
openclaw_version="not_run"
service_identity="not_run"
unit_contract="not_run"
permission_contract="not_run"
bridge="not_run"

emit_result() {
  local ok="$1"
  local failure_class="$2"

  printf '{"schemaVersion":1,"ok":%s,"failureClass":"%s","observedCheckoutSha":"%s","serviceName":"%s","serviceEnabled":%s,"serviceActive":%s,"serviceRunning":%s,"serviceMainPidNonZero":%s,"repository":"%s","checkout":"%s","clean":"%s","previousRevision":"%s","runtimePreflight":"%s","openclawVersion":"%s","serviceIdentity":"%s","unitContract":"%s","permissionContract":"%s","bridge":"%s","rollbackInvoked":false,"deploymentInvoked":false,"restartInvoked":false,"githubWriteInvoked":false,"modelInvoked":false,"routeInvoked":false}\n' \
    "$ok" \
    "$failure_class" \
    "$observed_checkout_sha" \
    "$SERVICE_NAME" \
    "$service_enabled" \
    "$service_active" \
    "$service_running" \
    "$service_main_pid_nonzero" \
    "$repository" \
    "$checkout" \
    "$clean" \
    "$previous_revision" \
    "$runtime_preflight" \
    "$openclaw_version" \
    "$service_identity" \
    "$unit_contract" \
    "$permission_contract" \
    "$bridge"
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

exec_start_matches_fixed_openclaw_gateway() {
  local value="$1"
  local expected_command="${OPENCLAW_BIN} gateway run"
  local systemd_exec_start_pattern='^\{ path=/home/ppo/\.local/openclaw/bin/openclaw ; argv\[\]=/home/ppo/\.local/openclaw/bin/openclaw gateway run ; ignore_errors=(yes|no) ; start_time=\[[^][]*\] ; stop_time=\[[^][]*\] ; pid=[0-9]+ ; code=[^;{}]+ ; status=[^;{}]+ \}$'

  [[ "$value" != *$'\n'* ]] || return 1
  [[ "$value" == "$expected_command" ]] && return 0
  [[ "$value" =~ $systemd_exec_start_pattern ]] && return 0

  return 1
}

require_exact_inputs() {
  valid_sha "$EXPECTED_SHA" || fail_result "malformed_expected_sha"

  if [[ -n "$EXPECTED_PREVIOUS_SHA" ]]; then
    valid_sha "$EXPECTED_PREVIOUS_SHA" || fail_result "malformed_previous_sha"
  fi
}

check_repository_and_checkout() {
  local remote_url

  remote_url="$(git -C "$INSTALL_DIR" remote get-url "$REMOTE_NAME" 2>/dev/null)" ||
    fail_result "repository_identity_failed"
  [[ "$remote_url" == "$REPO_URL" ]] || fail_result "repository_identity_failed"
  repository="passed"

  observed_checkout_sha="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD 2>/dev/null)" ||
    fail_result "checkout_sha_missing"
  valid_sha "$observed_checkout_sha" || fail_result "checkout_sha_missing"
  [[ "$observed_checkout_sha" == "$EXPECTED_SHA" ]] || fail_result "checkout_sha_mismatch"

  if git -C "$INSTALL_DIR" symbolic-ref -q HEAD >/dev/null 2>&1; then
    fail_result "checkout_not_detached"
  fi
  checkout="passed"

  [[ -z "$(git --no-optional-locks -C "$INSTALL_DIR" -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames 2>/dev/null)" ]] ||
    fail_result "dirty_checkout"
  clean="passed"
}

check_previous_revision_marker() {
  local marker_path="${STATE_DIR}/last-deploy-previous-revision"
  local marker_value

  if [[ -z "$EXPECTED_PREVIOUS_SHA" ]]; then
    previous_revision="not_applicable"
    return 0
  fi

  [[ -f "$marker_path" ]] || fail_result "previous_revision_mismatch"
  marker_value="$(read_first_line "$marker_path")" || fail_result "previous_revision_mismatch"
  [[ "$marker_value" == "$EXPECTED_PREVIOUS_SHA" ]] || fail_result "previous_revision_mismatch"
  previous_revision="passed"
}

check_runtime() {
  sudo -u "$SERVICE_USER" "$PREFLIGHT_SCRIPT" >/dev/null 2>&1 ||
    fail_result "runtime_preflight_failed"
  runtime_preflight="passed"

  sudo -u "$SERVICE_USER" "$OPENCLAW_BIN" --version >/dev/null 2>&1 ||
    fail_result "openclaw_version_failed"
  openclaw_version="passed"
}

check_service_state() {
  local sub_state main_pid service_user service_group work_dir exec_start fragment_path drop_in_paths

  if systemctl is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_enabled=true
  else
    fail_result "service_not_enabled"
  fi

  if systemctl is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_active=true
  else
    fail_result "inactive_service"
  fi

  sub_state="$(systemctl show "$SERVICE_NAME" --property=SubState --value 2>/dev/null)" ||
    fail_result "service_not_running"
  [[ "$sub_state" == "running" ]] || fail_result "service_not_running"
  service_running=true

  main_pid="$(systemctl show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null)" ||
    fail_result "service_not_running"
  [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" != "0" ]] || fail_result "service_not_running"
  service_main_pid_nonzero=true

  service_user="$(systemctl show "$SERVICE_NAME" --property=User --value 2>/dev/null)" ||
    fail_result "service_identity_mismatch"
  service_group="$(systemctl show "$SERVICE_NAME" --property=Group --value 2>/dev/null)" ||
    fail_result "service_identity_mismatch"
  work_dir="$(systemctl show "$SERVICE_NAME" --property=WorkingDirectory --value 2>/dev/null)" ||
    fail_result "service_identity_mismatch"
  exec_start="$(systemctl show "$SERVICE_NAME" --property=ExecStart --value 2>/dev/null)" ||
    fail_result "service_identity_mismatch"

  [[ "$service_user" == "$SERVICE_USER" ]] || fail_result "service_identity_mismatch"
  [[ "$service_group" == "$SERVICE_GROUP" ]] || fail_result "service_identity_mismatch"
  [[ "$work_dir" == "$INSTALL_DIR" ]] || fail_result "service_identity_mismatch"
  exec_start_matches_fixed_openclaw_gateway "$exec_start" || fail_result "service_identity_mismatch"
  service_identity="passed"

  fragment_path="$(systemctl show "$SERVICE_NAME" --property=FragmentPath --value 2>/dev/null)" ||
    fail_result "unit_contract_failed"
  drop_in_paths="$(systemctl show "$SERVICE_NAME" --property=DropInPaths --value 2>/dev/null)" ||
    fail_result "unit_contract_failed"
  [[ "$fragment_path" == "$SYSTEMD_UNIT" ]] || fail_result "unit_contract_failed"
  [[ -z "$drop_in_paths" ]] || fail_result "unit_contract_failed"
  [[ -f "$SYSTEMD_UNIT" && -f "$REVIEWED_UNIT" ]] || fail_result "unit_contract_failed"
  cmp -s "$SYSTEMD_UNIT" "$REVIEWED_UNIT" || fail_result "unit_contract_failed"
  unit_contract="passed"
}

check_permissions() {
  path_contract "$INSTALL_DIR" root "$SERVICE_GROUP" 755 ||
    fail_result "permission_contract_failed"
  path_contract "$STATE_DIR" root "$SERVICE_GROUP" 750 ||
    fail_result "permission_contract_failed"
  path_contract "$WRITE_DATA_DIR" "$SERVICE_USER" "$SERVICE_GROUP" 700 ||
    fail_result "permission_contract_failed"
  path_contract "$CONFIG_DIR" root root 750 ||
    fail_result "permission_contract_failed"
  path_contract "${CONFIG_DIR}/openclaw.env" root "$SERVICE_GROUP" 600 ||
    fail_result "permission_contract_failed"
  path_contract "$OPENCLAW_PREFIX" "$SERVICE_USER" "$SERVICE_GROUP" 755 ||
    fail_result "permission_contract_failed"
  [[ -x "$NODE_BIN" && -x "$OPENCLAW_BIN" && -x "$PREFLIGHT_SCRIPT" && -r "$BRIDGE_HELP_CHECK" ]] ||
    fail_result "permission_contract_failed"
  permission_contract="passed"
}

check_bridge() {
  sudo -u "$SERVICE_USER" "$NODE_BIN" "$BRIDGE_HELP_CHECK" >/dev/null 2>&1 ||
    fail_result "bridge_help_failed"
  bridge="passed"
}

main() {
  require_exact_inputs
  check_repository_and_checkout
  check_previous_revision_marker
  check_runtime
  check_service_state
  check_permissions
  check_bridge
  emit_result true "none"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

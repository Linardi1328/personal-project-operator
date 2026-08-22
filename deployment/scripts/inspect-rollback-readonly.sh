#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
CONFIG_DIR="/etc/personal-project-operator"
OPENCLAW_PREFIX="/home/ppo/.local/openclaw"
NODE_BIN="${OPENCLAW_PREFIX}/tools/node/bin/node"
OPENCLAW_BIN="${OPENCLAW_PREFIX}/bin/openclaw"
REMOTE_NAME="origin"
REPO_URL="https://github.com/Linardi1328/personal-project-operator.git"
SERVICE_NAME="ppo-openclaw.service"
SYSTEMCTL_BIN="/usr/bin/systemctl"
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

permission_entry_matches() {
  local actual_user="$1"
  local actual_group="$2"
  local actual_mode="$3"
  local expected_mode="$4"

  [[ "$actual_user" == "root" && "$actual_group" == "$SERVICE_GROUP" && "$actual_mode" == "$expected_mode" ]]
}

tracked_file_expected_mode() {
  local tracked_mode="$1"

  if [[ "$tracked_mode" == "100755" ]]; then
    printf '755\n'
  else
    printf '644\n'
  fi
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
  if check_runtime_checkout_permission_contract; then
    permission_contract="passed"
  else
    permission_contract="failed"
  fi
}

file_expected_mode() {
  local relative_path="$1"
  local tracked_mode

  tracked_mode="$(git -C "$INSTALL_DIR" ls-files -s -- "$relative_path" 2>/dev/null | awk 'NR == 1 {print $1}')" ||
    return 1
  tracked_file_expected_mode "$tracked_mode"
}

check_runtime_checkout_permission_contract() {
  local path relative_path expected_mode

  path_contract "$INSTALL_DIR" root "$SERVICE_GROUP" 755 || return 1

  while IFS= read -r -d '' path; do
    path_contract "$path" root "$SERVICE_GROUP" 755 || return 1
  done < <(find "$INSTALL_DIR" -type d -print0)

  while IFS= read -r -d '' path; do
    relative_path="${path#"$INSTALL_DIR"/}"
    expected_mode="$(file_expected_mode "$relative_path")" || return 1
    path_contract "$path" root "$SERVICE_GROUP" "$expected_mode" || return 1
  done < <(find "$INSTALL_DIR" -type f -print0)
}

check_runtime() {
  local node_version

  if [[ -d "$INSTALL_DIR" &&
        -d "$CONFIG_DIR" ]] &&
      require_executable "$NODE_BIN" &&
      require_executable "$OPENCLAW_BIN" &&
      node_version="$(node_version_string)" &&
      is_supported_node_version "$node_version" &&
      sudo -u "$SERVICE_USER" "$OPENCLAW_BIN" --version >/dev/null 2>&1; then
    runtime_preflight="passed"
  else
    runtime_preflight="failed"
  fi
}

check_service() {
  local sub_state main_pid

  if "$SYSTEMCTL_BIN" is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_enabled=true
  fi

  if "$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    service_active=true
  fi

  sub_state="$("$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=SubState --value 2>/dev/null || true)"
  if [[ "$sub_state" == "running" ]]; then
    service_running=true
  fi

  main_pid="$("$SYSTEMCTL_BIN" show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null || true)"
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

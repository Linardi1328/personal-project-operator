#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
SOURCE_ROOT="/var/lib/personal-project-operator/source-repos"
SOURCE_DIR="${SOURCE_ROOT}/khlim-digital-ecosystem"
REPO_URL="https://github.com/Linardi1328/khlim-digital-ecosystem.git"
BRANCH="main"
GIT_BIN="/usr/bin/git"
RUNUSER_BIN="/usr/sbin/runuser"
OPENCLAW_NODE_BIN="/home/ppo/.local/openclaw/tools/node/bin/node"
TRUSTED_TOOL_ROOT="/usr/local/lib/personal-project-operator/phase6k-tools"
TRUSTED_NODE_ROOT="${TRUSTED_TOOL_ROOT}/node-v24"
TRUSTED_NODE_DIR="${TRUSTED_NODE_ROOT}/bin"
TRUSTED_NODE_BIN="${TRUSTED_NODE_DIR}/node"
REQUIRED_CONFIRMATION="prepare-khlim-development-runtime"

fail() {
  printf 'KHLIM development runtime preparation failed: %s\n' "$1" >&2
  exit 1
}

require_confirmation() {
  if [[ "${PPO_KHLIM_RUNTIME_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
    printf 'Refusing to prepare the KHLIM development runtime without explicit owner confirmation.\n' >&2
    printf 'Run on the VPS only with: PPO_KHLIM_RUNTIME_CONFIRM=%s %s\n' "$REQUIRED_CONFIRMATION" "$0" >&2
    exit 2
  fi
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "run as root on the target Ubuntu VPS."
}

require_runtime() {
  getent passwd "$SERVICE_USER" >/dev/null || fail "service user '${SERVICE_USER}' does not exist."
  getent group "$SERVICE_GROUP" >/dev/null || fail "service group '${SERVICE_GROUP}' does not exist."
  [[ -x "$GIT_BIN" ]] || fail "required Git executable is unavailable."
  [[ -x "$RUNUSER_BIN" ]] || fail "required runuser executable is unavailable."
  [[ -x "$OPENCLAW_NODE_BIN" ]] || fail "OpenClaw bundled Node executable is unavailable."
}

run_as_ppo() {
  "$RUNUSER_BIN" -u "$SERVICE_USER" -- "$@"
}

assert_safe_source_path() {
  [[ "$SOURCE_DIR" == "${SOURCE_ROOT}/khlim-digital-ecosystem" ]] || fail "fixed source path changed unexpectedly."

  if [[ -L "$SOURCE_ROOT" || -L "$SOURCE_DIR" ]]; then
    fail "source root and checkout must not be symbolic links."
  fi
}

assert_safe_trusted_node_path() {
  [[ "$TRUSTED_NODE_BIN" == "/usr/local/lib/personal-project-operator/phase6k-tools/node-v24/bin/node" ]] ||
    fail "fixed trusted Node path changed unexpectedly."

  local path
  for path in "$TRUSTED_TOOL_ROOT" "$TRUSTED_NODE_ROOT" "$TRUSTED_NODE_DIR" "$TRUSTED_NODE_BIN"; do
    if [[ -L "$path" ]]; then
      fail "trusted Node path must not contain symbolic links."
    fi
  done
}

assert_supported_node_version() {
  local node_path="$1"
  local node_version
  node_version="$("$node_path" --version)" || fail "could not read Node version."

  if [[ ! "$node_version" =~ ^v24\.([0-9]+)\.([0-9]+)([-+].*)?$ ]]; then
    fail "trusted development Node must be Node 24.15 or newer."
  fi

  if (( 10#${BASH_REMATCH[1]} < 15 )); then
    fail "trusted development Node must be Node 24.15 or newer."
  fi

  printf '%s\n' "$node_version"
}

prepare_trusted_node() {
  assert_safe_trusted_node_path

  local source_version trusted_version
  source_version="$(assert_supported_node_version "$OPENCLAW_NODE_BIN")"

  install -d -m 0755 -o root -g root "$TRUSTED_TOOL_ROOT"
  install -d -m 0755 -o root -g root "$TRUSTED_NODE_ROOT"
  install -d -m 0755 -o root -g root "$TRUSTED_NODE_DIR"
  install -m 0755 -o root -g root "$OPENCLAW_NODE_BIN" "$TRUSTED_NODE_BIN"

  trusted_version="$(assert_supported_node_version "$TRUSTED_NODE_BIN")"
  [[ "$trusted_version" == "$source_version" ]] || fail "trusted Node copy version does not match its source."
  [[ "$(stat -c '%u:%g:%a' "$TRUSTED_NODE_BIN")" == "0:0:755" ]] ||
    fail "trusted Node copy must be root-owned and non-writable by the service user."
}

verify_checkout_identity() {
  [[ -d "${SOURCE_DIR}/.git" ]] || fail "source checkout is not a Git repository root."

  local origin
  origin="$(run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" remote get-url origin)" || fail "source origin is unavailable."
  [[ "$origin" == "$REPO_URL" ]] || fail "source origin does not match the reviewed KHLIM repository."

  [[ -z "$(run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" status --porcelain=v1 --untracked-files=all)" ]] ||
    fail "source checkout is dirty; refusing to synchronize it."
}

clone_or_fast_forward() {
  assert_safe_source_path
  install -d -m 0750 -o root -g "$SERVICE_GROUP" "$SOURCE_ROOT"

  if [[ ! -e "$SOURCE_DIR" ]]; then
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$SOURCE_DIR"
    run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" clone --branch "$BRANCH" --single-branch "$REPO_URL" .
  else
    verify_checkout_identity
    run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" fetch origin "$BRANCH"
    run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" checkout "$BRANCH"
    run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" merge --ff-only "origin/${BRANCH}"
  fi

  verify_checkout_identity

  local head remote_head
  head="$(run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" rev-parse --verify HEAD)"
  remote_head="$(run_as_ppo "$GIT_BIN" -C "$SOURCE_DIR" rev-parse --verify "origin/${BRANCH}")"
  [[ "$head" == "$remote_head" ]] || fail "source checkout is not at the fetched origin/main commit."
}

main() {
  require_confirmation
  require_root
  require_runtime
  prepare_trusted_node
  clone_or_fast_forward
  printf 'KHLIM development runtime is ready: Node %s; source %s.\n' "$TRUSTED_NODE_BIN" "$SOURCE_DIR"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

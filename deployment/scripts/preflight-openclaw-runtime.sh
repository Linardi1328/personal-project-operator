#!/usr/bin/env bash
set -Eeuo pipefail

OPENCLAW_PREFIX="/home/ppo/.local/openclaw"
NODE_BIN="${OPENCLAW_PREFIX}/bin/node"
OPENCLAW_BIN="${OPENCLAW_PREFIX}/bin/openclaw"
MIN_NODE_MAJOR=20
CONFIG_DIR="/etc/personal-project-operator"
INSTALL_DIR="/opt/personal-project-operator"
EX_SOFTWARE=78

fail_software() {
  printf 'Phase 4A OpenClaw preflight failed: %s\n' "$1" >&2
  exit "$EX_SOFTWARE"
}

fail_local() {
  printf 'Phase 4A OpenClaw preflight failed: %s\n' "$1" >&2
  exit 1
}

require_executable() {
  local path="$1"
  [[ -x "$path" ]] || fail_software "required executable is missing or not executable: ${path}"
}

node_major_version() {
  local version
  version="$("$NODE_BIN" --version 2>/dev/null)" || fail_software "local-prefix Node cannot run."
  version="${version#v}"
  version="${version%%.*}"
  [[ "$version" =~ ^[0-9]+$ ]] || fail_software "local-prefix Node returned an unparseable version."
  printf '%s\n' "$version"
}

main() {
  [[ "$(id -un)" == "ppo" ]] || fail_local "must run as service user ppo."
  [[ -d "$INSTALL_DIR" ]] || fail_software "PPO checkout is missing at ${INSTALL_DIR}."
  [[ -d "$CONFIG_DIR" ]] || fail_software "config directory is missing at ${CONFIG_DIR}."

  require_executable "$NODE_BIN"
  require_executable "$OPENCLAW_BIN"

  local major
  major="$(node_major_version)"
  if (( major < MIN_NODE_MAJOR )); then
    fail_software "Node ${major} is unsupported; install a current OpenClaw local-prefix runtime."
  fi

  "$OPENCLAW_BIN" --version >/dev/null 2>&1 || fail_software "OpenClaw executable failed version preflight."

  printf 'Phase 4A OpenClaw runtime preflight passed.\n'
}

main "$@"

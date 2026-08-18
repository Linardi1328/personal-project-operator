#!/usr/bin/env bash
set -Eeuo pipefail

OPENCLAW_PREFIX="/home/ppo/.local/openclaw"
NODE_BIN="${OPENCLAW_PREFIX}/tools/node/bin/node"
OPENCLAW_BIN="${OPENCLAW_PREFIX}/bin/openclaw"
CONFIG_DIR="/etc/personal-project-operator"
INSTALL_DIR="/opt/personal-project-operator"
EX_SOFTWARE=78

export PATH="${OPENCLAW_PREFIX}/tools/node/bin:${OPENCLAW_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

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
  version="$("$NODE_BIN" --version 2>/dev/null)" || fail_software "bundled Node cannot run."
  version="${version#v}"
  parse_node_version "$version" >/dev/null || fail_software "bundled Node returned an unparseable version."
  printf '%s\n' "$version"
}

main() {
  [[ "$(id -un)" == "ppo" ]] || fail_local "must run as service user ppo."
  [[ -d "$INSTALL_DIR" ]] || fail_software "PPO checkout is missing at ${INSTALL_DIR}."
  [[ -d "$CONFIG_DIR" ]] || fail_software "config directory is missing at ${CONFIG_DIR}."

  require_executable "$NODE_BIN"
  require_executable "$OPENCLAW_BIN"

  local node_version
  node_version="$(node_version_string)"
  if ! is_supported_node_version "$node_version"; then
    fail_software "Node ${node_version} is unsupported; install the current official OpenClaw local-prefix runtime."
  fi

  "$OPENCLAW_BIN" --version >/dev/null 2>&1 || fail_software "OpenClaw executable failed version preflight."

  printf 'Phase 4A OpenClaw runtime preflight passed.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

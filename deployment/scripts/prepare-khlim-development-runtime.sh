#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
SERVICE_HOME="/home/ppo"
SOURCE_ROOT="/var/lib/personal-project-operator/source-repos"
SOURCE_DIR="${SOURCE_ROOT}/khlim-digital-ecosystem"
WORKSPACE_ROOT="/var/lib/personal-project-operator/development-workspaces"
REPO_URL="https://github.com/Linardi1328/khlim-digital-ecosystem.git"
BRANCH="main"
GIT_BIN="/usr/bin/git"
RUNUSER_BIN="/usr/sbin/runuser"
ENV_BIN="/usr/bin/env"
APT_GET_BIN="/usr/bin/apt-get"
DPKG_QUERY_BIN="/usr/bin/dpkg-query"
OPENCLAW_NODE_BIN="/home/ppo/.local/openclaw/tools/node/bin/node"
OPENCLAW_NPM_BIN="/home/ppo/.local/openclaw/tools/node/bin/npm"
TRUSTED_TOOL_ROOT="/usr/local/lib/personal-project-operator/phase6k-tools"
TRUSTED_NODE_ROOT="${TRUSTED_TOOL_ROOT}/node-v24"
TRUSTED_NODE_DIR="${TRUSTED_NODE_ROOT}/bin"
TRUSTED_NODE_BIN="${TRUSTED_NODE_DIR}/node"
CODEX_BIN="${SERVICE_HOME}/.local/bin/codex"
CODEX_HOME="${SERVICE_HOME}/.codex"
RUNTIME_PATH="${SERVICE_HOME}/.local/bin:${SERVICE_HOME}/.local/openclaw/tools/node/bin:/usr/local/bin:/usr/bin:/bin"
CODEX_VERSION="0.149.1"
CODEX_NPM_SPEC="@openai/codex@${CODEX_VERSION}"
BWRAP_BIN="/usr/bin/bwrap"
REVIEWER_BIN="/usr/local/bin/ppo-independent-reviewer"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REVIEWER_SOURCE="${SCRIPT_DIR}/../bin/ppo-independent-reviewer"
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
  [[ -x "$ENV_BIN" ]] || fail "required env executable is unavailable."
  [[ -x "$APT_GET_BIN" ]] || fail "required apt-get executable is unavailable."
  [[ -x "$DPKG_QUERY_BIN" ]] || fail "required dpkg-query executable is unavailable."
  [[ -x "$OPENCLAW_NODE_BIN" ]] || fail "OpenClaw bundled Node executable is unavailable."
  [[ -x "$OPENCLAW_NPM_BIN" ]] || fail "OpenClaw bundled npm executable is unavailable."
  [[ -f "$REVIEWER_SOURCE" && -x "$REVIEWER_SOURCE" ]] || fail "reviewed independent reviewer wrapper is unavailable."
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

prepare_codex_cli() {
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${SERVICE_HOME}/.local"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$CODEX_HOME"

  local installed_version=""
  if [[ -x "$CODEX_BIN" ]]; then
    installed_version="$(run_as_ppo "$ENV_BIN" \
      HOME="$SERVICE_HOME" \
      CODEX_HOME="$CODEX_HOME" \
      PATH="$RUNTIME_PATH" \
      "$CODEX_BIN" --version 2>/dev/null || true)"
  fi

  if [[ "$installed_version" != "codex-cli ${CODEX_VERSION}" ]]; then
    run_as_ppo "$ENV_BIN" \
      HOME="$SERVICE_HOME" \
      PATH="$RUNTIME_PATH" \
      "$OPENCLAW_NPM_BIN" install --global --prefix "${SERVICE_HOME}/.local" --include=optional "$CODEX_NPM_SPEC"
  fi

  [[ -x "$CODEX_BIN" ]] || fail "standalone Codex CLI installation did not produce the fixed executable."
  installed_version="$(run_as_ppo "$ENV_BIN" \
    HOME="$SERVICE_HOME" \
    CODEX_HOME="$CODEX_HOME" \
    PATH="$RUNTIME_PATH" \
    "$CODEX_BIN" --version)" || fail "could not read standalone Codex CLI version."
  [[ "$installed_version" == "codex-cli ${CODEX_VERSION}" ]] || fail "standalone Codex CLI version does not match the reviewed runtime."
}

prepare_linux_sandbox() {
  local package
  local packages_ready=true
  for package in bubblewrap apparmor-profiles apparmor-utils; do
    if [[ "$($DPKG_QUERY_BIN -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)" != "ii " ]]; then
      packages_ready=false
      break
    fi
  done

  if [[ "$packages_ready" != true ]]; then
    "$APT_GET_BIN" update
    DEBIAN_FRONTEND=noninteractive "$APT_GET_BIN" install -y bubblewrap apparmor-profiles apparmor-utils
  fi

  [[ -x "$BWRAP_BIN" ]] || fail "Bubblewrap is unavailable after installation."

  local extra_profile="/usr/share/apparmor/extra-profiles/bwrap-userns-restrict"
  local active_profile="/etc/apparmor.d/bwrap-userns-restrict"
  if [[ -f "$extra_profile" && ! -f "$active_profile" ]]; then
    install -m 0644 -o root -g root "$extra_profile" "$active_profile"
  fi

  if [[ -f "$active_profile" && -x "/usr/sbin/apparmor_parser" ]]; then
    /usr/sbin/apparmor_parser -r "$active_profile"
  fi
}

prepare_review_wrapper() {
  install -m 0755 -o root -g root "$REVIEWER_SOURCE" "$REVIEWER_BIN"
  [[ "$(stat -c '%u:%g:%a' "$REVIEWER_BIN")" == "0:0:755" ]] ||
    fail "independent reviewer wrapper must be root-owned and non-writable by the service user."
}

prepare_workspace_root() {
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$WORKSPACE_ROOT"
}

verify_codex_authentication() {
  if ! run_as_ppo "$ENV_BIN" \
    HOME="$SERVICE_HOME" \
    CODEX_HOME="$CODEX_HOME" \
    PATH="$RUNTIME_PATH" \
    "$CODEX_BIN" login status >/dev/null 2>&1; then
    printf 'KHLIM development runtime installed; one-time Codex authentication is required.\n' >&2
    printf 'Run: sudo -H -u ppo env PATH=%s %s login --device-auth\n' \
      "$RUNTIME_PATH" "$CODEX_BIN" >&2
    exit 3
  fi
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
  prepare_codex_cli
  prepare_linux_sandbox
  prepare_review_wrapper
  prepare_workspace_root
  clone_or_fast_forward
  verify_codex_authentication
  printf 'KHLIM development runtime is ready: Codex %s; Node %s; source %s.\n' "$CODEX_VERSION" "$TRUSTED_NODE_BIN" "$SOURCE_DIR"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

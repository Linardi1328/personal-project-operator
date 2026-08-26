#!/bin/bash
set -euo pipefail

BASE_PYTHON="/opt/homebrew/bin/python3.12"
GIT_BIN="/opt/homebrew/bin/git"
SOURCE_REPO="/Users/richie/khlim-assist"
RUNTIME_ROOT="/Users/richie/.local/share/personal-project-operator/runtimes"
RUNTIME_DIR="${RUNTIME_ROOT}/khlim-assist-python3.12"
STAGING_DIR="${RUNTIME_ROOT}/khlim-assist-python3.12.staging"
REQUIRED_CONFIRMATION="prepare-macos-khlim-assist-python-runtime-v1"

if [[ "${PPO_MACOS_PYTHON_RUNTIME_CONFIRM:-}" != "${REQUIRED_CONFIRMATION}" ]]; then
  printf 'PPO macOS Python runtime preparation requires explicit confirmation.\n' >&2
  exit 78
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'PPO macOS Python runtime preparation requires Darwin.\n' >&2
  exit 78
fi

for executable in "${BASE_PYTHON}" "${GIT_BIN}"; do
  if [[ ! -x "${executable}" ]]; then
    printf 'Required executable is unavailable: %s\n' "${executable}" >&2
    exit 78
  fi
done

if [[ ! -d "${SOURCE_REPO}" || -L "${SOURCE_REPO}" ]]; then
  printf 'KHLIM Assist source repository is unavailable or unsafe.\n' >&2
  exit 78
fi

if [[ "$("${GIT_BIN}" -C "${SOURCE_REPO}" rev-parse --show-toplevel)" != "${SOURCE_REPO}" ]]; then
  printf 'KHLIM Assist source path is not the repository root.\n' >&2
  exit 78
fi

if [[ -n "$("${GIT_BIN}" -C "${SOURCE_REPO}" status --porcelain=v1 --untracked-files=all)" ]]; then
  printf 'KHLIM Assist source repository must be clean.\n' >&2
  exit 78
fi

if [[ -L "${RUNTIME_ROOT}" || -L "${RUNTIME_DIR}" || -L "${STAGING_DIR}" ]]; then
  printf 'PPO macOS Python runtime path is unsafe.\n' >&2
  exit 78
fi

mkdir -p "${RUNTIME_ROOT}"

if [[ ! -d "${RUNTIME_ROOT}" || -L "${RUNTIME_ROOT}" ]]; then
  printf 'PPO macOS Python runtime root is unavailable or unsafe.\n' >&2
  exit 78
fi

chmod 700 "${RUNTIME_ROOT}"

verify_runtime() {
  local runtime_python="$1"

  "${runtime_python}" -m ruff --version >/dev/null
  "${runtime_python}" -m mypy --version >/dev/null
  "${runtime_python}" -m pytest --version >/dev/null
  "${runtime_python}" -c "import aiosqlite, alembic, asyncpg, fastapi, greenlet, httpx, openai, pydantic, pydantic_settings, pytest, pytest_asyncio, sqlalchemy, uvicorn; raise SystemExit(0 if pytest.__version__.split('.', 1)[0] == '8' else 1)"
}

if [[ -d "${RUNTIME_DIR}" ]]; then
  verify_runtime "${RUNTIME_DIR}/bin/python3"
  printf 'PPO KHLIM Assist Python runtime already ready.\n'
  exit 0
fi

if [[ -e "${RUNTIME_DIR}" ]]; then
  printf 'PPO KHLIM Assist Python runtime path is occupied by a non-directory.\n' >&2
  exit 78
fi

if [[ -e "${STAGING_DIR}" ]]; then
  printf 'PPO KHLIM Assist Python staging path already exists; refusing replacement.\n' >&2
  exit 78
fi

SOURCE_SNAPSHOT="$(mktemp -d /tmp/ppo-khlim-assist-python.XXXXXX)"
cleanup() {
  local exit_code=$?

  if [[ "${SOURCE_SNAPSHOT}" == /tmp/ppo-khlim-assist-python.* && -d "${SOURCE_SNAPSHOT}" ]]; then
    rm -rf -- "${SOURCE_SNAPSHOT}"
  fi

  if (( exit_code != 0 )) && [[ "${STAGING_DIR}" == "${RUNTIME_ROOT}/khlim-assist-python3.12.staging" && -d "${STAGING_DIR}" ]]; then
    rm -rf -- "${STAGING_DIR}"
  fi

  return "${exit_code}"
}
trap cleanup EXIT

"${GIT_BIN}" -C "${SOURCE_REPO}" archive --format=tar HEAD | tar -xf - -C "${SOURCE_SNAPSHOT}"
"${BASE_PYTHON}" -m venv "${STAGING_DIR}"

PIP_DISABLE_PIP_VERSION_CHECK=1 \
  "${STAGING_DIR}/bin/python3" -m pip install "${SOURCE_SNAPSHOT}[dev]"

verify_runtime "${STAGING_DIR}/bin/python3"
mv "${STAGING_DIR}" "${RUNTIME_DIR}"
chmod -R u+rwX,go-rwx "${RUNTIME_DIR}"

printf 'PPO KHLIM Assist Python runtime prepared: %s\n' "${RUNTIME_DIR}"

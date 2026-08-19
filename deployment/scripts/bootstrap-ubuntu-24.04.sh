#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="ppo"
SERVICE_GROUP="ppo"
INSTALL_DIR="/opt/personal-project-operator"
CONFIG_DIR="/etc/personal-project-operator"
STATE_DIR="/var/lib/personal-project-operator"
LOG_DIR="/var/log/personal-project-operator"
SERVICE_NAME="ppo-openclaw.service"
REQUIRED_CONFIRMATION="ubuntu-24.04-vps"

fail() {
  printf 'Phase 4A bootstrap failed: %s\n' "$1" >&2
  exit 1
}

require_confirmation() {
  if [[ "${PPO_BOOTSTRAP_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
    printf 'Refusing to bootstrap without explicit owner confirmation.\n' >&2
    printf 'Run on the VPS only with: PPO_BOOTSTRAP_CONFIRM=%s %s\n' "$REQUIRED_CONFIRMATION" "$0" >&2
    exit 2
  fi
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run as root on the target Ubuntu VPS."
  fi
}

require_ubuntu_2404() {
  # shellcheck source=/dev/null
  source /etc/os-release

  if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
    fail "target host must be Ubuntu 24.04 LTS."
  fi
}

repo_root() {
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  cd -- "${script_dir}/../.." && pwd
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git gh ufw logrotate iproute2
}

create_service_user() {
  if ! getent group "$SERVICE_GROUP" >/dev/null; then
    groupadd --system "$SERVICE_GROUP"
  fi

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/home/${SERVICE_USER}" --shell /bin/bash --gid "$SERVICE_GROUP" "$SERVICE_USER"
  fi
}

create_directories() {
  install -d -m 0755 -o root -g root "$INSTALL_DIR"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "/home/${SERVICE_USER}/.local"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "/home/${SERVICE_USER}/.local/openclaw"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/write-data"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/write-data/project-notes"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/write-data/pending-project-notes"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/write-data/pending-project-notes/pending"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/write-data/pending-project-notes/claimed"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/write-data/audit"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "${STATE_DIR}/audit"
  install -d -m 0750 -o "$SERVICE_USER" -g adm "$LOG_DIR"
  install -d -m 0750 "$CONFIG_DIR"

  if [[ ! -f "${CONFIG_DIR}/openclaw.env" ]]; then
    install -m 0600 -o root -g "$SERVICE_GROUP" /dev/null "${CONFIG_DIR}/openclaw.env"
  fi
}

install_systemd_files() {
  local root
  root="$(repo_root)"
  install -m 0644 "${root}/deployment/systemd/${SERVICE_NAME}" "/etc/systemd/system/${SERVICE_NAME}"
  install -m 0644 "${root}/deployment/logrotate/ppo-openclaw" /etc/logrotate.d/ppo-openclaw
  systemctl daemon-reload
}

main() {
  require_confirmation
  require_root
  require_ubuntu_2404
  install_packages
  create_service_user
  create_directories
  install_systemd_files

  printf 'Phase 4A bootstrap installed local prerequisites and systemd templates.\n'
  printf 'Next: configure /etc/personal-project-operator/openclaw.env outside the repo, install/update the repo, then start the service explicitly.\n'
}

main "$@"

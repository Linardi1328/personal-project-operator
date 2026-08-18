#!/usr/bin/env bash
set -Eeuo pipefail

REQUIRED_CONFIRMATION="openssh-only"

fail() {
  printf 'Phase 4A firewall hardening failed: %s\n' "$1" >&2
  exit 1
}

require_confirmation() {
  if [[ "${PPO_FIREWALL_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
    printf 'Refusing firewall changes without explicit owner confirmation.\n' >&2
    printf 'Run on the VPS only with: PPO_FIREWALL_CONFIRM=%s %s\n' "$REQUIRED_CONFIRMATION" "$0" >&2
    exit 2
  fi
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run as root on the target Ubuntu VPS."
  fi
}

require_ssh_key_presence() {
  if ! find /home /root -maxdepth 3 -path '*/.ssh/authorized_keys' -type f -size +0c -print -quit | grep -q .; then
    fail "no populated authorized_keys file found; refusing to change firewall posture."
  fi
}

main() {
  require_confirmation
  require_root
  require_ssh_key_presence

  ufw allow OpenSSH
  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable
  ufw status verbose

  printf 'Firewall hardened for OpenSSH-only ingress.\n'
  printf 'Review SSH daemon key-only settings manually, run sshd -t, then reload the SSH service only after confirming a second session can connect.\n'
}

main "$@"

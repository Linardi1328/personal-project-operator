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

unique_ports=()

add_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "detected SSH port is not numeric."
  (( port >= 1 && port <= 65535 )) || fail "detected SSH port is out of range."

  local existing
  for existing in "${unique_ports[@]}"; do
    [[ "$existing" == "$port" ]] && return
  done

  unique_ports+=("$port")
}

detect_sshd_ports() {
  local line local_address port

  while IFS= read -r line; do
    [[ "$line" == *sshd* ]] || continue
    local_address="$(awk '{print $4}' <<<"$line")"
    port="${local_address##*:}"
    port="${port//]/}"
    add_port "$port"
  done < <(ss -H -ltnp)

  ((${#unique_ports[@]} > 0)) || fail "no listening sshd port detected; refusing to enable UFW."
}

require_current_ssh_session_matches_detected_port() {
  [[ -n "${SSH_CONNECTION:-}" ]] || fail "SSH_CONNECTION is missing; run from an active SSH session and preserve that environment value through sudo."

  local server_port
  server_port="$(awk '{print $4}' <<<"$SSH_CONNECTION")"
  [[ "$server_port" =~ ^[0-9]+$ ]] || fail "active SSH session port is not numeric."

  local port
  for port in "${unique_ports[@]}"; do
    [[ "$port" == "$server_port" ]] && return
  done

  fail "active SSH session port does not match detected sshd listeners."
}

validate_sshd_config() {
  sshd -t || fail "sshd configuration validation failed; refusing firewall changes."
}

main() {
  require_confirmation
  require_root
  validate_sshd_config
  detect_sshd_ports
  require_current_ssh_session_matches_detected_port

  local port
  for port in "${unique_ports[@]}"; do
    ufw allow "${port}/tcp" comment 'PPO Phase 4A detected sshd listener'
  done

  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable
  ufw status verbose

  printf 'Firewall hardened for detected SSH ingress ports: %s\n' "${unique_ports[*]}"
  printf 'Review SSH daemon key-only settings manually, run sshd -t, then reload the SSH service only after confirming a second session can connect.\n'
}

main "$@"

# VPS Setup

This document describes the future VPS deployment plan. Phase 0 does not deploy anything.

## Planned VPS requirements

- Ubuntu VPS
- 1-2 vCPU
- 2 GB RAM preferred
- 20-40 GB storage
- SSH access
- firewall enabled
- environment variables for secrets
- Tailscale optional
- restart strategy required

## Future deployment checklist

- Create VPS.
- Harden SSH access.
- Enable firewall.
- Install dependencies.
- Clone repo.
- Configure environment variables.
- Run OpenClaw.
- Configure process manager.
- Test `/vps-health`.

## Environment handling

Secrets must be configured outside the repo through environment variables or a secure platform secret manager.

Do not commit:

- bot tokens
- GitHub tokens
- API keys
- passwords
- private SSH keys
- account credentials

## Process manager plan

Future deployment should use a restart strategy such as:

- `systemd`
- Docker restart policy
- a managed process supervisor

The selected strategy must support:

- restart on crash
- log inspection
- environment variable injection
- safe deploy and rollback process

## Phase 0 boundary

No live deployment scripts are included in Phase 0. Any future scripts must be clearly marked, reviewed, and tested before use.


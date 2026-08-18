# Phase 4A VPS Deployment Foundation

Phase 4A adds reviewed deployment foundation files for a future Ubuntu VPS. It does not deploy a live server from this repository.

Target host:

- Ubuntu 24.04 LTS
- 2 vCPU / 4 GB RAM class VPS
- OpenClaw running persistently under `systemd`
- Personal Project Operator checked out at `/opt/personal-project-operator`
- one existing OpenClaw plugin tool: `ppo_local`

## Safety Boundary

Phase 4A files are server-local bootstrap materials only.

- No live SSH is performed by these scripts.
- No Telegram API behavior changes are introduced.
- No GitHub write endpoint, GraphQL endpoint, or new endpoint family is added.
- No Codex, ChatGPT, OpenAI API, or model call is made.
- No deployment is performed by automated tests.
- No credentials, tokens, private keys, host addresses, or real secrets belong in this repository.
- `/ppo vps-health` is not routed through OpenClaw yet.

## Files

- `deployment/systemd/ppo-openclaw.service`: systemd unit template for OpenClaw.
- `deployment/logrotate/ppo-openclaw`: logrotate template for optional file logs.
- `deployment/scripts/bootstrap-ubuntu-24.04.sh`: installs OS packages, creates the non-root service user, creates directories, and installs systemd/logrotate templates.
- `deployment/scripts/install-or-update-repo.sh`: installs or updates the PPO checkout from the fixed main branch.
- `deployment/scripts/service-control.sh`: owner-confirmed `systemd` status/start/restart/enable controls.
- `deployment/scripts/firewall-ssh-hardening.sh`: owner-confirmed OpenSSH-only UFW baseline.
- `deployment/scripts/rollback-repo.sh`: owner-confirmed rollback to the recorded last-good revision.
- `deployment/scripts/vps-health.mjs`: read-only local host health foundation.

## OS And Runtime Dependencies

The bootstrap script targets Ubuntu 24.04 only and installs:

- `ca-certificates`
- `curl`
- `git`
- `gh`
- `nodejs`
- `npm`
- `ufw`
- `logrotate`

OpenClaw itself remains installed/configured by the owner according to OpenClaw's current installation process. This repository does not vendor OpenClaw and does not edit `~/.openclaw` automatically.

## Service User

The service runs as:

```text
user: ppo
group: ppo
home: /home/ppo
```

The systemd unit uses:

```text
User=ppo
Group=ppo
WorkingDirectory=/opt/personal-project-operator
EnvironmentFile=-/etc/personal-project-operator/openclaw.env
Restart=on-failure
```

## Secrets And Environment Variables

Store service environment outside the repo:

```text
/etc/personal-project-operator/openclaw.env
```

Rules:

- keep the file owned by root with restrictive permissions
- configure only values required by OpenClaw or its connected providers
- authenticate `gh` as the service user outside this repository when GitHub read-only commands are needed
- never paste credentials into Markdown, tests, fixtures, logs, commits, or chat
- do not commit `.env` files or copied service environment files

## Owner-Only VPS Bootstrap

Run these only on the reviewed VPS after branch approval. They are not automated tests.

```bash
sudo PPO_BOOTSTRAP_CONFIRM=ubuntu-24.04-vps deployment/scripts/bootstrap-ubuntu-24.04.sh
sudo PPO_REPO_UPDATE_CONFIRM=install-or-update-main deployment/scripts/install-or-update-repo.sh
```

Then manually configure OpenClaw for the service user:

- load the skill root from `/opt/personal-project-operator/openclaw/skills`
- link the plugin from `/opt/personal-project-operator/openclaw/plugins/ppo-local`
- keep the tool surface limited to `ppo_local`
- keep `command-dispatch: tool`, `command-tool: ppo_local`, and `command-arg-mode: raw`

Do not use `group:plugins`, wildcard tool permissions, or a generic GitHub tool.

## systemd Start, Restart, And Boot Recovery

Status and logs are read-only:

```bash
deployment/scripts/service-control.sh status
deployment/scripts/service-control.sh logs
```

Mutating service actions require explicit owner confirmation:

```bash
sudo PPO_SERVICE_CONFIRM=systemd-service-control deployment/scripts/service-control.sh enable
sudo PPO_SERVICE_CONFIRM=systemd-service-control deployment/scripts/service-control.sh start
sudo PPO_SERVICE_CONFIRM=systemd-service-control deployment/scripts/service-control.sh restart
```

Boot recovery is provided by `systemctl enable ppo-openclaw.service` plus the unit's `Restart=on-failure` policy.

## Firewall And SSH-Key Hardening

Before changing firewall posture:

- confirm SSH key login works
- keep a second SSH session open
- confirm at least one populated `authorized_keys` file exists
- do not paste keys into this repository

Owner-confirmed OpenSSH-only UFW baseline:

```bash
sudo PPO_FIREWALL_CONFIRM=openssh-only deployment/scripts/firewall-ssh-hardening.sh
```

SSH daemon settings should be reviewed manually and tested with `sshd -t` before reload. This repository does not auto-edit SSH daemon configuration.

## Logs And Rotation

Primary service logs:

```bash
journalctl -u ppo-openclaw.service -n 120 --no-pager
journalctl -u ppo-openclaw.service -f
```

The logrotate template covers optional logs under:

```text
/var/log/personal-project-operator/*.log
```

Do not paste raw logs into issues or chat if they may contain provider credentials or session details.

## Rollback And Recovery

`install-or-update-repo.sh` records the previous reviewed revision at:

```text
/var/lib/personal-project-operator/last-good-revision
```

Owner-confirmed rollback:

```bash
sudo PPO_ROLLBACK_CONFIRM=rollback-last-good deployment/scripts/rollback-repo.sh
```

The rollback script reads only that recorded revision, validates it as a commit SHA, switches the local checkout to that revision, and restarts the service.

## Health Check Foundation

Local read-only health check:

```bash
node deployment/scripts/vps-health.mjs
```

The health checker reports:

- Node.js availability
- `git` availability
- `gh` availability
- OpenClaw availability
- `ppo-openclaw.service` active/enabled state
- uptime
- disk summary
- memory summary
- PPO repo/wrapper path presence

It does not restart services, SSH to a server, print environment variables, or expose raw command stderr.

`/ppo vps-health` remains future work and is not routed in Phase 4A.

## Automated Validation

Run from the repo root:

```bash
node deployment/vps-health.test.mjs
bash -n deployment/scripts/bootstrap-ubuntu-24.04.sh
bash -n deployment/scripts/install-or-update-repo.sh
bash -n deployment/scripts/service-control.sh
bash -n deployment/scripts/firewall-ssh-hardening.sh
bash -n deployment/scripts/rollback-repo.sh
node --check deployment/scripts/vps-health.mjs
```

These checks are local/static. They do not perform live deployment.

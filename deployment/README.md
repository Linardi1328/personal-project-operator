# Phase 4A VPS Deployment Foundation

Phase 4A adds reviewed deployment foundation files for a future Ubuntu VPS. It does not deploy a live server from this repository.

Phase 6H adds the first autonomous deployment agent boundary for the already reviewed PPO service. It is exact-SHA pinned, starts only from a Phase 6A run in `merged`, deploys only the Phase 6G merge commit SHA through the fixed PPO profile, and stops at `deployed`.

Phase 6I adds the separate local-only read-only production verification boundary after Phase 6H. It verifies only the exact deployed SHA and does not redeploy, restart, rollback, or refresh Git refs.

Target host:

- Ubuntu 24.04 LTS
- 2 vCPU / 4 GB RAM class VPS
- OpenClaw running persistently under `systemd`
- Personal Project Operator checked out at `/opt/personal-project-operator`
- OpenClaw local-prefix runtime under `/home/ppo/.local/openclaw`
- one existing OpenClaw plugin tool: `ppo_local`

## Safety Boundary

Phase 4A files are server-local bootstrap materials only.

- No live SSH is performed by these scripts.
- No Telegram API behavior changes are introduced.
- No GitHub write endpoint, GraphQL endpoint, or new endpoint family is added by the deployment files. Phase 5B runtime issue creation remains limited to the reviewed `/ppo issue-create` plus `/ppo issue-confirm` workflow. Phase 5D runtime note creation remains limited to the reviewed `/ppo note-add` plus `/ppo note-confirm` local approval workflow.
- No Codex, ChatGPT, OpenAI API, or model call is made.
- No deployment is performed by automated tests.
- Phase 6H does not automatically rollback, run production verification, run health validation, add `/ppo continue`, or add Telegram/OpenClaw routes.
- No credentials, tokens, private keys, host addresses, or real secrets belong in this repository.
- `/ppo vps-health` is not routed through OpenClaw yet.

## Files

- `deployment/systemd/ppo-openclaw.service`: systemd unit template for OpenClaw.
- `deployment/logrotate/ppo-openclaw`: logrotate template for optional file logs.
- `deployment/scripts/bootstrap-ubuntu-24.04.sh`: installs OS packages, creates the non-root service user, creates directories, and installs systemd/logrotate templates.
- `deployment/scripts/preflight-openclaw-runtime.sh`: fail-closed service preflight for the supported local-prefix Node/OpenClaw runtime.
- `deployment/scripts/prepare-khlim-development-runtime.sh`: confirmation-gated installation of a root-owned Node 24 test runtime plus clone or fast-forward synchronization for the fixed KHLIM Super App ordinary-development source path.
- `deployment/scripts/install-or-update-repo.sh`: installs or updates the PPO checkout from the fixed main branch.
- `deployment/scripts/deploy-exact-sha.sh`: Phase 6H exact-SHA PPO deployment primitive for a trusted Phase 6G merge commit.
- `deployment/scripts/verify-production-readonly.sh`: Phase 6I read-only production verification primitive for the exact Phase 6H deployed SHA.
- `deployment/scripts/verify-ppo-local-help.mjs`: helper used by the Phase 6I primitive to exercise deployed `ppo_local help` through the bridge.
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
- `ufw`
- `logrotate`
- `iproute2`

Ubuntu 24.04 apt `nodejs` is intentionally not installed because that package provides Node 18, which is not the supported Phase 4A runtime target.

OpenClaw itself remains installed/configured by the owner according to OpenClaw's current installation process. This repository does not vendor OpenClaw and does not edit `~/.openclaw` automatically.

## OpenClaw Local-Prefix Runtime Layout

Phase 4A uses the current official `install-cli.sh` local-prefix layout:

```text
/home/ppo/.local/openclaw/tools/node/bin/node
/home/ppo/.local/openclaw/bin/openclaw
```

Install OpenClaw for the `ppo` user into that prefix before starting the systemd service:

```bash
sudo -u ppo env HOME=/home/ppo bash -lc 'curl -fsSL --proto "=https" --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /home/ppo/.local/openclaw --no-onboard'
```

Do not run onboarding before service configuration. Configure the service environment, skill root, plugin, and `ppo_local` tool policy first.

The service sets:

```text
PATH=/home/ppo/.local/openclaw/tools/node/bin:/home/ppo/.local/openclaw/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data
PPO_GITHUB_WRITE_AUDIT_PATH=/var/lib/personal-project-operator/audit/github-write-audit.ndjson
```

Phase 5C/5D project notes use the same non-secret `PPO_WRITE_DATA_DIR` root. Append-only note files live under `/var/lib/personal-project-operator/write-data/project-notes`; Phase 5D pending note requests live temporarily under `/var/lib/personal-project-operator/write-data/pending-project-notes`.

The systemd unit runs this preflight before service start:

```text
ExecStartPre=/opt/personal-project-operator/deployment/scripts/preflight-openclaw-runtime.sh
```

The preflight exits with status `78` when the local-prefix Node/OpenClaw runtime is missing or unsupported. The unit includes `RestartPreventExitStatus=78`, so systemd does not repeatedly restart a misprovisioned service. Repair remains owner-operated through `OPENCLAW_SERVICE_REPAIR_POLICY=external`.

Supported Node ranges are enforced exactly:

- Node 22.22.3+
- Node 24.15+
- Node 25.9+
- Node 26+

Node 20, 21, 23, and too-old 22/24/25 releases are rejected.

## KHLIM Ordinary-Development Runtime

After the PPO release containing KHLIM Super App ordinary-development support is deployed, prepare its fixed source checkout and root-owned Node 24 test runtime once:

```bash
sudo env PPO_KHLIM_RUNTIME_CONFIRM=prepare-khlim-development-runtime \
  /opt/personal-project-operator/deployment/scripts/prepare-khlim-development-runtime.sh
```

The command refuses an unclean or mismatched checkout and performs only a fast-forward update of `main`. It copies the supported OpenClaw-bundled Node executable into the fixed root-owned Phase 6K tools path; development runs cannot replace that trusted test executable.

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
ExecStart=/home/ppo/.local/openclaw/bin/openclaw gateway run
Restart=on-failure
RestartPreventExitStatus=78
```

The foreground command is `openclaw gateway run`. The unit must not use `openclaw gateway start`, because that subcommand manages a service rather than remaining in the foreground for this system-level unit.

The systemd unit itself remains installed under `/etc/systemd/system` and owned by root.

## Secrets And Environment Variables

Store service environment outside the repo:

```text
/etc/personal-project-operator/openclaw.env
```

Rules:

- keep the file owned by root with restrictive permissions
- configure only values required by OpenClaw or its connected providers
- authenticate `gh` as the service user outside this repository when GitHub read-only commands are needed
- keep Phase 5B write-data path variables pointed at private directories under `/var/lib/personal-project-operator`
- keep Phase 5C/5D project notes under the same private write-data root
- never paste credentials into Markdown, tests, fixtures, logs, commits, or chat
- do not commit `.env` files or copied service environment files

The systemd unit sets the non-secret Phase 5B/5D write-data paths directly:

```text
PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data
PPO_GITHUB_WRITE_AUDIT_PATH=/var/lib/personal-project-operator/audit/github-write-audit.ndjson
```

Do not configure or paste terminal write confirmation environment values in OpenClaw chat. `/ppo issue-confirm <request-id>` supplies the Phase 5A confirmation internally after a pending request has been atomically claimed.

`PPO_NOTE_WRITE_CONFIRM=add-note:<project>` is terminal-only and must not be configured in OpenClaw chat. Phase 5D `/ppo note-confirm <request-id>` supplies the Phase 5C confirmation internally after a pending request has been atomically claimed.

## Owner-Only VPS Bootstrap

Run these only on the reviewed VPS after branch approval. They are not automated tests.

```bash
sudo PPO_BOOTSTRAP_CONFIRM=ubuntu-24.04-vps deployment/scripts/bootstrap-ubuntu-24.04.sh
sudo PPO_REPO_UPDATE_CONFIRM=install-or-update-main deployment/scripts/install-or-update-repo.sh
```

Then manually install/configure the OpenClaw local-prefix runtime for the service user:

- install OpenClaw with the official command above
- confirm bundled Node at `/home/ppo/.local/openclaw/tools/node/bin/node`
- install OpenClaw at `/home/ppo/.local/openclaw/bin/openclaw`
- confirm with `sudo -u ppo /home/ppo/.local/openclaw/tools/node/bin/node --version`
- confirm with `sudo -u ppo /home/ppo/.local/openclaw/bin/openclaw --version`

Then manually configure OpenClaw for the service user:

- load the skill root from `/opt/personal-project-operator/openclaw/skills`
- link the plugin from `/opt/personal-project-operator/openclaw/plugins/ppo-local`
- keep the tool surface limited to `ppo_local`
- keep `command-dispatch: tool`, `command-tool: ppo_local`, and `command-arg-mode: raw`

Do not use `group:plugins`, wildcard tool permissions, or a generic GitHub tool.

## Phase 6H Exact-SHA Deployment

Phase 6H uses [deployment/scripts/deploy-exact-sha.sh](scripts/deploy-exact-sha.sh) through [local-operator/development-deployment-agent.mjs](../local-operator/development-deployment-agent.mjs). The agent supplies the expected SHA from durable Phase 6G `merged` evidence only.

The script:

- accepts exactly one full lowercase 40-character SHA
- verifies `/opt/personal-project-operator` is the approved PPO repository checkout
- fetches the fixed `origin main`
- verifies the expected SHA is a commit reachable from `origin/main`
- records the previously installed revision when available
- checks out exactly the expected SHA in detached HEAD state
- restores root/`ppo` checkout ownership and executable modes
- runs the approved OpenClaw runtime preflight
- restarts only `ppo-openclaw.service` through the reviewed service-control script
- re-reads checkout HEAD and requires it to equal the expected SHA

It does not use `git pull` as final deployment selection, does not accept arbitrary remotes or services, does not invoke rollback, and does not run `vps-health.mjs` as production verification.

## Phase 6I Read-Only Production Verification

Phase 6I uses [deployment/scripts/verify-production-readonly.sh](scripts/verify-production-readonly.sh) through [local-operator/development-production-verification-agent.mjs](../local-operator/development-production-verification-agent.mjs). The agent supplies the expected SHA only from durable Phase 6H `deployed` evidence.

The script checks fixed read-only production facts: approved repository origin, exact detached checkout HEAD, clean worktree, previous-revision marker when applicable, OpenClaw runtime preflight, OpenClaw version, fixed systemd service state and identity, reviewed unit match, production permission contract, and deployed `ppo_local help` bridge execution.

It does not fetch, pull, checkout, switch, reset, mutate files, change permissions, change configuration, restart services, invoke rollback, install packages, call GitHub writes, invoke Codex/models, SSH elsewhere, or expose command output.

## Repo Ownership Model

The checkout at `/opt/personal-project-operator` is root-owned and read-only to the runtime user.

- `install-or-update-repo.sh` runs git clone/fetch/pull as root.
- after install/update, the script enforces root ownership and read/execute permissions.
- `ppo` may read and execute the wrapper but must not mutate the checkout.
- the systemd unit does not include `/opt/personal-project-operator` in `ReadWritePaths`.
- writable runtime paths are limited to `/home/ppo`, `/var/lib/personal-project-operator`, and `/var/log/personal-project-operator`.
- Phase 5B pending request directories under `/var/lib/personal-project-operator/write-data` are created with `0700`, and pending request files are created with `0600`.
- Phase 5B audit records are written to `/var/lib/personal-project-operator/audit/github-write-audit.ndjson` without title/body contents, request ids, tokens, or confirmation values.
- Phase 5C note directories under `/var/lib/personal-project-operator/write-data/project-notes` are `0700`, note files are `0600`, and note audit records are metadata-only without note text, confirmation values, request ids, tokens, or raw failures.
- Phase 5D pending note request directories under `/var/lib/personal-project-operator/write-data/pending-project-notes` are `0700`, pending files are `0600`, and pending note content is deleted on confirmation or expiry.

## Phase 5B Issue Approval Storage

`/ppo issue-create <project> <title> [--body <body>]` writes one private pending request under:

```text
/var/lib/personal-project-operator/write-data/pending-github-issues
```

It performs no GitHub call. The response includes the deterministic preview, an opaque one-time request id, the expiry timestamp, and `/ppo issue-confirm <request-id>`.

`/ppo issue-confirm <request-id>` atomically renames one pending file into a claimed path, validates that it has not expired, deletes the claimed file, then invokes the existing Phase 5A issue writer with internal confirmation. Unknown, expired, malformed, already-consumed, or replayed ids perform zero GitHub writes. Requests expire after 10 minutes.

## Phase 5C Project Note Storage

The terminal-only command:

```bash
node local-operator/ppo-command.mjs note-add <project> <note...>
```

stores confirmed append-only notes under:

```text
/var/lib/personal-project-operator/write-data/project-notes
```

The command is not routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It uses exact terminal confirmation, creates private directories/files, appends one fsynced note record per confirmed action, and must not mutate `projects/*.md` or any project-state file.

## Phase 5D Project Note Approval Storage

`/ppo note-add <project> <note...>` writes one private pending request under:

```text
/var/lib/personal-project-operator/write-data/pending-project-notes
```

It performs no note append. The response includes the deterministic preview with project/repo/note length, an opaque one-time request id, the expiry timestamp, and `/ppo note-confirm <request-id>`.

`/ppo note-confirm <request-id>` atomically renames one pending file into a claimed path, validates that it has not expired, deletes the claimed file, then invokes the existing Phase 5C note writer with internal confirmation. Unknown, expired, malformed, already-consumed, or replayed ids perform zero note writes. Requests expire after 10 minutes.

The Phase 5C note audit remains metadata-only and must not include Phase 5D request ids, note text, terminal confirmation values, tokens, or raw failures.

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
- run the script from an active SSH session
- do not paste keys into this repository

Owner-confirmed OpenSSH-only UFW baseline:

```bash
sudo --preserve-env=SSH_CONNECTION PPO_FIREWALL_CONFIRM=openssh-only deployment/scripts/firewall-ssh-hardening.sh
```

The firewall script validates `sshd -t`, detects actual listening `sshd` TCP ports with `ss`, validates the detected ports, verifies the active SSH session is using one of those detected ports, allows those ports first, and fails closed if no listener or matching active session is found. It does not assume port 22 from `authorized_keys`.

SSH daemon settings should be reviewed manually before reload. This repository does not auto-edit SSH daemon configuration.

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

Phase 6H never invokes rollback automatically. Rollback remains owner-confirmed future/manual recovery behavior until a separately reviewed phase defines an automated rollback boundary.

## Health Check Foundation

Local read-only health check:

```bash
/home/ppo/.local/openclaw/tools/node/bin/node /opt/personal-project-operator/deployment/scripts/vps-health.mjs
```

The health checker reports:

- bundled OpenClaw Node.js availability
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
node deployment/deploy-exact-sha.test.mjs
node deployment/vps-health.test.mjs
bash -n deployment/scripts/bootstrap-ubuntu-24.04.sh
bash -n deployment/scripts/preflight-openclaw-runtime.sh
bash -n deployment/scripts/install-or-update-repo.sh
bash -n deployment/scripts/deploy-exact-sha.sh
bash -n deployment/scripts/verify-production-readonly.sh
bash -n deployment/scripts/service-control.sh
bash -n deployment/scripts/firewall-ssh-hardening.sh
bash -n deployment/scripts/rollback-repo.sh
node --check deployment/scripts/vps-health.mjs
node --check deployment/scripts/verify-ppo-local-help.mjs
```

These checks are local/static. They do not perform live deployment.

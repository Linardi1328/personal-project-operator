# VPS Setup

Phase 4A adds a VPS deployment foundation for owner review. It does not deploy a live server from this repository.

Target:

- Ubuntu 24.04 LTS
- 2 vCPU / 4 GB RAM class VPS
- non-root `ppo` service user
- OpenClaw managed by `systemd`
- OpenClaw local-prefix runtime under `/home/ppo/.local/openclaw`
- existing PPO wrapper and existing `ppo_local` plugin tool only

See [../deployment/README.md](../deployment/README.md) for the bootstrap scripts, systemd unit, health check, rollback procedure, and owner-only acceptance steps.

## Phase 4A Boundary

- No live SSH is performed by repo scripts.
- No automated test deploys to a VPS.
- No Telegram API behavior changes are added.
- No GitHub writes, GraphQL, or new endpoint families are added.
- No Codex/model invocation is added.
- No new OpenClaw tool or permission is added.
- `/ppo vps-health` remains future work; Phase 4A provides only the local read-only health-check foundation.

## Service Shape

The reviewed systemd unit is:

```text
deployment/systemd/ppo-openclaw.service
```

It runs OpenClaw as the non-root `ppo` user from:

```text
/opt/personal-project-operator
```

It supervises the foreground gateway:

```text
/home/ppo/.local/openclaw/bin/openclaw gateway run
```

It does not call `openclaw gateway start`.

Service environment is loaded from:

```text
/etc/personal-project-operator/openclaw.env
```

That file must be created and populated on the VPS only. Do not commit secrets or copied environment files.

Runtime preflight is performed before service start:

```text
/opt/personal-project-operator/deployment/scripts/preflight-openclaw-runtime.sh
```

The preflight verifies the owner-installed local-prefix Node/OpenClaw runtime and exits `78` for unsupported provisioning. The systemd unit includes `RestartPreventExitStatus=78` and `OPENCLAW_SERVICE_REPAIR_POLICY=external`.

## Runtime And Checkout Ownership

Do not use Ubuntu 24.04 apt `nodejs` for OpenClaw; that package provides unsupported Node 18. The owner-run layout is:

```text
/home/ppo/.local/openclaw/bin/node
/home/ppo/.local/openclaw/bin/openclaw
```

The PPO checkout at `/opt/personal-project-operator` is root-owned and read-only to `ppo`. Runtime writes are limited to:

```text
/home/ppo
/var/lib/personal-project-operator
/var/log/personal-project-operator
```

The systemd unit remains installed as a root-owned system unit under `/etc/systemd/system`.

## Owner Acceptance Steps

After code review, run the owner-only checklist in [../deployment/README.md](../deployment/README.md):

- bootstrap Ubuntu prerequisites
- install or update the fixed PPO repo checkout
- configure OpenClaw manually for `ppo_local`
- enable and start the `ppo-openclaw.service`
- run the local health check
- verify existing `/ppo` commands through Telegram

Do not run those steps from automated tests.

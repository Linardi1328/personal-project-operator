# VPS Setup

Phase 4A adds a VPS deployment foundation for owner review. It does not deploy a live server from this repository.

Target:

- Ubuntu 24.04 LTS
- 2 vCPU / 4 GB RAM class VPS
- non-root `ppo` service user
- OpenClaw managed by `systemd`
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

Service environment is loaded from:

```text
/etc/personal-project-operator/openclaw.env
```

That file must be created and populated on the VPS only. Do not commit secrets or copied environment files.

## Owner Acceptance Steps

After code review, run the owner-only checklist in [../deployment/README.md](../deployment/README.md):

- bootstrap Ubuntu prerequisites
- install or update the fixed PPO repo checkout
- configure OpenClaw manually for `ppo_local`
- enable and start the `ppo-openclaw.service`
- run the local health check
- verify existing `/ppo` commands through Telegram

Do not run those steps from automated tests.

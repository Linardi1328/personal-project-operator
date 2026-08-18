# /vps-health

## Command name

`/vps-health`

## Purpose

Future command for checking server health after VPS deployment.

Phase 4A adds only a local read-only health-check foundation:

```bash
/home/ppo/.local/openclaw/tools/node/bin/node /opt/personal-project-operator/deployment/scripts/vps-health.mjs
```

It is not routed through OpenClaw/Telegram yet.

The script checks the Phase 4A local-prefix runtime paths:

```text
/home/ppo/.local/openclaw/tools/node/bin/node
/home/ppo/.local/openclaw/bin/openclaw
```

## Input format

```text
/vps-health
```

## Example input

```text
/vps-health
```

## Expected output

```text
VPS Health
- OpenClaw status:
- uptime:
- disk:
- memory:
- last restart:
- GitHub connection:
- chat platform connection:
```

Phase 4A implements the local health-check script only. `/ppo vps-health` remains future routing work.

## Safety boundary

Phase 4A health checks are read-only and must not restart services. They must not SSH to a host, print raw stderr, print environment variables, or expose credentials.

## Future upgrade path

- Route `/ppo vps-health` after separate review.
- Add health-check endpoint or process query if needed.
- Add disk and memory checks.
- Add connection status for GitHub and chat platform.
- Add alerting after explicit approval.

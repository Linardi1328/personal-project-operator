# /vps-health

## Command name

`/vps-health`

## Purpose

Future command for checking server health after VPS deployment.

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

Phase 0 does not implement live checks.

## Safety boundary

Phase 0 documentation only. Future checks should be read-only and must not restart services unless an explicit approved command is created.

## Future upgrade path

- Add health-check endpoint or process query.
- Add disk and memory checks.
- Add connection status for GitHub and chat platform.
- Add alerting after explicit approval.


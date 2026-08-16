# Config Example

This file documents the intended configuration shape for future phases. It is not an executable config file and contains no secrets.

## Environment variables

Use environment variables for secrets and deployment-specific values.

Example names only:

```text
OPENCLAW_ENV=
OPENCLAW_CHAT_PLATFORM=
GITHUB_READONLY_TOKEN=
TELEGRAM_BOT_TOKEN=
PPO_USAGE_STATE_PATH=
PPO_SAFE_MODE=
```

Do not store real values in this repo.

## Suggested non-secret settings

```text
default_project=khlim-assist
safe_mode=true
phase=0
github_write_actions=false
telegram_enabled=false
vps_health_enabled=false
```

## Phase 0 behavior

- Use local Markdown docs only.
- Do not call GitHub.
- Do not call Telegram.
- Do not deploy.
- Do not store credentials.

## Future behavior

Future config may define:

- enabled chat platform
- GitHub read-only access
- local usage state file
- VPS health check endpoint
- allowed command groups
- audit log location


# Example Local Help Run

Run from the repo root:

```bash
node local-operator/simulate-command.mjs /help
```

Expected local output:

```text
Personal Project Operator Help

Use this local simulator to test phone-style command output before OpenClaw routes real chat messages.

Start with:
- /menu
- /status

Supported locally in Phase 1:
- /status
- /menu
- /menu project
- /menu codex
- /menu system
- /help

Examples:
- node local-operator/simulate-command.mjs /status
- node local-operator/simulate-command.mjs /menu system

Safety:
- Local fixture data only
- No GitHub API calls
- No Telegram API calls
- No Codex usage scraping
- No VPS deployment
- No write actions
```


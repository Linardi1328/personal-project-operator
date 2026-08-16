# Example Telegram PPO Help

Telegram message:

```text
/ppo help
```

Expected OpenClaw local route:

```bash
node local-operator/ppo-command.mjs help
```

Expected reply:

```text
Personal Project Operator Help

Use this local simulator to test phone-style command output before OpenClaw routes real chat messages.

Start with:
- /ppo menu
- /ppo status

Supported locally through /ppo in Phase 1.5:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help

Examples:
- node local-operator/ppo-command.mjs status
- node local-operator/ppo-command.mjs menu system

Safety:
- Local fixture data only
- No GitHub API calls
- No Telegram API calls
- No Codex usage scraping
- No VPS deployment
- No write actions
```


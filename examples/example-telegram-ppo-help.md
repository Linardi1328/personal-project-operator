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

Supported through /ppo in Phase 7A:
- /ppo status [github read-only]
- /ppo menu [local]
- /ppo menu project [local]
- /ppo menu codex [local]
- /ppo menu system [local]
- /ppo help [local]
- /ppo repo <project> [github read-only]
- /ppo pr <project> [github read-only]
- /ppo codex <project> <task> [local text]
- /ppo codex-budget <project> <task> [local text]
- /ppo prompt-size <draft> [local text]
- /ppo split-task <task> [local text]
- /ppo issue-create <project> <title> [approval stage]
- /ppo issue-confirm <request-id> [approved write]
- /ppo note-add <project> <note...> [approval stage]
- /ppo note-confirm <request-id> [approved write]
- /ppo start <project> [controlled development start]
- /ppo runs [read-only development catalog]
- /ppo run <run-id> [read-only development summary]
- /ppo cancel <run-id> [approval stage]
- /ppo cancel-confirm <request-id> [approved quiescent cancellation]
- /ppo continue <run-id> [development]
- /ppo recover <run-id> [read-only development recovery]

Examples:
- node local-operator/ppo-command.mjs status
- node local-operator/ppo-command.mjs menu system

Safety:
- /ppo status, /ppo repo, and /ppo pr use GitHub read-only
- /ppo codex and planning commands generate deterministic local text
- /ppo menu and /ppo help use local fixture data
- No Telegram API calls
- No Codex usage scraping
- No VPS deployment
- /ppo issue-create stages locally; /ppo issue-confirm can create one approved GitHub issue after single-use confirmation
- /ppo note-add stages locally; /ppo note-confirm can append one approved local project note after single-use confirmation
- /ppo start creates at most one planned Phase 6B development run and never continues automatically
- /ppo runs and /ppo run expose only bounded Phase 6N ordinary-run catalog metadata
- /ppo cancel stages only; /ppo cancel-confirm can cancel one eligible quiescent run after single-use confirmation
- /ppo continue advances one existing ordinary development run through at most one reviewed Phase 6B-6G boundary
- /ppo recover reports one read-only Phase 6L development recovery observation and never repairs, retries, or continues the run
```

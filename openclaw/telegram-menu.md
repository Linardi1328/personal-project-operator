# Telegram Menu

This document describes how Telegram should expose Personal Project Operator commands in a future phase.

Phase 0 does not register commands with Telegram and does not call Telegram APIs.

## Native Telegram command menu examples

```text
status - Show all active projects
next - Recommend next project priority
repo - Summarize a project repository
pr - Summarize latest project PR
codex - Generate compact Codex prompt
codex_usage - Check Codex usage status
codex_budget - Estimate Codex task size
menu - Show command menu
help - Explain commands
safe_mode - Show safety boundaries
vps_health - Check server health
```

Telegram command names may need underscores instead of hyphens for platform compatibility, while the operator can still document canonical slash commands such as `/codex-usage`.

## Future inline-button menu

```text
[ Project Control ]
[ Codex Workflow ]
[ Usage & Limits ]
[ VPS / Safety ]
[ Backlog ]
```

## Project Control

- `/status`
- `/next`
- `/repo <project>`
- `/pr <project>`
- `/handoff <project>`

## Codex Workflow

- `/codex <project> <phase-or-task>`
- `/codex-budget <project> <task>`
- `/prompt-size <draft>`
- `/split-task <task>`

## Usage & Limits

- `/codex-usage`
- `/update-usage <provider> <status>`

## VPS / Safety

- `/vps-health`
- `/safe-mode`
- `/help`

## Backlog

- `/content <project>`
- `/feature-request <idea>`
- `/backlog`

## Safety

Inline buttons should only prefill or request confirmation for commands. They must not execute write actions in Phase 0.


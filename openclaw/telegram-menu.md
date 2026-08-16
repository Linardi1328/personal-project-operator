# Telegram Menu

This document describes how Telegram should expose Personal Project Operator commands.

Phase 1.5 uses the `/ppo` namespace because OpenClaw owns built-in commands such as `/status`, `/menu`, and `/help`.

This repo does not register commands with Telegram and does not call Telegram APIs.

## Native Telegram command menu examples

```text
ppo - Personal Project Operator command namespace
```

Expected message forms:

```text
/ppo status - Show all active projects
/ppo next - Recommend next project priority
/ppo repo <project> - Summarize a project repository
/ppo pr <project> - Summarize latest project PR
/ppo codex <project> <task> - Generate compact Codex prompt
/ppo codex-usage - Check Codex usage status
/ppo codex-budget <project> <task> - Estimate Codex task size
/ppo menu - Show command menu
/ppo help - Explain commands
/ppo safe-mode - Show safety boundaries
/ppo vps-health - Check server health
```

## Future inline-button menu

```text
[ Project Control ]
[ Codex Workflow ]
[ Usage & Limits ]
[ VPS / Safety ]
[ Backlog ]
```

## Project Control

- `/ppo status`
- `/ppo next`
- `/ppo repo <project>`
- `/ppo pr <project>`
- `/ppo handoff <project>`

## Codex Workflow

- `/ppo codex <project> <phase-or-task>`
- `/ppo codex-budget <project> <task>`
- `/ppo prompt-size <draft>`
- `/ppo split-task <task>`

## Usage & Limits

- `/ppo codex-usage`
- `/ppo update-usage <provider> <status>`

## VPS / Safety

- `/ppo vps-health`
- `/ppo safe-mode`
- `/ppo help`

## Backlog

- `/ppo content <project>`
- `/ppo feature-request <idea>`
- `/ppo backlog`

## Safety

Inline buttons should only prefill or request confirmation for commands. They must not execute write actions in Phase 1.5.

Do not override OpenClaw built-ins:

```text
/status
/menu
/help
```

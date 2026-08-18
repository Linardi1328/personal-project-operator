# Telegram Menu

This document describes how Telegram should expose Personal Project Operator commands.

Phase 3C extends the `/ppo` Telegram surface for deterministic Codex text commands while OpenClaw still owns built-in commands such as `/status`, `/menu`, and `/help`.

This repo does not register commands with Telegram and does not call Telegram APIs.

## Native Telegram command menu examples

```text
ppo - Personal Project Operator command namespace
```

Expected message forms:

```text
/ppo status - Show live GitHub project status [github read-only]
/ppo next - Recommend next project priority
/ppo repo <project> - Summarize a project repository [github read-only]
/ppo pr <project> - Summarize latest project PR [github read-only]
/ppo codex <project> <task> - Generate deterministic Codex prompt text
/ppo codex-usage - Check Codex usage status
/ppo codex-budget <project> <task> - Estimate deterministic Codex task size
/ppo prompt-size <draft> - Review prompt draft size and exact repetition
/ppo split-task <task> - Split broad work into deterministic planning phases
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

- `/ppo codex <project> <phase-or-task>` (Phase 3C direct route)
- `/ppo codex-budget <project> <task>` (Phase 3C direct route)
- `/ppo prompt-size <draft>` (Phase 3C direct route)
- `/ppo split-task <task>` (Phase 3C direct route)

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

Inline buttons should only prefill or request confirmation for commands. They must not execute write actions in Phase 3C.

Phase 3C Codex commands generate deterministic text only. They must not invoke Codex, call a model, perform GitHub writes, deploy services, or create new OpenClaw tool permissions.

Do not override OpenClaw built-ins:

```text
/status
/menu
/help
```

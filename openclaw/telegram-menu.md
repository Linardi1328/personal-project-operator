# Telegram Menu

This document describes how Telegram should expose Personal Project Operator commands.

Phase 7A exposes controlled ordinary-run start alongside confirmation-gated quiescent cancellation, controlled read-only development run catalog routes, controlled development continuation, and read-only recovery through `/ppo` while OpenClaw still owns built-in commands such as `/status`, `/menu`, and `/help`. `/ppo start <project>` creates at most one planned Phase 6B run and returns `/ppo continue <run-id>` as the next command without continuing automatically. `/ppo runs` lists bounded ordinary-run catalog summaries. `/ppo run <run-id>` returns one bounded ordinary-run summary. `/ppo cancel <run-id>` stages a single-use cancellation request for eligible quiescent ordinary runs. `/ppo cancel-confirm <request-id>` confirms one staged cancellation. `/ppo continue <run-id>` advances at most one existing reviewed Phase 6B-6G boundary for ordinary runs. `/ppo recover <run-id>` returns one reviewed Phase 6L read-only recovery observation. The start, catalog, and recovery routes do not perform production deployment, verification, or rollback; cancellation does not interrupt processes or clean workspaces.

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
/ppo issue-create <project> <title> [--body <body>] - Stage a GitHub issue for confirmation
/ppo issue-confirm <request-id> - Confirm one staged issue creation request
/ppo note-add <project> <note...> - Stage a project note for confirmation
/ppo note-confirm <request-id> - Confirm one staged project note request
/ppo start <project> - Create one planned ordinary development run
/ppo runs - List read-only development catalog summaries
/ppo run <run-id> - Inspect one read-only development summary
/ppo cancel <run-id> - Stage a quiescent development run cancellation request
/ppo cancel-confirm <request-id> - Confirm one staged quiescent cancellation request
/ppo continue <run-id> - Continue one existing ordinary development run through one reviewed boundary
/ppo recover <run-id> - Inspect one existing ordinary development run through one read-only recovery boundary
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
- `/ppo issue-create <project> <title> [--body <body>]` (Phase 5B staging only)
- `/ppo issue-confirm <request-id>` (Phase 5B single-use confirmation)
- `/ppo note-add <project> <note...>` (Phase 5D staging only)
- `/ppo note-confirm <request-id>` (Phase 5D single-use confirmation)
- `/ppo start <project>` (Phase 7A controlled start only)
- `/ppo runs` (Phase 6O read-only development catalog)
- `/ppo run <run-id>` (Phase 6O read-only development summary)
- `/ppo cancel <run-id>` (Phase 6P staging only)
- `/ppo cancel-confirm <request-id>` (Phase 6P single-use quiescent cancellation)
- `/ppo continue <run-id>` (Phase 6K one-boundary ordinary development continue)
- `/ppo recover <run-id>` (Phase 6M read-only ordinary development recovery)
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

Inline buttons may prefill `/ppo issue-create` or `/ppo issue-confirm`, but they must not bypass the request id confirmation step.

Inline buttons may prefill `/ppo note-add` or `/ppo note-confirm`, but they must not bypass the request id confirmation step.

Phase 7A keeps one OpenClaw tool: `ppo_local`. `issue-create` performs no GitHub write; `issue-confirm` can create only one approved GitHub issue after atomically claiming an unexpired one-time id. `note-add` performs no note write; `note-confirm` can append only one approved local note after atomically claiming an unexpired one-time id. `start` accepts only one allowlisted project id, reuses Phase 6B planned-run creation once, and never continues automatically. `runs` and `run` expose only the Phase 6N read-only ordinary-run catalog with no filters, search, sort, retry, repair, recovery, continue, cancellation, production action, or model interpretation. `cancel` stages only and `cancel-confirm` can cancel exactly one eligible quiescent ordinary run after single-use confirmation; they do not interrupt processes, clean workspaces, retry, repair, recover, continue, or touch production. `continue` accepts only an existing run id and delegates to one reviewed Phase 6B-6G boundary. `recover` accepts only an existing run id and delegates to one reviewed Phase 6L read-only recovery boundary. The chat path must not accept or expose terminal write confirmation environment values, rollback confirmations, production services, deployment targets, actions, task text, runtime options, branches, repositories, SHAs, recovery options, commands, cleanup options, or executables.

Do not override OpenClaw built-ins:

```text
/status
/menu
/help
```

# Personal Project Operator Skill

## Purpose

Personal Project Operator is an OpenClaw skill concept for controlling personal software project workflows from a phone.

It should help the user:

- inspect project status
- choose the next project to work on
- summarize repos and PRs in future read-only phases
- stage and confirm tightly scoped GitHub issue creation after approval
- keep project note creation terminal-only until a later reviewed chat workflow exists
- inspect bounded read-only ordinary development run catalog metadata
- stage and confirm quiescent ordinary development run cancellation
- continue one existing ordinary development run through one reviewed boundary
- generate compact Codex prompts
- track Codex usage manually
- understand safe and blocked actions
- prepare future VPS monitoring

Phase 0 defines the behavior only. It does not implement a live OpenClaw skill.

## Supported commands

Project Control:

- `/ppo status`
- `/ppo next`
- `/ppo repo <project>`
- `/ppo pr <project>`
- `/ppo issue-create <project> <title> [--body <body>]`
- `/ppo issue-confirm <request-id>`
- `/ppo runs`
- `/ppo run <run-id>`
- `/ppo cancel <run-id>`
- `/ppo cancel-confirm <request-id>`
- `/ppo continue <run-id>`
- `/ppo handoff <project>`

Codex Workflow:

- `/ppo codex <project> <phase-or-task>`
- `/ppo codex-budget <project> <task>`
- `/ppo prompt-size <draft>`
- `/ppo split-task <task>`

Usage & Limits:

- `/ppo codex-usage`
- `/ppo update-usage <provider> <status>`

System & Safety:

- `/ppo vps-health`
- `/ppo safe-mode`
- `/ppo menu`
- `/ppo help`

Expansion:

- `/ppo content <project>`
- `/ppo feature-request <idea>`
- `/ppo backlog`

## Project registry

Current connected candidates:

- `khlim-assist`: `Linardi1328/khlim-assist`
- `ledgerpilot-ai`: `Linardi1328/ledgerpilot-ai`
- `spy-market-agent`: `Linardi1328/spy-market-agent`
- `portfolio`: `Linardi1328/richie-linardi-portfolio-website`
- `rbl-content-engine`: `Linardi1328/rbl-content-engine`

## Safety boundaries

The skill is read-only-first.

Blocked by default:

- merge PRs
- push code
- delete branches
- deploy production changes
- send customer messages
- expose secrets
- change credentials
- execute trades
- make paid API calls without approval

## Read-only-first rule

The skill may summarize local documentation in Phase 0. Future phases may add read-only GitHub and system checks.

For OpenClaw routing, Personal Project Operator uses the `/ppo` namespace. Do not override OpenClaw built-in `/status`, `/menu`, or `/help`.

Write actions must remain disabled unless:

- the action is listed in the command registry
- the phase allows it
- explicit user approval is captured
- the action is auditable

Phase 5B permits only the listed `/ppo issue-create` staging command and `/ppo issue-confirm` single-use confirmation command.

Phase 5D permits only the listed `/ppo note-add` staging command and `/ppo note-confirm` single-use confirmation command through the same existing `ppo_local` tool. It does not add comments, labels, assignees, milestones, PRs, branches, commits, merges, workflow dispatches, project-state mutations, deployments, or new OpenClaw tools. Stored notes must not mutate project-state files automatically.

Phase 6K permits only `/ppo continue <run-id>` for existing ordinary five-project Phase 6 development runs. It advances at most one reviewed Phase 6B-6G boundary per invocation and does not route PPO production deployment, verification, rollback, rollback reconciliation, services, or owner confirmations through OpenClaw.

Phase 6O permits `/ppo runs` and `/ppo run <run-id>` only as read-only Phase 6N ordinary-run catalog routes. They expose bounded metadata summaries only and do not accept filters, search, sort, recovery, continue, cancellation, retry, repair, production action, or model interpretation.

Phase 6P permits `/ppo cancel <run-id>` and `/ppo cancel-confirm <request-id>` only as confirmation-gated quiescent cancellation routes for eligible ordinary five-project Phase 6 development runs. It does not interrupt processes, clean workspaces, retry, repair, recover, continue, cancel production, or route PPO production deployment, verification, rollback, services, or owner rollback confirmations through OpenClaw.

Phase 7A permits `/ppo start <project>` only for one allowlisted ordinary project id. It reuses Phase 6B `createPlannedDevelopmentRun(projectId)` once with no caller-controlled route options, creates at most one planned run, returns `/ppo continue <run-id>` only after strict planned-result validation, and does not automatically continue, create workspaces, invoke Codex, run tests/review, push, create PRs, merge, deploy, verify production, rollback, add a new OpenClaw tool, or use model interpretation.

## Expected future tool integrations

- OpenClaw command routing
- Telegram or another chat platform
- GitHub read-only API access
- local project memory files
- Codex prompt templates
- manual Codex usage state
- VPS health checks

## Phone-first usage examples

```text
/ppo menu
/ppo status
/ppo next
/ppo repo khlim-assist
/ppo pr ledgerpilot-ai
/ppo issue-create khlim-assist Document provider validation --body Add owner-visible test notes
/ppo issue-confirm <request-id>
/ppo codex spy-market-agent hardening
/ppo codex-usage
/ppo safe-mode
```

Outputs should be concise, scannable, and decision-oriented.

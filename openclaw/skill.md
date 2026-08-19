# Personal Project Operator Skill

## Purpose

Personal Project Operator is an OpenClaw skill concept for controlling personal software project workflows from a phone.

It should help the user:

- inspect project status
- choose the next project to work on
- summarize repos and PRs in future read-only phases
- stage and confirm tightly scoped GitHub issue creation after approval
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

Phase 5B permits only the listed `/ppo issue-create` staging command and `/ppo issue-confirm` single-use confirmation command. It does not add comments, labels, assignees, milestones, PRs, branches, commits, merges, workflow dispatches, project-state mutations, deployments, or new OpenClaw tools.

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

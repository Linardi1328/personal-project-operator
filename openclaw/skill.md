# Personal Project Operator Skill

## Purpose

Personal Project Operator is an OpenClaw skill concept for controlling personal software project workflows from a phone.

It should help the user:

- inspect project status
- choose the next project to work on
- summarize repos and PRs in future read-only phases
- generate compact Codex prompts
- track Codex usage manually
- understand safe and blocked actions
- prepare future VPS monitoring

Phase 0 defines the behavior only. It does not implement a live OpenClaw skill.

## Supported commands

Project Control:

- `/status`
- `/next`
- `/repo <project>`
- `/pr <project>`
- `/handoff <project>`

Codex Workflow:

- `/codex <project> <phase-or-task>`
- `/codex-budget <project> <task>`
- `/prompt-size <draft>`
- `/split-task <task>`

Usage & Limits:

- `/codex-usage`
- `/update-usage <provider> <status>`

System & Safety:

- `/vps-health`
- `/safe-mode`
- `/menu`
- `/help`

Expansion:

- `/content <project>`
- `/feature-request <idea>`
- `/backlog`

## Project registry

Current connected candidates:

- `khlim-assist`: `Linardi1328/khlim-assist`
- `ledgerpilot-ai`: `Linardi1328/ledgerpilot-ai`
- `spy-market-agent`: `Linardi1328/spy-market-agent`
- `portfolio`: `Linardi1328/richie-linardi-portfolio-website`

Future placeholders:

- `rbl-content-engine`: not connected yet
- `prooflab`: not connected yet
- `jom-jelajah`: not connected yet

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

Write actions must remain disabled unless:

- the action is listed in the command registry
- the phase allows it
- explicit user approval is captured
- the action is auditable

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
/menu
/status
/next
/repo khlim-assist
/pr ledgerpilot-ai
/codex spy-market-agent hardening
/codex-usage
/safe-mode
```

Outputs should be concise, scannable, and decision-oriented.


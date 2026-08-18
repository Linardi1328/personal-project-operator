# Read-Only First

## Principle

Personal Project Operator should begin by reading and summarizing project state. It should not change repos, deployments, accounts, messages, or financial systems by default.

## Phase 0

Allowed:

- local Markdown docs
- command behavior documentation
- prompt templates
- usage tracking design
- safety policy design

Not allowed:

- live GitHub calls
- live OpenClaw actions
- Telegram API setup
- VPS deployment
- usage scraping
- credential storage
- customer messaging
- production deployment
- trading execution

## Phase 1

Allowed:

- local command simulation for `/status`, `/menu`, and `/help`
- local `/ppo` wrapper for OpenClaw Telegram routing preparation
- local JSON fixtures
- phone-style mock output examples
- OpenClaw routing preparation docs

Not allowed:

- live GitHub calls
- Telegram API calls or command registration
- Codex usage scraping
- VPS deployment
- credential storage
- write actions
- automatic edits to `~/.openclaw`
- overriding OpenClaw built-in `/status`, `/menu`, or `/help`

## Phase 2A

Allowed:

- local terminal-only GitHub read-only validation
- repo metadata reads
- recent commit reads
- open PR reads
- open issue reads
- compact project snapshots
- fixed project allowlist lookup

Not allowed:

- Telegram-routed GitHub commands
- arbitrary owner/repo input from external commands
- GitHub write actions
- GitHub API methods other than explicit GET, including POST, PUT, PATCH, or DELETE
- shell execution for `gh`
- credential storage or logging
- branch creation in target project repos
- workflow dispatch
- comments, labels, reviews, approvals, closes, merges, commits, or pushes

## Future read-only integrations

Future safe integrations may read:

- GitHub repo metadata
- recent commits
- open PRs
- issues
- CI/check status
- VPS health status

## Phase 5A controlled write exception

Phase 5A allows one write action only after exact terminal confirmation:

- `issue-create <project> <title> [body...]`

This exception is limited to `POST /repos/<approved repo>/issues` for registry projects, with `title` and `body` fields only. It must write a credential-free audit record and must not be routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram.

## Future write actions

Write actions must be treated as separate features, not automatic extensions of read-only commands.

Examples requiring explicit approval:

- creating GitHub issues outside the Phase 5A terminal-only path
- updating project state files
- restarting services
- publishing content
- sending messages

## Operator response rule

When a command asks for something blocked, the operator should explain:

- what is blocked
- why it is blocked
- what safe alternative is available
- what approval or future phase would be required

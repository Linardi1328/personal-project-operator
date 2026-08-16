# Local Setup

## Purpose

Phase 1 local setup should prove that OpenClaw can route phone/chat commands to Personal Project Operator behavior without connecting risky write actions.

The repo now includes a local-only command simulator so command output can be tested before OpenClaw is connected.

## MacBook/local test assumptions

- Development happens on a local MacBook first.
- The repo is cloned locally.
- Node.js is available locally.
- OpenClaw is installed separately by the user when needed.
- No OpenClaw package is installed inside this repo.
- No secrets are required for the local simulator.

## What should be tested locally

- `/status`
- `/menu`
- `/help`
- command parsing
- menu category handling
- phone-friendly response length
- safe-mode messaging

## Local simulator commands

Run from the repo root:

```bash
node local-operator/simulate-command.mjs /status
node local-operator/simulate-command.mjs /menu
node local-operator/simulate-command.mjs /menu project
node local-operator/simulate-command.mjs /menu codex
node local-operator/simulate-command.mjs /menu system
node local-operator/simulate-command.mjs /help
```

The simulator reads only:

- `local-operator/project-state.json`
- `local-operator/commands.json`

## What should not be connected yet

- live GitHub API access
- GitHub write access
- Telegram API registration
- production deployment
- customer messaging
- trading execution
- paid API calls
- credential-changing actions
- automatic Codex usage scraping
- VPS deployment

## Phase 1 local test checklist

- Confirm the local simulator runs with Node.js.
- Confirm `/menu` returns grouped commands.
- Confirm `/menu project`, `/menu codex`, and `/menu system` return filtered groups.
- Confirm `/help` explains phone usage.
- Confirm `/status` uses local mock project state.
- Confirm unsupported commands fail safely.
- Confirm no GitHub API calls are made.
- Confirm no Telegram API calls are made.
- Confirm no Codex usage scraping is attempted.
- Confirm no secrets are required or printed.

## Telegram local test preparation notes

Telegram testing should start as a routing exercise only.

Before connecting Telegram:

- Confirm the local simulator output is acceptable on a phone.
- Decide whether Telegram command names use hyphens or underscores.
- Map Telegram command text to the local commands:
  - `/status`
  - `/menu`
  - `/help`
- Keep Telegram API registration disabled until the local outputs are approved.
- Do not add a real bot token to the repo.

Future local Telegram routing should behave like:

```text
Telegram message -> OpenClaw local route -> local operator command -> text response
```

The first Telegram test should use only `/status`, `/menu`, and `/help`.

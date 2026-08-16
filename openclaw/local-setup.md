# Local Setup

## Purpose

Phase 1 local setup should prove that command outputs are phone-friendly without connecting risky write actions.

Phase 1.5 prepares OpenClaw Telegram routing through a custom `/ppo` namespace.

The repo now includes a local-only command simulator so command output can be tested before OpenClaw is connected.

## MacBook/local test assumptions

- Development happens on a local MacBook first.
- The repo is cloned locally.
- Node.js is available locally.
- OpenClaw is installed separately by the user when needed.
- No OpenClaw package is installed inside this repo.
- No secrets are required for the local simulator.
- The repo must not modify `~/.openclaw` automatically.

## What should be tested locally

- terminal simulator output for `/status`, `/menu`, and `/help`
- PPO wrapper output for `/ppo status`, `/ppo menu`, and `/ppo help`
- PPO command parsing
- PPO menu category handling
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

## PPO wrapper commands

Use these for OpenClaw Telegram routing preparation:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
node local-operator/ppo-command.mjs unknown
```

Telegram/OpenClaw message shape:

```text
/ppo status
/ppo menu
/ppo menu project
/ppo menu codex
/ppo menu system
/ppo help
```

Do not override OpenClaw built-ins:

```text
/status
/menu
/help
```

The OpenClaw skill uses `{baseDir}/../../../local-operator/ppo-command.mjs` so it does not depend on OpenClaw's current working directory. For the manual owner test, load the repo skill tree in place from `<ppo-repo>/openclaw/skills`; see [openclaw/skills/ppo/install-local.md](skills/ppo/install-local.md).

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

## Phase 1.5 local routing checklist

- Confirm the PPO wrapper runs with Node.js.
- Confirm `/ppo status` maps to local status output.
- Confirm `/ppo menu` maps to local menu output.
- Confirm `/ppo menu project`, `/ppo menu codex`, and `/ppo menu system` return filtered groups.
- Confirm `/ppo help` explains the local PPO workflow.
- Confirm unknown PPO commands fail safely.
- Confirm output command hints use `/ppo`.
- Confirm OpenClaw built-ins are not overridden.
- Confirm no files under `~/.openclaw` are modified by repo code.

## Telegram local test preparation notes

Telegram testing should stay a routing exercise only.

Before routing PPO commands through Telegram:

- Confirm OpenClaw and Telegram are already connected locally.
- Confirm the PPO wrapper output is acceptable on a phone.
- Map Telegram command text to the local wrapper:
  - `/ppo status`
  - `/ppo menu`
  - `/ppo menu project`
  - `/ppo menu codex`
  - `/ppo menu system`
  - `/ppo help`
- Keep Telegram API registration and token handling outside this repo.
- Do not add a real bot token to the repo.

Future local Telegram routing should behave like:

```text
Telegram message -> OpenClaw local /ppo route -> local operator wrapper -> text response
```

The first Telegram test should use only `/ppo status`, `/ppo menu`, and `/ppo help`.

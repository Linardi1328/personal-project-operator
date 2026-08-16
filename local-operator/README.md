# Local Operator Simulator

This folder contains the Phase 1 local-only command simulator for Personal Project Operator.

It lets you test phone-style command outputs before OpenClaw routes real chat messages.

## What it supports

Phase 1 terminal simulator:

```bash
node local-operator/simulate-command.mjs /status
node local-operator/simulate-command.mjs /menu
node local-operator/simulate-command.mjs /menu project
node local-operator/simulate-command.mjs /menu codex
node local-operator/simulate-command.mjs /menu system
node local-operator/simulate-command.mjs /help
```

Phase 1.5 OpenClaw Telegram routing wrapper:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
```

OpenClaw/Telegram should use `/ppo status`, `/ppo menu`, `/ppo menu project`, `/ppo menu codex`, `/ppo menu system`, and `/ppo help` instead of overriding OpenClaw built-ins.

## Files

- `project-state.json`: local mock project state for current and placeholder projects.
- `commands.json`: local command catalog and menu grouping.
- `simulate-command.mjs`: dependency-free Node.js ESM simulator.
- `ppo-command.mjs`: dependency-free Node.js ESM wrapper for `/ppo` routing.

## Requirements

- Node.js installed locally.
- No npm install required.
- No OpenClaw dependency is installed in this repo.

OpenClaw should be installed separately during local testing.

## Safety boundary

The simulator is local-only and read-only.

It does not:

- call GitHub APIs
- call Telegram APIs
- scrape Codex usage
- deploy to a VPS
- store secrets
- write to external systems
- modify OpenClaw local config

## OpenClaw handoff shape

Future OpenClaw routing can treat this simulator as the command behavior reference:

```text
incoming /ppo chat text -> OpenClaw route -> local operator wrapper -> phone-style response
```

Phase 1 proves the command output shape only. Live integrations belong to later phases.

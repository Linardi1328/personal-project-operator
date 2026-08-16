# PPO OpenClaw Skill Scaffold

This directory documents the Phase 1.5 OpenClaw routing scaffold for Personal Project Operator.

It exists because OpenClaw owns built-in commands such as `/status`, `/menu`, and `/help`. Personal Project Operator must use the custom `/ppo` namespace for Telegram routing.

## Supported local PPO commands

```text
/ppo status
/ppo menu
/ppo menu project
/ppo menu codex
/ppo menu system
/ppo help
```

## Local command entrypoint

From the repo root:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
```

## Relationship to the simulator

`local-operator/ppo-command.mjs` is a namespace wrapper over `local-operator/simulate-command.mjs`.

The underlying simulator still supports terminal-only commands like `/status` and `/menu`. The wrapper adapts those outputs for OpenClaw and Telegram by showing `/ppo ...` command hints.

## Phase 1.5 boundary

This scaffold does not:

- install OpenClaw
- install dependencies
- modify `~/.openclaw`
- call Telegram APIs
- call GitHub APIs
- handle bot tokens
- deploy to VPS
- add write actions

Use it as the local routing contract for OpenClaw.


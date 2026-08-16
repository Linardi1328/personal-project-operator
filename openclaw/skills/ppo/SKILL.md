# Personal Project Operator OpenClaw Skill

## Purpose

Route OpenClaw Telegram messages in the custom `/ppo` namespace to the local Personal Project Operator simulator.

This skill scaffold is for Phase 1.5 local routing preparation only. It documents the intended command behavior and local wrapper entrypoint. It does not install dependencies, register Telegram commands, edit OpenClaw configuration, or call external APIs.

## Namespace

OpenClaw built-in commands own `/status`, `/menu`, and `/help`.

Personal Project Operator must use:

```text
/ppo status
/ppo menu
/ppo help
/ppo menu project
/ppo menu codex
/ppo menu system
```

## Local wrapper

Route the custom PPO command to:

```bash
node local-operator/ppo-command.mjs <args>
```

The wrapper accepts either the remaining PPO arguments or the full `/ppo ...` text payload.

Examples:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs "/ppo status"
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs help
```

## Command mapping

| Telegram/OpenClaw message | Local wrapper command | Underlying simulator command |
|---|---|---|
| `/ppo status` | `node local-operator/ppo-command.mjs status` | `/status` |
| `/ppo menu` | `node local-operator/ppo-command.mjs menu` | `/menu` |
| `/ppo menu project` | `node local-operator/ppo-command.mjs menu project` | `/menu project` |
| `/ppo menu codex` | `node local-operator/ppo-command.mjs menu codex` | `/menu codex` |
| `/ppo menu system` | `node local-operator/ppo-command.mjs menu system` | `/menu system` |
| `/ppo help` | `node local-operator/ppo-command.mjs help` | `/help` |

## Safety boundaries

The wrapper and simulator are local-only and read-only.

They must not:

- call GitHub APIs
- call Telegram APIs
- handle bot tokens
- scrape Codex usage
- deploy to VPS
- store secrets
- mutate files
- perform external write actions

## Expected OpenClaw behavior

OpenClaw should parse Telegram text that starts with `/ppo`, then pass either the remaining arguments or the full text payload to the local wrapper.

Expected flow:

```text
Telegram message -> OpenClaw local route -> local-operator/ppo-command.mjs -> local simulator output
```

## Unsupported commands

Unsupported PPO commands should return a safe help response and exit non-zero in terminal testing.

Example:

```bash
node local-operator/ppo-command.mjs unknown
```

Bare built-in commands should not be routed through this wrapper:

```bash
node local-operator/ppo-command.mjs /status
```

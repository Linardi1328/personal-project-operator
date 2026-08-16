---
name: ppo
description: Route Personal Project Operator commands to the local read-only simulator.
user-invocable: true
command-dispatch: tool
command-tool: ppo_local
command-arg-mode: raw
---

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

OpenClaw must dispatch `/ppo` directly to the registered `ppo_local` tool:

```text
/ppo ... -> command-dispatch: tool -> ppo_local -> local PPO wrapper
```

This bypasses model interpretation. The `ppo_local` tool accepts the raw `/ppo` argument string, validates it against the Phase 1.5 command surface, and invokes the existing wrapper with a fixed argv array.

The plugin tool resolves the wrapper from the linked local plugin path:

```text
openclaw/plugins/ppo-local -> ../../../local-operator/ppo-command.mjs
```

For Phase 1.5, manually load:

- the local skill from `<ppo-repo>/openclaw/skills`
- the local plugin from `<ppo-repo>/openclaw/plugins/ppo-local`

Do not rely on OpenClaw starting in the PPO repository root. Do not duplicate simulator logic inside the skill or plugin.

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
| `/ppo status` | `ppo_local` raw `status` | `/status` |
| `/ppo menu` | `ppo_local` raw `menu` | `/menu` |
| `/ppo menu project` | `ppo_local` raw `menu project` | `/menu project` |
| `/ppo menu codex` | `ppo_local` raw `menu codex` | `/menu codex` |
| `/ppo menu system` | `ppo_local` raw `menu system` | `/menu system` |
| `/ppo help` | `ppo_local` raw `help` | `/help` |

## Safety boundaries

The plugin, wrapper, and simulator are local-only and read-only.

They must not:

- call GitHub APIs
- call Telegram APIs
- handle bot tokens
- scrape Codex usage
- deploy to VPS
- store secrets
- mutate project files
- perform external write actions
- execute arbitrary shell commands

## Expected OpenClaw behavior

OpenClaw should parse Telegram text that starts with `/ppo`, then pass the raw arguments to `ppo_local` without a model turn.

Expected flow:

```text
Telegram message -> OpenClaw /ppo direct tool dispatch -> ppo_local -> local-operator/ppo-command.mjs -> local simulator output
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

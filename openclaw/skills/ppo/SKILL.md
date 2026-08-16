---
name: ppo
description: Route Personal Project Operator commands to the local read-only simulator.
user-invocable: true
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

Route the custom PPO command to the repo wrapper by using OpenClaw's skill-relative `{baseDir}` reference:

```bash
node "{baseDir}/../../../local-operator/ppo-command.mjs" <args>
```

The wrapper accepts either the remaining PPO arguments or the full `/ppo ...` text payload.

This path is deterministic only when OpenClaw loads this skill from the repository's `openclaw/skills` directory, because the wrapper intentionally stays outside the skill directory:

```text
{baseDir}/../../../local-operator/ppo-command.mjs
```

For Phase 1.5, load the local skill in place through `skills.load.extraDirs` with the absolute path to:

```text
<ppo-repo>/openclaw/skills
```

Do not rely on OpenClaw starting in the PPO repository root. Do not duplicate simulator logic inside the skill.

Examples:

```bash
node "{baseDir}/../../../local-operator/ppo-command.mjs" status
node "{baseDir}/../../../local-operator/ppo-command.mjs" "/ppo status"
node "{baseDir}/../../../local-operator/ppo-command.mjs" menu
node "{baseDir}/../../../local-operator/ppo-command.mjs" menu project
node "{baseDir}/../../../local-operator/ppo-command.mjs" help
```

## Command mapping

| Telegram/OpenClaw message | Local wrapper command | Underlying simulator command |
|---|---|---|
| `/ppo status` | `node "{baseDir}/../../../local-operator/ppo-command.mjs" status` | `/status` |
| `/ppo menu` | `node "{baseDir}/../../../local-operator/ppo-command.mjs" menu` | `/menu` |
| `/ppo menu project` | `node "{baseDir}/../../../local-operator/ppo-command.mjs" menu project` | `/menu project` |
| `/ppo menu codex` | `node "{baseDir}/../../../local-operator/ppo-command.mjs" menu codex` | `/menu codex` |
| `/ppo menu system` | `node "{baseDir}/../../../local-operator/ppo-command.mjs" menu system` | `/menu system` |
| `/ppo help` | `node "{baseDir}/../../../local-operator/ppo-command.mjs" help` | `/help` |

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
Telegram message -> OpenClaw /ppo skill -> {baseDir}/../../../local-operator/ppo-command.mjs -> local simulator output
```

## Unsupported commands

Unsupported PPO commands should return a safe help response and exit non-zero in terminal testing.

Example:

```bash
node "{baseDir}/../../../local-operator/ppo-command.mjs" unknown
```

Bare built-in commands should not be routed through this wrapper:

```bash
node "{baseDir}/../../../local-operator/ppo-command.mjs" /status
```

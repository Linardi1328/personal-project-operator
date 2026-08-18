---
name: ppo
description: Route Personal Project Operator commands to the local read-only wrapper.
user-invocable: true
command-dispatch: tool
command-tool: ppo_local
command-arg-mode: raw
---

# Personal Project Operator OpenClaw Skill

## Purpose

Route OpenClaw Telegram messages in the custom `/ppo` namespace to the local Personal Project Operator wrapper.

This skill scaffold documents deterministic direct tool routing. It does not install dependencies, register Telegram commands, edit OpenClaw configuration, or add OpenClaw tool permissions.

## Namespace

OpenClaw built-in commands own `/status`, `/menu`, and `/help`.

Personal Project Operator must use:

```text
/ppo status
/ppo repo <project>
/ppo pr <project>
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

This bypasses model interpretation. The `ppo_local` tool accepts the raw `/ppo` argument string, validates it against the approved command surface, and invokes the existing wrapper with a fixed argv array. In Phase 3B, `ppo_local` keeps the Phase 2C command surface: `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` route to GitHub read-only behavior for the approved project ids. The local Codex prompt generator and planning tools are terminal-only and are not accepted by this bridge yet.

The plugin tool resolves the wrapper from the linked local plugin path:

```text
openclaw/plugins/ppo-local -> ../../../local-operator/ppo-command.mjs
```

For local owner testing, manually load:

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
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs pr khlim-assist
```

## Command mapping

| Telegram/OpenClaw message | Local wrapper command | Underlying behavior |
|---|---|---|
| `/ppo status` | `ppo_local` raw `status` | GitHub read-only project status |
| `/ppo repo <project>` | `ppo_local` raw `repo <project>` | GitHub read-only repo summary |
| `/ppo pr <project>` | `ppo_local` raw `pr <project>` | GitHub read-only PR summary |
| `/ppo menu` | `ppo_local` raw `menu` | `/menu` |
| `/ppo menu project` | `ppo_local` raw `menu project` | `/menu project` |
| `/ppo menu codex` | `ppo_local` raw `menu codex` | `/menu codex` |
| `/ppo menu system` | `ppo_local` raw `menu system` | `/menu system` |
| `/ppo help` | `ppo_local` raw `help` | `/help` |

## Safety boundaries

The plugin, wrapper, and simulator are read-only.

They must not:

- call GitHub APIs except the approved Phase 2A read-only endpoint families for `/ppo status`, `/ppo repo`, and `/ppo pr`
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
Telegram message -> OpenClaw /ppo direct tool dispatch -> ppo_local -> local-operator/ppo-command.mjs -> local fixture or GitHub read-only output
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

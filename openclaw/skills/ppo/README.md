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

OpenClaw direct command dispatch uses the local plugin tool:

```text
command-dispatch: tool
command-tool: ppo_local
command-arg-mode: raw
```

The `ppo_local` tool is registered by the repo-local plugin at:

```text
openclaw/plugins/ppo-local
```

For Phase 1.5, manually load the local skill in place by adding the absolute repo path `<ppo-repo>/openclaw/skills` to OpenClaw `skills.load.extraDirs`, manually link the local plugin with `openclaw plugins install -l <ppo-repo>/openclaw/plugins/ppo-local`, and make sure the effective OpenClaw tool policy allows only `ppo_local` for PPO. Under restrictive profiles such as `tools.profile: "coding"`, the plugin can register `ppo_local` while the active tool policy still blocks it.

Do not depend on OpenClaw's current working directory. Do not use a copied plugin install for the owner Telegram test, because the plugin resolves the existing wrapper through its linked repo path.

## Relationship to the simulator

`local-operator/ppo-command.mjs` is a namespace wrapper over `local-operator/simulate-command.mjs`.

The underlying simulator still supports terminal-only commands like `/status` and `/menu`. The wrapper adapts those outputs for OpenClaw and Telegram by showing `/ppo ...` command hints.

## Phase 1.5 boundary

This scaffold does not:

- install OpenClaw
- install dependencies
- modify `~/.openclaw`
- modify OpenClaw config
- call Telegram APIs
- call GitHub APIs
- handle bot tokens
- require API keys, bot tokens, passwords, or other PPO secrets
- deploy to VPS
- add write actions
- route `/ppo` through model interpretation

Use it as the local routing contract for OpenClaw.

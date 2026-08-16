# Local Install Notes

These notes describe the manual Phase 1.5 OpenClaw setup for Personal Project Operator. This repository never modifies `~/.openclaw` automatically.

OpenClaw documentation for the current CLI says local skill installs copy the skill directory, while `skills.load.extraDirs` scans a directory in place. Because the PPO wrapper lives outside `openclaw/skills/ppo/`, Phase 1.5 should load this repo's skill tree in place.

## Preconditions

- OpenClaw is installed locally.
- Telegram is already connected to OpenClaw locally.
- This repository is available on the same MacBook.
- Node.js is available on the same `PATH` used by OpenClaw.
- The Phase 1 simulator works from terminal.
- No PPO token, API key, password, or secret is required.
- Telegram/OpenClaw credentials stay outside this repository.

## Resolve the PPO repo path

Use the absolute path to this repository as `<ppo-repo>`.

For the current local checkout:

```text
/Users/richie/personal-project-operator
```

The OpenClaw skill root to load is:

```text
<ppo-repo>/openclaw/skills
```

The installed skill then resolves the wrapper with OpenClaw's `{baseDir}` placeholder:

```bash
node "{baseDir}/../../../local-operator/ppo-command.mjs" <args>
```

When `{baseDir}` is `<ppo-repo>/openclaw/skills/ppo`, that points to:

```text
<ppo-repo>/local-operator/ppo-command.mjs
```

## Load the local skill manually

Preferred Phase 1.5 approach: manually add the repo skill root to OpenClaw `skills.load.extraDirs`.

Use OpenClaw to find the active config file:

```bash
openclaw config file
```

Then manually add the absolute skill root to that config:

```json5
{
  skills: {
    load: {
      extraDirs: [
        "/Users/richie/personal-project-operator/openclaw/skills"
      ]
    }
  }
}
```

If the config already has `skills.load.extraDirs`, append the PPO path instead of replacing unrelated entries.

Do not use `openclaw skills install ./openclaw/skills/ppo` for the Phase 1.5 Telegram owner test. The current OpenClaw CLI copies local skill installs into a workspace `skills/` directory, which breaks the intended `{baseDir}/../../../local-operator/ppo-command.mjs` relationship unless a separate reviewed absolute path adapter is added.

## Refresh OpenClaw skill visibility

OpenClaw normally watches skill roots. If the skill is not visible after editing config, start a new chat session or restart the Gateway manually.

Read-only verification commands:

```bash
openclaw skills list --eligible
openclaw skills info ppo
openclaw skills check
```

Expected visibility:

- `ppo` is listed as an available skill.
- `ppo` is user-invocable.
- `/ppo` is the Personal Project Operator entrypoint.
- OpenClaw built-ins `/status`, `/menu`, and `/help` are still OpenClaw-owned.

If those commands require changing the owner's OpenClaw installation or config first, stop and perform only the local terminal verification below.

## Verify wrapper before Telegram

From the repo root, these commands should succeed:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
node local-operator/ppo-command.mjs "/ppo status"
node local-operator/ppo-command.mjs "/ppo menu project"
```

These commands should fail safely with a non-zero terminal exit:

```bash
node local-operator/ppo-command.mjs unknown
node local-operator/ppo-command.mjs /status
node local-operator/ppo-command.mjs /menu
node local-operator/ppo-command.mjs /help
```

## Routing intent

Manual Telegram/OpenClaw mapping:

```text
/ppo status       -> node "{baseDir}/../../../local-operator/ppo-command.mjs" status
/ppo menu         -> node "{baseDir}/../../../local-operator/ppo-command.mjs" menu
/ppo menu project -> node "{baseDir}/../../../local-operator/ppo-command.mjs" menu project
/ppo menu codex   -> node "{baseDir}/../../../local-operator/ppo-command.mjs" menu codex
/ppo menu system  -> node "{baseDir}/../../../local-operator/ppo-command.mjs" menu system
/ppo help         -> node "{baseDir}/../../../local-operator/ppo-command.mjs" help
```

If OpenClaw passes the full message text instead of split arguments, the wrapper also accepts quoted text such as:

```bash
node "{baseDir}/../../../local-operator/ppo-command.mjs" "/ppo status"
```

## Do not route built-ins

Do not override:

```text
/status
/menu
/help
```

OpenClaw owns those commands. Personal Project Operator uses `/ppo`.

The wrapper intentionally rejects bare slash commands such as `/status`, `/menu`, and `/help`.

## Telegram owner test messages

Send these from Telegram only after OpenClaw shows the `ppo` skill as visible:

```text
/ppo status
/ppo menu
/ppo help
```

If those pass, test:

```text
/ppo menu project
/ppo menu codex
/ppo menu system
```

## Safety boundary

This setup is local-only.

Do not add:

- bot tokens to the repo
- GitHub tokens
- Telegram API calls in repo code
- VPS deployment scripts
- Codex usage scraping
- write actions

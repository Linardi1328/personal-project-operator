# Local Install Notes

These notes describe the manual Phase 1.5 OpenClaw setup for Personal Project Operator. This repository never modifies `~/.openclaw` automatically.

Phase 1.5 needs both local components:

- Skill: `<ppo-repo>/openclaw/skills/ppo`
- Plugin/tool: `<ppo-repo>/openclaw/plugins/ppo-local`

The skill owns the `/ppo` command namespace and uses direct tool dispatch. The plugin registers the deterministic `ppo_local` tool that invokes the existing local wrapper.

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

Repo-relative components:

```text
<ppo-repo>/openclaw/skills
<ppo-repo>/openclaw/plugins/ppo-local
<ppo-repo>/local-operator/ppo-command.mjs
```

## Load the local skill manually

Manually add the repo skill root to OpenClaw `skills.load.extraDirs`.

Find the active config file:

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

## Link and enable the local plugin manually

Link the plugin in place so its fixed repo-relative wrapper path remains valid:

```bash
openclaw plugins install -l /Users/richie/personal-project-operator/openclaw/plugins/ppo-local
openclaw plugins enable ppo-local
```

If the owner's config uses `plugins.allow`, add `ppo-local` to that allowlist manually.

Do not use a copied plugin install for the Phase 1.5 Telegram owner test. The plugin intentionally resolves the wrapper from the linked repo path:

```text
openclaw/plugins/ppo-local -> ../../../local-operator/ppo-command.mjs
```

## Skill Direct Dispatch

The `ppo` skill frontmatter must include:

```yaml
command-dispatch: tool
command-tool: ppo_local
command-arg-mode: raw
```

OpenClaw forwards the raw `/ppo` argument string to `ppo_local` as:

```json
{
  "command": "status",
  "commandName": "ppo",
  "skillName": "ppo"
}
```

The tool validates that raw command against the approved Phase 1.5 surface before invoking the wrapper.

## Refresh OpenClaw

Installing or changing linked plugin code may require a Gateway restart:

```bash
openclaw gateway restart
```

If the skill is not visible after editing config, start a new chat session or restart the Gateway manually.

## Validate OpenClaw Setup

Run these after the manual config/plugin steps:

```bash
openclaw config validate
openclaw plugins doctor
openclaw plugins inspect ppo-local --runtime --json
openclaw skills info ppo
openclaw skills check
```

Expected visibility:

- `ppo-local` is enabled.
- runtime inspection shows tool `ppo_local`.
- `ppo` is listed as an available skill/command.
- `ppo` uses `command-dispatch: tool`.
- `/ppo` is the Personal Project Operator entrypoint.
- OpenClaw built-ins `/status`, `/menu`, and `/help` are still OpenClaw-owned.

If these commands require changing the owner's OpenClaw installation or config first, stop and perform only the local terminal verification below.

## Verify Local Routing Before Telegram

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
node openclaw/plugins/ppo-local/test-bridge.mjs
```

These commands should fail safely with a non-zero terminal exit:

```bash
node local-operator/ppo-command.mjs unknown
node local-operator/ppo-command.mjs /status
node local-operator/ppo-command.mjs /menu
node local-operator/ppo-command.mjs /help
```

## Routing Intent

Manual Telegram/OpenClaw mapping:

```text
/ppo status       -> ppo_local raw "status"       -> local-operator/ppo-command.mjs status
/ppo menu         -> ppo_local raw "menu"         -> local-operator/ppo-command.mjs menu
/ppo help         -> ppo_local raw "help"         -> local-operator/ppo-command.mjs help
/ppo menu project -> ppo_local raw "menu project" -> local-operator/ppo-command.mjs menu project
/ppo menu codex   -> ppo_local raw "menu codex"   -> local-operator/ppo-command.mjs menu codex
/ppo menu system  -> ppo_local raw "menu system"  -> local-operator/ppo-command.mjs menu system
```

There must be no model-generated interpretation between `/ppo` and the wrapper output.

## Do Not Route Built-Ins

Do not override:

```text
/status
/menu
/help
```

OpenClaw owns those commands. Personal Project Operator uses `/ppo`.

The wrapper and plugin intentionally reject bare slash commands such as `/status`, `/menu`, and `/help`.

## Undo Local Setup

Manual removal:

```bash
openclaw plugins disable ppo-local
openclaw plugins uninstall ppo-local --keep-files
```

Then manually remove this entry from `skills.load.extraDirs`:

```text
/Users/richie/personal-project-operator/openclaw/skills
```

Restart the Gateway if needed:

```bash
openclaw gateway restart
```

The uninstall command removes OpenClaw's linked plugin registration. It must not delete this repository.

## Telegram Owner Test Messages

Send these from Telegram only after OpenClaw shows `ppo-local` and `ppo` as visible:

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

## Safety Boundary

This setup is local-only.

Do not add:

- bot tokens to the repo
- GitHub tokens
- Telegram API calls in repo code
- VPS deployment scripts
- Codex usage scraping
- write actions

# Local Install Notes

These notes describe the manual OpenClaw setup for Personal Project Operator. This repository never modifies `~/.openclaw` automatically.

PPO needs both local components:

- Skill: `<ppo-repo>/openclaw/skills/ppo`
- Plugin/tool: `<ppo-repo>/openclaw/plugins/ppo-local`

The skill owns the `/ppo` command namespace and uses direct tool dispatch. The plugin registers the deterministic `ppo_local` tool that invokes the existing local wrapper.

## Preconditions

- OpenClaw is installed locally.
- Telegram is already connected to OpenClaw locally.
- This repository is available on the same MacBook.
- Node.js is available on the same `PATH` used by OpenClaw.
- The local wrapper works from terminal.
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

Do not use a copied plugin install for Telegram owner tests. The plugin intentionally resolves the wrapper from the linked repo path:

```text
openclaw/plugins/ppo-local -> ../../../local-operator/ppo-command.mjs
```

## Tool Policy Preflight

Before Telegram testing, inspect the effective tool policy:

```bash
openclaw config get tools --json
```

If the output uses the tested restrictive profile and does not already define `tools.allow`:

```json
{
  "profile": "coding"
}
```

then `ppo_local` can be registered by the plugin but still excluded from the effective tool set. In Telegram this appears as:

```text
Tool not available: ppo_local
```

Grant only the PPO bridge tool through `tools.alsoAllow`. First dry-run the narrow permission:

```bash
openclaw config set tools.alsoAllow '["ppo_local"]' --strict-json --dry-run
```

Then apply it:

```bash
openclaw config set tools.alsoAllow '["ppo_local"]' --strict-json
```

If `tools.alsoAllow` already exists, preserve every existing entry and add only `ppo_local`, for example:

```bash
openclaw config set tools.alsoAllow '["existing_tool","ppo_local"]' --strict-json --dry-run
openclaw config set tools.alsoAllow '["existing_tool","ppo_local"]' --strict-json
```

If `tools.allow` already exists, do not create `tools.alsoAllow`. OpenClaw rejects configs where `allow` and `alsoAllow` coexist at the same policy scope. Preserve every existing `tools.allow` entry and add only `ppo_local` to that array, for example:

```bash
openclaw config set tools.allow '["existing_allowed_tool","ppo_local"]' --strict-json --dry-run
openclaw config set tools.allow '["existing_allowed_tool","ppo_local"]' --strict-json
```

Do not broaden the profile, use wildcard permissions such as `*`, use `group:plugins`, or expose all plugin tools for this setup. PPO needs only `ppo_local`. Do not overwrite unrelated operator policy.

Validate and restart after changing tool policy:

```bash
openclaw config validate
openclaw gateway restart
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

The tool validates that raw command against the approved command surface before invoking the wrapper. Phase 5B adds `/ppo issue-create <project> <title> [--body <body>]` and `/ppo issue-confirm <request-id>` to that surface. Phase 5D adds `/ppo note-add <project> <note...>` staging and `/ppo note-confirm <request-id>` confirmation through the same existing tool. Phase 6K adds `/ppo continue <run-id>` for one existing ordinary Phase 6 development run. Phase 6M adds `/ppo recover <run-id>` for one reviewed Phase 6L read-only recovery observation. Phase 6O adds `/ppo runs` and `/ppo run <run-id>` for the reviewed Phase 6N read-only ordinary-run catalog. Phase 6P adds `/ppo cancel <run-id>` and `/ppo cancel-confirm <request-id>` for confirmation-gated quiescent cancellation of eligible ordinary runs only.

Phase 5C bare terminal `note-add` remains terminal-only. Do not configure `PPO_NOTE_WRITE_CONFIRM` in Telegram/OpenClaw chat; `/ppo note-confirm <request-id>` supplies the Phase 5C confirmation internally after atomically claiming a pending request.

Phase 6K continue, Phase 6M recover, Phase 6O exact-run catalog inspection, and Phase 6P cancellation staging accept only the existing opaque run id from chat. Phase 6O run listing accepts no caller input after `runs`. Phase 6P cancellation confirmation accepts only the 43-character staged request id. Do not configure or paste expected versions, projects, statuses, actions, SHAs, repositories, workspaces, filters, search text, sort fields, recovery options, cleanup options, commands, executables, deployment targets, services, rollback targets, or rollback confirmations into Telegram/OpenClaw.

## Local Phase 5B/5C/5D write-data paths

Telegram/OpenClaw commands use one stable user-level write-data root by default:

```text
/Users/richie/.local/share/personal-project-operator/write-data
```

This keeps `/ppo start`, `/ppo run`, `/ppo continue`, approval requests, and notes on the same absolute path even if the repository is moved, updated, or linked from a different checkout. `PPO_WRITE_DATA_DIR`, when configured, must be an absolute path; the bridge fails closed before invoking the wrapper if it is relative or has surrounding whitespace.

For an installed Gateway, pin the same path in the global OpenClaw environment file at `~/.openclaw/.env`:

```text
PPO_WRITE_DATA_DIR=/Users/richie/.local/share/personal-project-operator/write-data
```

OpenClaw loads this global file for the Gateway service, unlike shell-only exports that may be absent from launchd. Restart the Gateway after changing it.

Direct terminal commands that bypass the plugin continue to default to the repository-local store unless `PPO_WRITE_DATA_DIR` is set. Use the same absolute value for terminal and Telegram work when they need to inspect the same runs.

You may override the write-data store and audit file with other absolute paths:

```bash
PPO_WRITE_DATA_DIR=/private/tmp/ppo-write-data \
PPO_GITHUB_WRITE_AUDIT_PATH=/private/tmp/ppo-audit/github-write-audit.ndjson \
openclaw gateway restart
```

Pending issue and note request directories are created with `0700`, request files are created with `0600`, and request ids expire after 10 minutes. Do not paste terminal write confirmation environment values into Telegram; confirm commands supply confirmation internally after the id is claimed.

Phase 5C notes use the same `PPO_WRITE_DATA_DIR` root for terminal-only storage under:

```text
/Users/richie/.local/share/personal-project-operator/write-data/project-notes
```

Phase 5D pending note requests use:

```text
/Users/richie/.local/share/personal-project-operator/write-data/pending-project-notes
```

## Refresh OpenClaw

Installing or changing linked plugin code may require a Gateway restart:

```bash
openclaw gateway restart
```

If the skill is not visible after editing config, start a new chat session or restart the Gateway manually.

## Validate OpenClaw Setup

Run these after the manual config/plugin/tool-policy steps:

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
- either `tools.alsoAllow` or `tools.allow` includes `ppo_local` when the selected profile does not expose it by default.
- `ppo` is listed as an available skill/command.
- `ppo` uses `command-dispatch: tool`.
- `/ppo` is the Personal Project Operator entrypoint.
- OpenClaw built-ins `/status`, `/menu`, and `/help` are still OpenClaw-owned.

Verification order:

1. Confirm runtime registration:

   ```bash
   openclaw plugins inspect ppo-local --runtime --json
   ```

   The runtime output must show `ppo_local`.

2. Confirm configured top-level tool policy:

   ```bash
   openclaw config get tools --json
   ```

   If `tools.profile` is `coding`, confirm `ppo_local` is allowed through exactly one policy array: either `tools.alsoAllow` or `tools.allow`. `tools.allow` and `tools.alsoAllow` must not coexist at the same scope.

3. Confirm the live Telegram session sees the tool:

   ```text
   /tools compact
   ```

   The compact tool list must include `ppo_local`. This proves the tool is available to that live Telegram session, not just registered by the plugin.

4. Prove deterministic dispatch and fixture output by sending:

   ```text
   /ppo status
   ```

   A successful result begins with:

   ```text
   Project Status
   ```

If these commands require changing the owner's OpenClaw installation or config first, stop and perform only the local terminal verification below.

Troubleshooting distinction:

- If `openclaw plugins inspect ppo-local --runtime --json` does not show `ppo_local`, the plugin is not loaded or the tool is not registered.
- If runtime inspection shows `ppo_local` but Telegram `/tools compact` does not show it or `/ppo status` returns `Tool not available: ppo_local`, the bridge is registered and the remaining problem is effective policy. Inspect additional effective-policy layers such as agent, provider, sandbox, or sender policy. Do not widen permissions blindly.

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
/ppo runs -> ppo_local raw "runs" -> local-operator/ppo-command.mjs runs
/ppo run <run-id> -> ppo_local raw "run <run-id>" -> local-operator/ppo-command.mjs run <run-id>
/ppo cancel <run-id> -> ppo_local raw "cancel <run-id>" -> local-operator/ppo-command.mjs cancel <run-id>
/ppo cancel-confirm <request-id> -> ppo_local raw "cancel-confirm <request-id>" -> local-operator/ppo-command.mjs cancel-confirm <request-id>
/ppo continue <run-id> -> ppo_local raw "continue <run-id>" -> local-operator/ppo-command.mjs continue <run-id>
/ppo recover <run-id> -> ppo_local raw "recover <run-id>" -> local-operator/ppo-command.mjs recover <run-id>
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

Remove only the PPO-specific tool permission from whichever policy array actually contains it. First inspect current tool policy:

```bash
openclaw config get tools --json
```

If `tools.alsoAllow` contains only `ppo_local`, remove that key:

```bash
openclaw config unset tools.alsoAllow
```

If `tools.alsoAllow` contains other entries, preserve them and remove only `ppo_local`, for example:

```bash
openclaw config set tools.alsoAllow '["existing_tool"]' --strict-json --dry-run
openclaw config set tools.alsoAllow '["existing_tool"]' --strict-json
```

If `tools.allow` contains `ppo_local`, do not add or remove `tools.alsoAllow`. Preserve unrelated `tools.allow` entries and remove only `ppo_local`, for example:

```bash
openclaw config set tools.allow '["existing_allowed_tool"]' --strict-json --dry-run
openclaw config set tools.allow '["existing_allowed_tool"]' --strict-json
```

If `tools.allow` contains only `ppo_local` and the owner wants to remove that explicit allow policy, remove that key only after confirming no unrelated tool policy depends on it:

```bash
openclaw config unset tools.allow
```

Unset a policy array/key only when `ppo_local` was its sole entry and removing that empty key is appropriate for the owner's broader OpenClaw policy.

Restart the Gateway if needed:

```bash
openclaw config validate
openclaw gateway restart
```

The uninstall command removes OpenClaw's linked plugin registration. It must not delete this repository.

## Telegram Owner Test Messages

Send these from Telegram only after OpenClaw shows `ppo-local` and `ppo` as visible, runtime inspection shows `ppo_local`, `/tools compact` lists `ppo_local`, and effective tool policy allows `ppo_local`:

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
/ppo repo khlim-assist
/ppo pr khlim-assist
/ppo codex khlim-assist add provider validation tests
/ppo issue-create khlim-assist owner review test issue --body created only after confirmation
/ppo note-add khlim-assist owner review staged note
/ppo start khlim-assist
/ppo runs
/ppo run <run-id>
/ppo cancel <run-id>
/ppo cancel-confirm <request-id>
/ppo continue <run-id>
/ppo recover <run-id>
```

Only confirm a staged issue with `/ppo issue-confirm <request-id>` when the owner intends to create that GitHub issue.
Only confirm a staged note with `/ppo note-confirm <request-id>` when the owner intends to append that local project note.

## Safety Boundary

This setup keeps a single OpenClaw tool, `ppo_local`.

Do not add:

- bot tokens to the repo
- GitHub tokens
- Telegram API calls in repo code
- VPS deployment scripts
- Codex usage scraping
- OpenClaw tools beyond `ppo_local`
- GitHub writes beyond Phase 5B `/ppo issue-create` staging plus `/ppo issue-confirm` single-use issue creation
- project note writes beyond Phase 5D `/ppo note-add` staging plus `/ppo note-confirm` single-use note creation
- automatic continuation, task text, workspace creation, Codex/test/review execution, PR/merge behavior, or production action through `/ppo start`
- PPO production deployment, production verification, rollback, rollback reconciliation, service control, or owner rollback confirmation through `/ppo continue` or `/ppo recover`
- recovery, continuation, cancellation, retry, repair, filters, search, sort, or production action through `/ppo runs` or `/ppo run`
- process interruption, cleanup, recovery, continuation, retry, repair, or production action through `/ppo cancel` or `/ppo cancel-confirm`

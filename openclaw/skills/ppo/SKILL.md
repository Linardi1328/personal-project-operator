---
name: ppo
description: Route Personal Project Operator commands to the local deterministic wrapper for GitHub read-only summaries, deterministic text tools, Phase 5B approval-gated issue creation, Phase 5D approval-gated project note creation, and Phase 6K controlled development continue.
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
/ppo codex <project> <task>
/ppo codex-budget <project> <task>
/ppo prompt-size <draft>
/ppo split-task <task>
/ppo issue-create <project> <title> [--body <body>]
/ppo issue-confirm <request-id>
/ppo note-add <project> <note...>
/ppo note-confirm <request-id>
/ppo continue <run-id>
```

Phase 5C bare terminal `note-add` remains terminal-only. Phase 5D adds `/ppo note-add` staging and `/ppo note-confirm` approval through the existing `ppo_local` path.
Phase 6K adds `/ppo continue <run-id>` for existing ordinary five-project Phase 6 development runs only. It does not route PPO production deployment, verification, rollback, or rollback reconciliation.

## Local wrapper

OpenClaw must dispatch `/ppo` directly to the registered `ppo_local` tool:

```text
/ppo ... -> command-dispatch: tool -> ppo_local -> local PPO wrapper
```

This bypasses model interpretation. The `ppo_local` tool accepts the raw `/ppo` argument string, validates it against the approved command surface, and invokes the existing wrapper with a fixed argv array. In Phase 6K, `ppo_local` routes `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` to GitHub read-only behavior for the approved project ids; routes `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` to deterministic text-only local handlers; routes `/ppo issue-create` plus `/ppo issue-confirm` for approval-gated GitHub issue creation; routes `/ppo note-add` plus `/ppo note-confirm` for approval-gated local project note creation; and routes `/ppo continue <run-id>` to the controlled one-boundary development continue orchestrator. The bridge parses only the command envelope; task, draft, title, body, note text, and run id are inert argv data.

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
node local-operator/ppo-command.mjs "/ppo issue-create khlim-assist issue title --body optional body"
node local-operator/ppo-command.mjs "/ppo issue-confirm <request-id>"
node local-operator/ppo-command.mjs "/ppo note-add khlim-assist project note text"
node local-operator/ppo-command.mjs "/ppo note-confirm <request-id>"
node local-operator/ppo-command.mjs "/ppo continue <run-id>"
```

## Command mapping

| Telegram/OpenClaw message | Local wrapper command | Underlying behavior |
|---|---|---|
| `/ppo status` | `ppo_local` raw `status` | GitHub read-only project status |
| `/ppo repo <project>` | `ppo_local` raw `repo <project>` | GitHub read-only repo summary |
| `/ppo pr <project>` | `ppo_local` raw `pr <project>` | GitHub read-only PR summary |
| `/ppo codex <project> <task>` | `ppo_local` raw `codex <project> <task>` | Local Codex prompt text generation |
| `/ppo codex-budget <project> <task>` | `ppo_local` raw `codex-budget <project> <task>` | Local deterministic budget estimate |
| `/ppo prompt-size <draft>` | `ppo_local` raw `prompt-size <draft>` | Local prompt-size review |
| `/ppo split-task <task>` | `ppo_local` raw `split-task <task>` | Local deterministic task split |
| `/ppo issue-create <project> <title> [--body <body>]` | `ppo_local` raw `issue-create <project> <title> [--body <body>]` | Stage one approved-project issue intent; no GitHub write |
| `/ppo issue-confirm <request-id>` | `ppo_local` raw `issue-confirm <request-id>` | Atomically claim one pending request, then create one issue through the Phase 5A writer |
| `/ppo note-add <project> <note...>` | `ppo_local` raw `note-add <project> <note...>` | Stage one approved-project note intent; no note append |
| `/ppo note-confirm <request-id>` | `ppo_local` raw `note-confirm <request-id>` | Atomically claim one pending request, then append one note through the Phase 5C writer |
| `/ppo continue <run-id>` | `ppo_local` raw `continue <run-id>` | Advance one existing ordinary development run through at most one reviewed Phase 6B-6G boundary; never production deployment, verification, or rollback |
| `/ppo menu` | `ppo_local` raw `menu` | `/menu` |
| `/ppo menu project` | `ppo_local` raw `menu project` | `/menu project` |
| `/ppo menu codex` | `ppo_local` raw `menu codex` | `/menu codex` |
| `/ppo menu system` | `ppo_local` raw `menu system` | `/menu system` |
| `/ppo help` | `ppo_local` raw `help` | `/help` |

## Safety boundaries

The `/ppo` plugin path is read-only except for the Phase 5B issue pending store, the single approved GitHub issue creation write after `/ppo issue-confirm`, the Phase 5D note pending store, the single approved local note append after `/ppo note-confirm`, and Phase 6K's explicit delegation to one existing reviewed Phase 6B-6G development boundary.

They must not:

- call GitHub APIs except the approved Phase 2A read-only endpoint families for `/ppo status`, `/ppo repo`, and `/ppo pr`, and the Phase 5A `POST /repos/<approved repo>/issues` writer after `/ppo issue-confirm`
- call Telegram APIs
- handle bot tokens
- scrape Codex usage
- invoke Codex, ChatGPT, OpenAI APIs, or another model
- deploy to VPS
- store secrets
- mutate project files
- perform external write actions other than the single approved issue creation path
- perform local note writes outside the single approved note confirmation path
- route production deployment, production verification, rollback, rollback reconciliation, rollback confirmation, service control, or VPS mutation through `/ppo continue`
- accept or expose terminal write confirmation environment values through chat
- create comments, labels, assignees, milestones, PRs, branches, commits, merges, workflow dispatches, project-state changes, or deployments
- execute arbitrary shell commands

## Expected OpenClaw behavior

OpenClaw should parse Telegram text that starts with `/ppo`, then pass the raw arguments to `ppo_local` without a model turn.

Expected flow:

```text
Telegram message -> OpenClaw /ppo direct tool dispatch -> ppo_local -> local-operator/ppo-command.mjs -> local fixture, GitHub read-only, deterministic text output, Phase 5B issue approval flow, Phase 5D note approval flow, or Phase 6K one-boundary development continue
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

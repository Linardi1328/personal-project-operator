# Command Registry

This file is the single source of truth for Personal Project Operator commands.

For OpenClaw Telegram routing, commands use the `/ppo` namespace so they do not override OpenClaw built-ins such as `/status`, `/menu`, and `/help`.

Danger levels:

- `safe`: text-only, local docs, or read-only behavior.
- `caution`: may influence future work or update local state in a later phase.
- `dangerous`: would mutate external systems and requires strict approval.
- `disabled`: not available in the current phase.

In Phase 6M, `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` use GitHub read-only direct tool routing; `/ppo menu` and `/ppo help` remain fixture-backed wrapper output. `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` are direct-routed deterministic text commands through `ppo_local`. Phase 5A keeps the terminal-only GitHub issue creation path, `node local-operator/ppo-command.mjs issue-create <project> <title> [body...]`. Phase 5B adds approval-gated chat issue creation through the same existing `ppo_local` tool: `/ppo issue-create <project> <title> [--body <body>]` stages only, and `/ppo issue-confirm <request-id>` atomically claims one unexpired request before invoking the Phase 5A writer with internal confirmation. Phase 5C adds terminal-only local project notes with `node local-operator/ppo-command.mjs note-add <project> <note...>`. Phase 5D adds approval-gated chat project notes through the same existing `ppo_local` tool: `/ppo note-add <project> <note...>` stages only, and `/ppo note-confirm <request-id>` atomically claims one unexpired request before invoking the Phase 5C writer with internal confirmation. Phase 6K adds `/ppo continue <run-id>` for one existing ordinary Phase 6 development run, advancing at most one reviewed Phase 6B-6G boundary and never routing production deployment, verification, or rollback. Phase 6M adds `/ppo recover <run-id>` as a read-only route to the reviewed Phase 6L recovery coordinator; it never repairs, retries, continues, or routes production recovery.

| command | category | description | arguments | enabled_in_phase_0 | requires_auth | write_action | danger_level | notes |
|---|---|---|---|---|---|---|---|---|
| `/ppo status` | Project Control | Show live GitHub read-only project status. | None | Phase 2C GitHub read-only | Local `gh` auth | No | safe | Reports observable GitHub facts only; no recommendations. |
| `/ppo next` | Project Control | Rank which project should receive attention first. | None | Yes, docs only | No | No | safe | Future ranking may use read-only GitHub and usage state. |
| `/ppo repo` | Project Control | Summarize a project repository. | `<project>` | Phase 2B GitHub read-only | Local `gh` auth | No | safe | Uses only repo metadata and bounded recent commits. |
| `/ppo pr` | Project Control | Summarize latest project PR state. | `<project>` | Phase 2B GitHub read-only | Local `gh` auth | No | safe | Uses only bounded open pull request data. |
| `/ppo issue-create` | Project Control | Stage one GitHub issue creation request for approval. | `<project> <title> [--body <body>]` | Phase 5B approval gate | No network auth for staging | Stage only | dangerous | Validates through the five-project registry and Phase 5A title/body limits, writes one private pending request, and returns `/ppo issue-confirm <request-id>`. It never calls GitHub. |
| `/ppo issue-confirm` | Project Control | Confirm one staged GitHub issue creation request. | `<request-id>` | Phase 5B approval gate | Local `gh` auth | Yes | dangerous | Atomically claims and consumes one unexpired request before calling the Phase 5A writer with internal confirmation. Unknown, expired, malformed, consumed, or replayed ids write nothing. |
| `/ppo note-add` | Project Control | Stage one local project note request for approval. | `<project> <note...>` | Phase 5D approval gate | No | Stage only | dangerous | Validates through the five-project registry and Phase 5C note limits, writes one private pending request, and returns `/ppo note-confirm <request-id>`. It never appends a note. |
| `/ppo note-confirm` | Project Control | Confirm one staged local project note request. | `<request-id>` | Phase 5D approval gate | No | Yes | dangerous | Atomically claims and consumes one unexpired request before calling the Phase 5C writer with internal confirmation. Unknown, expired, malformed, consumed, or replayed ids write nothing. |
| `/ppo continue` | Project Control | Continue one existing ordinary development run through one reviewed boundary. | `<run-id>` | Phase 6K controlled continue | Child phase dependent | Child phase dependent | dangerous | Accepts only the existing 43-character run id, reads project/status/version from durable Phase 6A state, delegates to one Phase 6B-6G API, stops at `merged`, and refuses PPO production deployment, verification, and rollback statuses. |
| `/ppo recover` | Project Control | Inspect one existing ordinary development run through one read-only recovery boundary. | `<run-id>` | Phase 6M controlled recovery | Child phase dependent read-only auth | No | safe | Accepts only the existing 43-character run id, invokes the reviewed Phase 6L coordinator once, returns bounded diagnostics, and never repairs, retries, continues, deploys, verifies production, or rolls back. |
| `/ppo handoff` | Project Control | Create compact handoff for ChatGPT or Codex. | `<project>` | Yes, docs only | No | No | safe | Text output only. |
| `/ppo codex` | Codex Workflow | Generate compact Codex prompt text. | `<project> <phase-or-task>` | Phase 3C direct route | Local `gh` auth for read-only context | No | safe | Does not run Codex automatically; uses approved read-only context only. |
| `/ppo codex-budget` | Codex Workflow | Estimate expected Codex task size. | `<project> <task>` | Phase 3C direct route | No | No | safe | Deterministic heuristic only; no model or usage scraping. |
| `/ppo prompt-size` | Codex Workflow | Review and mechanically compact long prompts. | `<draft>` | Phase 3C direct route | No | No | safe | Multiline drafts are preserved as inert text; no semantic rewrite or model call. |
| `/ppo split-task` | Codex Workflow | Split large tasks into smaller phases. | `<task>` | Phase 3C direct route | No | No | safe | Planning only; write-action phases remain permission-gated. |
| `/ppo codex-usage` | Usage & Limits | Show manually tracked Codex usage status. | None | Yes, docs only | No | No | safe | Manual-first; no scraping claim. |
| `/ppo update-usage` | Usage & Limits | Manually update usage status. | `<provider> <status>` | Yes, documented only | No | Disabled in Phase 1.5 | caution | Future local state update only after approval. |
| `/ppo vps-health` | System & Safety | Check future VPS health. | None | Phase 4A local script foundation only | Future server auth | No | safe | Not routed through `ppo_local` yet; local script is `node deployment/scripts/vps-health.mjs`. |
| `/ppo safe-mode` | System & Safety | Show blocked actions and safety posture. | None | Yes, docs only | No | No | safe | Does not toggle permissions in Phase 1.5. |
| `/ppo menu` | System & Safety | Show available command menu. | Optional category | Yes, local output | No | No | safe | Supports `/ppo menu project`, `/ppo menu codex`, `/ppo menu system`. |
| `/ppo help` | System & Safety | Explain phone usage and direct user to `/ppo menu`. | None | Yes, local output | No | No | safe | Help text only. |
| `/ppo content` | Expansion | Turn project progress into content ideas. | `<project>` | Yes, docs only | No | No | safe | Drafts only; no auto-posting. |
| `/ppo feature-request` | Expansion | Log or format a future feature idea. | `<idea>` | Yes, documented only | No | Disabled in Phase 1.5 | caution | Future issue creation requires approval. |
| `/ppo backlog` | Expansion | List planned future features. | None | Yes, docs only | No | No | safe | Read-only planning output. |

## Terminal-only Phase 5A write path

`issue-create <project> <title> [body...]` is available only through the local terminal wrapper. It requires exact `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>`, writes only `POST /repos/<approved repo>/issues` with `title` and `body`, and records a credential-free local audit trail.

## Phase 5B approval-gated chat write path

`/ppo issue-create <project> <title> [--body <body>]` is available through `ppo_local` and performs staging only. Pending requests are stored under `PPO_WRITE_DATA_DIR` or `local-operator/write-data/`, with private directories and files. The response prints the deterministic preview, an opaque one-time request id, the expiry timestamp, and `/ppo issue-confirm <request-id>`.

`/ppo issue-confirm <request-id>` claims and consumes one unexpired pending request before any network write. It does not accept terminal confirmation environment values from chat; it supplies the Phase 5A confirmation internally after the id is claimed.

## Terminal-only Phase 5C project note path

`note-add <project> <note...>` is available only through the local terminal wrapper. It requires exact `PPO_NOTE_WRITE_CONFIRM=add-note:<project>`, stores append-only note records under `${PPO_WRITE_DATA_DIR}/project-notes`, and writes credential/content-free metadata audit records. It does not call GitHub or mutate `projects/*.md` or project-state files.

## Phase 5D approval-gated chat project note path

`/ppo note-add <project> <note...>` is available through `ppo_local` and performs staging only. Pending requests are stored under `${PPO_WRITE_DATA_DIR}/pending-project-notes` or `local-operator/write-data/pending-project-notes`, with private directories and files. The response prints the deterministic preview with project/repo/note length, an opaque one-time request id, the expiry timestamp, and `/ppo note-confirm <request-id>`.

`/ppo note-confirm <request-id>` claims and consumes one unexpired pending request before any note write. It does not accept terminal confirmation environment values from chat; it supplies the Phase 5C confirmation internally after the id is claimed. The Phase 5C note audit remains metadata-only and must not include Phase 5D request ids.

## Phase 6K controlled development continue path

`/ppo continue <run-id>` is available through `ppo_local` for existing ordinary Phase 6 development runs only. The bridge maps only the exact command shape to wrapper argv `["continue", "<run-id>"]`; malformed ids, extra tokens, caller-selected actions, SHAs, projects, or environment overrides are rejected before execution.

The continue orchestrator reads the durable run, captures the current version, re-reads before mutation, and passes that version internally to the existing reviewed child API for the current status. One invocation advances at most one outer boundary and never exposes Phase 6H deployment, Phase 6I production verification, Phase 6J rollback, service control, rollback confirmation, or production recovery through chat.

## Phase 6M controlled development recover path

`/ppo recover <run-id>` is available through `ppo_local` for existing ordinary Phase 6 development runs only. The bridge maps only the exact command shape to wrapper argv `["recover", "<run-id>"]`; malformed ids, extra tokens, caller-selected projects, statuses, actions, SHAs, policies, commands, deployment targets, rollback targets, or environment overrides are rejected before execution.

The route invokes the reviewed Phase 6L recovery coordinator once and prints only bounded recovery output. It performs no retry, repair, state transition, background polling, automatic `/ppo continue`, production deployment, production verification, rollback, service control, or production recovery.

## Disabled write actions

These actions are not available in Phase 6M:

- creating GitHub issues outside terminal-only `issue-create` or Phase 5B `/ppo issue-create` plus `/ppo issue-confirm`
- creating project notes outside terminal-only `note-add` or Phase 5D `/ppo note-add` plus `/ppo note-confirm`
- `/ppo start`, `/ppo develop`, `/ppo run`, run listing, run search, automatic recovery, repair, retry, or background autonomous continuation
- `/ppo recovery`, `/ppo reconcile`, `/ppo repair`, `/ppo retry`, or `/ppo resume`
- PPO production deployment, production verification, rollback, or rollback reconciliation through `/ppo continue` or `/ppo recover`
- editing, deleting, replacing, or promoting project notes into `projects/*.md` or project-state files
- commenting on PRs
- commenting on issues
- changing labels
- approving PRs
- merging PRs
- pushing branches
- deleting branches
- deploying services
- restarting services
- sending messages to customers
- publishing content
- executing trades
- making paid API calls without approval

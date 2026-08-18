# Command Registry

This file is the single source of truth for Personal Project Operator commands.

For OpenClaw Telegram routing, commands use the `/ppo` namespace so they do not override OpenClaw built-ins such as `/status`, `/menu`, and `/help`.

Danger levels:

- `safe`: text-only, local docs, or read-only behavior.
- `caution`: may influence future work or update local state in a later phase.
- `dangerous`: would mutate external systems and requires strict approval.
- `disabled`: not available in the current phase.

In Phase 5A, `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` use GitHub read-only direct tool routing; `/ppo menu` and `/ppo help` remain fixture-backed wrapper output. `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` are direct-routed deterministic text commands through `ppo_local`. Phase 5A adds one terminal-only GitHub issue creation path, `node local-operator/ppo-command.mjs issue-create <project> <title> [body...]`, but it is not a `/ppo` command and is not routed through OpenClaw, Telegram, or `ppo_local`.

| command | category | description | arguments | enabled_in_phase_0 | requires_auth | write_action | danger_level | notes |
|---|---|---|---|---|---|---|---|---|
| `/ppo status` | Project Control | Show live GitHub read-only project status. | None | Phase 2C GitHub read-only | Local `gh` auth | No | safe | Reports observable GitHub facts only; no recommendations. |
| `/ppo next` | Project Control | Rank which project should receive attention first. | None | Yes, docs only | No | No | safe | Future ranking may use read-only GitHub and usage state. |
| `/ppo repo` | Project Control | Summarize a project repository. | `<project>` | Phase 2B GitHub read-only | Local `gh` auth | No | safe | Uses only repo metadata and bounded recent commits. |
| `/ppo pr` | Project Control | Summarize latest project PR state. | `<project>` | Phase 2B GitHub read-only | Local `gh` auth | No | safe | Uses only bounded open pull request data. |
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

## Disabled write actions

These actions are not available in Phase 5A:

- creating GitHub issues outside terminal-only `issue-create`
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

# Command Registry

This file is the single source of truth for Personal Project Operator commands.

For OpenClaw Telegram routing, commands use the `/ppo` namespace so they do not override OpenClaw built-ins such as `/status`, `/menu`, and `/help`.

Danger levels:

- `safe`: text-only, local docs, or read-only behavior.
- `caution`: may influence future work or update local state in a later phase.
- `dangerous`: would mutate external systems and requires strict approval.
- `disabled`: not available in the current phase.

In Phase 2B, all write actions remain disabled. `/ppo status`, `/ppo menu`, and `/ppo help` remain local fixture-backed; `/ppo repo <project>` and `/ppo pr <project>` use GitHub read-only direct tool routing.

| command | category | description | arguments | enabled_in_phase_0 | requires_auth | write_action | danger_level | notes |
|---|---|---|---|---|---|---|---|---|
| `/ppo status` | Project Control | Show all active projects and next actions. | None | Yes, local output | No | No | safe | Uses local fixture state in Phase 1.5. |
| `/ppo next` | Project Control | Rank which project should receive attention first. | None | Yes, docs only | No | No | safe | Future ranking may use read-only GitHub and usage state. |
| `/ppo repo` | Project Control | Summarize a project repository. | `<project>` | Phase 2B GitHub read-only | Local `gh` auth | No | safe | Uses only repo metadata and bounded recent commits. |
| `/ppo pr` | Project Control | Summarize latest project PR state. | `<project>` | Phase 2B GitHub read-only | Local `gh` auth | No | safe | Uses only bounded open pull request data. |
| `/ppo handoff` | Project Control | Create compact handoff for ChatGPT or Codex. | `<project>` | Yes, docs only | No | No | safe | Text output only. |
| `/ppo codex` | Codex Workflow | Generate compact Codex prompt. | `<project> <phase-or-task>` | Yes, docs only | No | No | safe | Does not run Codex automatically. |
| `/ppo codex-budget` | Codex Workflow | Estimate expected Codex task size. | `<project> <task>` | Yes, docs only | No | No | safe | Uses heuristic categories. |
| `/ppo prompt-size` | Codex Workflow | Review and compress long prompts. | `<draft>` | Yes, docs only | No | No | safe | Text review only. |
| `/ppo split-task` | Codex Workflow | Split large tasks into smaller phases. | `<task>` | Yes, docs only | No | No | safe | Planning only. |
| `/ppo codex-usage` | Usage & Limits | Show manually tracked Codex usage status. | None | Yes, docs only | No | No | safe | Manual-first; no scraping claim. |
| `/ppo update-usage` | Usage & Limits | Manually update usage status. | `<provider> <status>` | Yes, documented only | No | Disabled in Phase 1.5 | caution | Future local state update only after approval. |
| `/ppo vps-health` | System & Safety | Check future VPS health. | None | Yes, expected output only | Future server auth | No | safe | No live checks in Phase 1.5. |
| `/ppo safe-mode` | System & Safety | Show blocked actions and safety posture. | None | Yes, docs only | No | No | safe | Does not toggle permissions in Phase 1.5. |
| `/ppo menu` | System & Safety | Show available command menu. | Optional category | Yes, local output | No | No | safe | Supports `/ppo menu project`, `/ppo menu codex`, `/ppo menu system`. |
| `/ppo help` | System & Safety | Explain phone usage and direct user to `/ppo menu`. | None | Yes, local output | No | No | safe | Help text only. |
| `/ppo content` | Expansion | Turn project progress into content ideas. | `<project>` | Yes, docs only | No | No | safe | Drafts only; no auto-posting. |
| `/ppo feature-request` | Expansion | Log or format a future feature idea. | `<idea>` | Yes, documented only | No | Disabled in Phase 1.5 | caution | Future issue creation requires approval. |
| `/ppo backlog` | Expansion | List planned future features. | None | Yes, docs only | No | No | safe | Read-only planning output. |

## Disabled write actions

These actions are not available in Phase 2B:

- creating GitHub issues
- commenting on PRs
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

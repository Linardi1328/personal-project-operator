# Example Telegram PPO Menu

Telegram message:

```text
/ppo menu
```

Expected OpenClaw local route:

```bash
node local-operator/ppo-command.mjs menu
```

Expected reply:

```text
Personal Project Operator Menu

Phase 7A PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, controlled ordinary-run start, one-boundary ordinary development continue, read-only development recovery, the read-only ordinary-run catalog, and confirmation-gated quiescent run cancellation.

Project Control
- /ppo status - Show live GitHub project status. [github read-only]
- /ppo next - Recommend next project priority. [future]
- /ppo repo <project> - Summarize a project repository. [github read-only]
- /ppo pr <project> - Summarize latest project PR state. [github read-only]
- /ppo start <project> - Create one planned ordinary development run. [controlled development start]
- /ppo handoff <project> - Create compact handoff for ChatGPT or Codex. [future]

Codex Workflow
- /ppo codex <project> <phase-or-task> - Generate compact Codex prompt text. [local text]
- /ppo codex-budget <project> <task> - Estimate Codex task size. [local text]
- /ppo prompt-size <draft> - Review and mechanically compact prompt drafts. [local text]
- /ppo split-task <task> - Split large tasks into smaller planning phases. [local text]

Usage & Limits
- /ppo codex-usage - Show manually tracked Codex usage status. [future]
- /ppo update-usage <provider> <status> - Manually update usage status. [future]

System & Safety
- /ppo vps-health - Check future VPS health. [future]
- /ppo safe-mode - Show safety boundaries. [future]
- /ppo menu [category] - Show command menu. [local]
- /ppo help - Explain phone usage. [local]

Expansion
- /ppo content <project> - Turn project progress into content ideas. [future]
- /ppo feature-request <idea> - Format a future feature idea. [future]
- /ppo backlog - List planned future features. [future]

Phase 7A boundary: /ppo start creates at most one Phase 6B planned run and never continues automatically; /ppo cancel remains confirmation-gated; /ppo runs and /ppo run remain read-only catalog routes; production deployment, verification, and rollback remain unrouted.
```

Filtered Telegram examples:

```text
/ppo menu project
/ppo menu codex
/ppo menu system
```

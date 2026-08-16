# Example Local Menu Run

Run from the repo root:

```bash
node local-operator/simulate-command.mjs /menu
```

Expected local output:

```text
Personal Project Operator Menu

Phase 1 runnable commands are marked [local]. Future commands are documented but not active.

Project Control
- /status - Show all active projects and next actions. [local]
- /next - Recommend next project priority. [future]
- /repo <project> - Summarize a project repository. [future]
- /pr <project> - Summarize latest project PR state. [future]
- /handoff <project> - Create compact handoff for ChatGPT or Codex. [future]

Codex Workflow
- /codex <project> <phase-or-task> - Generate compact Codex prompt. [future]
- /codex-budget <project> <task> - Estimate Codex task size. [future]
- /prompt-size <draft> - Review and compress long Codex prompts. [future]
- /split-task <task> - Split large tasks into smaller phases. [future]

Usage & Limits
- /codex-usage - Show manually tracked Codex usage status. [future]
- /update-usage <provider> <status> - Manually update usage status. [future]

System & Safety
- /vps-health - Check future VPS health. [future]
- /safe-mode - Show safety boundaries. [future]
- /menu [category] - Show command menu. [local]
- /help - Explain phone usage. [local]

Expansion
- /content <project> - Turn project progress into content ideas. [future]
- /feature-request <idea> - Format a future feature idea. [future]
- /backlog - List planned future features. [future]

Phase 1 boundary: no live APIs, no secrets, no writes.
```

Filtered examples:

```bash
node local-operator/simulate-command.mjs /menu project
node local-operator/simulate-command.mjs /menu codex
node local-operator/simulate-command.mjs /menu system
```


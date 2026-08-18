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

Phase 3B PPO-routed commands are marked [local] or [github read-only]. Terminal Codex prompt/planning commands are local-only.

Project Control
- /ppo status - Show live GitHub project status. [github read-only]
- /ppo next - Recommend next project priority. [future]
- /ppo repo <project> - Summarize a project repository. [github read-only]
- /ppo pr <project> - Summarize latest project PR state. [github read-only]
- /ppo handoff <project> - Create compact handoff for ChatGPT or Codex. [future]

Codex Workflow
- /ppo codex <project> <phase-or-task> - Generate compact Codex prompt. [future]
- /ppo codex-budget <project> <task> - Estimate Codex task size. [future]
- /ppo prompt-size <draft> - Review and compress long Codex prompts. [future]
- /ppo split-task <task> - Split large tasks into smaller phases. [future]

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

Phase 3B boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; terminal Codex prompt/planning commands are local-only; no writes.
```

Filtered Telegram examples:

```text
/ppo menu project
/ppo menu codex
/ppo menu system
```

# Example PPO Terminal Run

Run these from the repo root before routing Telegram messages through OpenClaw:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs repo rbl-content-engine
node local-operator/ppo-command.mjs pr khlim-assist
node local-operator/ppo-command.mjs pr rbl-content-engine
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
node local-operator/ppo-command.mjs codex rbl-content-engine "organize source asset workflow"
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build one focused feature"
node local-operator/ppo-command.mjs split-task "add GitHub integration and Telegram routing"
node local-operator/ppo-command.mjs "/ppo codex-budget ledgerpilot-ai add invoice import workflow"
node local-operator/ppo-command.mjs "/ppo prompt-size Goal: build one focused feature"
node local-operator/ppo-command.mjs "/ppo split-task add GitHub integration and Telegram routing"
node local-operator/ppo-command.mjs /ppo start khlim-assist
node local-operator/ppo-command.mjs unknown
```

The wrapper also accepts a full Telegram-style text payload:

```bash
node local-operator/ppo-command.mjs "/ppo status"
```

Expected unsupported-command behavior:

```text
Unsupported PPO command: unknown

PPO wrapper supports only:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help
- /ppo repo <project>
- /ppo pr <project>
- /ppo codex <project> <task>
- /ppo codex-budget <project> <task>
- /ppo prompt-size <draft>
- /ppo split-task <task>
- /ppo issue-create <project> <title> [--body <body>]
- /ppo issue-confirm <request-id>
- /ppo note-add <project> <note...>
- /ppo note-confirm <request-id>
- /ppo start <project>
- /ppo runs
- /ppo run <run-id>
- /ppo cancel <run-id>
- /ppo cancel-confirm <request-id>
- /ppo continue <run-id>
- /ppo recover <run-id>

Terminal-only additions:
- issue-create <project> <title> [body...]
- note-add <project> <note...>
- state-promote <project> <note-id> <current-phase|last-known-status|next-action>

Try: node local-operator/ppo-command.mjs menu
```

Expected built-in protection:

```bash
node local-operator/ppo-command.mjs /status
```

```text
Unsupported PPO command: /status

PPO wrapper supports only:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help
- /ppo repo <project>
- /ppo pr <project>
- /ppo codex <project> <task>
- /ppo codex-budget <project> <task>
- /ppo prompt-size <draft>
- /ppo split-task <task>
- /ppo issue-create <project> <title> [--body <body>]
- /ppo issue-confirm <request-id>
- /ppo note-add <project> <note...>
- /ppo note-confirm <request-id>
- /ppo start <project>
- /ppo runs
- /ppo run <run-id>
- /ppo cancel <run-id>
- /ppo cancel-confirm <request-id>
- /ppo continue <run-id>
- /ppo recover <run-id>

Terminal-only additions:
- issue-create <project> <title> [body...]
- note-add <project> <note...>
- state-promote <project> <note-id> <current-phase|last-known-status|next-action>

Try: node local-operator/ppo-command.mjs menu
```

Safety:

- The wrapper routes `/ppo status`, `/ppo repo`, and `/ppo pr` to GitHub read-only handlers.
- The wrapper routes `/ppo codex <project> <task>` to local text prompt generation.
- The wrapper routes `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` to local deterministic planning tools.
- The wrapper routes `/ppo start <project>` to controlled Phase 6B planned-run creation and never continues automatically.
- The wrapper keeps `/ppo menu` and `/ppo help` on the local simulator path.
- The wrapper does not call Telegram APIs.
- The wrapper does not modify OpenClaw config.
- The wrapper does not write to external systems.

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
node local-operator/ppo-command.mjs pr khlim-assist
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build one focused feature"
node local-operator/ppo-command.mjs split-task "add GitHub integration and Telegram routing"
node local-operator/ppo-command.mjs unknown
```

The wrapper also accepts a full Telegram-style text payload:

```bash
node local-operator/ppo-command.mjs "/ppo status"
```

Expected unsupported-command behavior:

```text
Unsupported PPO command: unknown

Phase 3B supports only:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help
- /ppo repo <project>
- /ppo pr <project>
- terminal only: codex <project> <task>
- terminal only: codex-budget <project> <task>
- terminal only: prompt-size <draft>
- terminal only: split-task <task>

Try: node local-operator/ppo-command.mjs menu
```

Expected built-in protection:

```bash
node local-operator/ppo-command.mjs /status
```

```text
Unsupported PPO command: /status

Phase 3B supports only:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help
- /ppo repo <project>
- /ppo pr <project>
- terminal only: codex <project> <task>
- terminal only: codex-budget <project> <task>
- terminal only: prompt-size <draft>
- terminal only: split-task <task>

Try: node local-operator/ppo-command.mjs menu
```

Safety:

- The wrapper routes `/ppo status`, `/ppo repo`, and `/ppo pr` to GitHub read-only handlers.
- The wrapper routes terminal-only `codex <project> <task>` to local text prompt generation.
- The wrapper routes terminal-only `codex-budget`, `prompt-size`, and `split-task` to local deterministic planning tools.
- The wrapper rejects `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task`.
- The wrapper keeps `/ppo menu` and `/ppo help` on the local simulator path.
- The wrapper does not call Telegram APIs.
- The wrapper does not modify OpenClaw config.
- The wrapper does not write to external systems.

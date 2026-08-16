# Example PPO Terminal Run

Run these from the repo root before routing Telegram messages through OpenClaw:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
node local-operator/ppo-command.mjs unknown
```

The wrapper also accepts a full Telegram-style text payload:

```bash
node local-operator/ppo-command.mjs "/ppo status"
```

Expected unsupported-command behavior:

```text
Unsupported PPO command: unknown

Phase 1.5 supports only:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help

Try: node local-operator/ppo-command.mjs menu
```

Expected built-in protection:

```bash
node local-operator/ppo-command.mjs /status
```

```text
Unsupported PPO command: /status

Phase 1.5 supports only:
- /ppo status
- /ppo menu
- /ppo menu project
- /ppo menu codex
- /ppo menu system
- /ppo help

Try: node local-operator/ppo-command.mjs menu
```

Safety:

- The wrapper calls only the local simulator.
- The wrapper does not call Telegram APIs.
- The wrapper does not call GitHub APIs.
- The wrapper does not modify OpenClaw config.
- The wrapper does not write to external systems.

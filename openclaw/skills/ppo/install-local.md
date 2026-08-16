# Local Install Notes

These notes describe how to prepare local OpenClaw routing manually. The repo does not modify `~/.openclaw` automatically.

## Preconditions

- OpenClaw is installed locally.
- Telegram is connected to OpenClaw locally.
- This repo is available on the same MacBook.
- Node.js is available.
- The Phase 1 simulator works from terminal.

## Verify wrapper first

From the repo root, these commands should succeed:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
node local-operator/ppo-command.mjs "/ppo status"
```

These commands should fail safely with a non-zero terminal exit:

```bash
node local-operator/ppo-command.mjs unknown
node local-operator/ppo-command.mjs /status
```

## Routing intent

Configure OpenClaw manually so messages beginning with `/ppo` are routed to the wrapper.

Conceptual mapping:

```text
/ppo status       -> node local-operator/ppo-command.mjs status
/ppo menu         -> node local-operator/ppo-command.mjs menu
/ppo menu project -> node local-operator/ppo-command.mjs menu project
/ppo menu codex   -> node local-operator/ppo-command.mjs menu codex
/ppo menu system  -> node local-operator/ppo-command.mjs menu system
/ppo help         -> node local-operator/ppo-command.mjs help
```

If OpenClaw passes the full message text instead of split arguments, the wrapper can also accept quoted text such as:

```bash
node local-operator/ppo-command.mjs "/ppo status"
```

Use the absolute repo path in local OpenClaw config if OpenClaw requires one.

## Do not route built-ins

Do not override:

```text
/status
/menu
/help
```

OpenClaw owns those commands. Personal Project Operator uses `/ppo`.

The wrapper intentionally rejects bare slash commands such as `/status`.

## Telegram test messages

Send these from Telegram after OpenClaw routing is configured:

```text
/ppo status
/ppo menu
/ppo menu project
/ppo menu codex
/ppo menu system
/ppo help
```

## Safety boundary

This setup is local-only.

Do not add:

- bot tokens to the repo
- GitHub tokens
- Telegram API calls in repo code
- VPS deployment scripts
- Codex usage scraping
- write actions

# /help

## Command name

`/help`

## Purpose

Explain how to use Personal Project Operator from a phone.

## Input format

```text
/help
```

## Example input

```text
/help
```

## Expected output

The help text should direct users to `/menu` and show short examples:

```text
Personal Project Operator Help
- Use /menu to see available commands.
- Use /status to see project state.
- Use /next to choose what to work on first.
- Use /repo <project> for a repository summary.
- Use /codex <project> <task> to prepare a compact Codex prompt.

Start with: /menu
```

## Safety boundary

Help display only. Do not trigger project actions.

## Future upgrade path

- Add context-aware help for each command.
- Add examples based on the selected project.
- Add platform-specific instructions for Telegram, Discord, Slack, WhatsApp, Signal, and generic chat.


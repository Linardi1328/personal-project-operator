# /menu

## Command name

`/menu`

## Purpose

Show available commands grouped by category.

## Input format

```text
/menu
/menu project
/menu codex
/menu system
```

## Example input

```text
/menu codex
```

## Expected output

Categories:

- Project Control
- Codex Workflow
- Usage & Limits
- System & Safety
- Expansion

Example:

```text
Codex Workflow
- /codex <project> <phase-or-task>
- /codex-budget <project> <task>
- /prompt-size <draft>
- /split-task <task>
- /handoff <project>
```

## Safety boundary

Menu display only. Do not execute commands from the menu without an explicit user command.

## Future upgrade path

- Add platform-specific inline buttons.
- Add project-specific menus.
- Hide disabled commands unless requested.


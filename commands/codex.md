# /codex

## Command name

`/codex <project> <phase-or-task>`

## Purpose

Generate a compact Codex prompt for implementation, review, bugfix, docs, or hardening work.

## Input format

```text
/codex <project> <phase-or-task>
```

## Example input

```text
/codex khlim-assist phase-1-readonly-github-summary
```

## Expected output

The prompt must include:

- goal
- exact scope
- files/components to inspect
- requirements
- tests/checks
- safety boundaries
- exit criteria

The prompt must avoid repeated project background and include only the current task context.

Example:

```text
Codex Prompt

Goal:
Implement a read-only repository summary command for KHLIM Assist.

Scope:
- Inspect the existing command registry and project docs.
- Add only the minimal code/docs required for the command.

Safety:
- Do not write to GitHub.
- Do not add credentials.
- Do not add deployment behavior.

Exit criteria:
- Command output matches documented format.
- Tests or manual checks are listed.
```

## Safety boundary

The command generates text only. It must not run Codex automatically, change files, or trigger external writes.

## Future upgrade path

- Add project-aware prompt templates.
- Add budget-aware prompt compression.
- Add automatic phase splitting for oversized tasks.


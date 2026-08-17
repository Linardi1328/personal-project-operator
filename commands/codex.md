# codex

## Command name

`codex <project> <phase-or-task>`

## Purpose

Generate a compact local Codex prompt for implementation, review, bugfix, docs, or hardening work.

Phase 3A is terminal-only:

```bash
node local-operator/ppo-command.mjs codex <project> <phase-or-task>
```

Do not expose `/ppo codex` through Telegram/OpenClaw in Phase 3A.

## Example input

```bash
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
```

## Expected output

The generated text prompt includes:

- project
- repository
- task
- simple deterministic task-size estimate
- goal
- curated project-document context
- live GitHub read-only facts
- exact scope
- requirements
- tests/checks
- safety boundaries
- exit criteria

Example:

```text
Codex Prompt

Project:
KHLIM Assist

Repository:
Linardi1328/khlim-assist

Task:
add provider validation tests

Task Size Estimate:
Small

Goal:
Implement the requested task for KHLIM Assist.

Scope:
- Exact work requested: add provider validation tests
- Inspect the target repository before naming or editing files.
- Keep changes focused on the requested task.
```

## Safety boundary

The command generates text only. It must not run Codex automatically, call OpenAI APIs, invoke another model, change files in target project repositories, expose Telegram routing, or trigger external writes.

The task string is data only. It must not be interpreted as a shell command, file path, filename, or executable code.

## Future upgrade path

- Add budget-aware prompt compression.
- Add automatic phase splitting for oversized tasks.
- Review Telegram/OpenClaw routing only after Phase 3A approval.

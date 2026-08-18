# codex

## Command name

`codex <project> <phase-or-task>`

## Purpose

Generate a compact local Codex prompt for implementation, review, bugfix, docs, or hardening work.

Phase 3A introduced the terminal command:

```bash
node local-operator/ppo-command.mjs codex <project> <phase-or-task>
```

Phase 3C routes the same deterministic text generator through:

```text
/ppo codex <project> <phase-or-task>
```

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

The command generates text only. It must not run Codex automatically, call OpenAI APIs, invoke another model, change files in target project repositories, or trigger external writes.

The task string is data only. It must not be interpreted as a shell command, file path, filename, or executable code.

## Future upgrade path

- Keep richer budget-aware prompt compression behind later review.
- Keep automatic per-phase prompt generation behind later review.
- Keep richer arbitrary text workflows behind later review.

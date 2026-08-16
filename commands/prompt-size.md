# /prompt-size

## Command name

`/prompt-size <draft>`

## Purpose

Review and compress a long Codex prompt.

## Input format

```text
/prompt-size <draft>
```

## Example input

```text
/prompt-size Please build the whole operator with GitHub, Telegram, VPS, and Codex integration...
```

## Expected output

The command should encourage:

- removing repeated background
- keeping the current goal only
- listing exact scope
- including tests
- including exit criteria
- including do-not-change rules

Example:

```text
Prompt Size Review
- Estimate: too broad
- Remove: repeated project background and future phases.
- Keep: current goal, files to inspect, requirements, tests, safety boundaries.
- Suggested split: docs first, then read-only GitHub, then prompt generator.
```

## Safety boundary

Text review only. Do not execute the prompt or edit project files.

## Future upgrade path

- Add token estimate heuristics.
- Add compact rewrite output.
- Link to task-size rules and Codex templates.


# /codex-budget

## Command name

`/codex-budget <project> <task>`

## Purpose

Estimate the expected Codex task size before generating or running a prompt.

## Input format

```text
/codex-budget <project> <task>
```

## Example input

```text
/codex-budget ledgerpilot-ai add invoice import workflow
```

## Expected output

Use these categories:

- `Small`
- `Medium`
- `Large`
- `Too large - split required`

Factors:

- repo size
- number of files likely affected
- whether tests are needed
- whether UI/backend/database changes are involved
- whether the task requires research or architecture changes

Example:

```text
Codex Budget Estimate
- Project: LedgerPilot AI
- Task: add invoice import workflow
- Estimate: Large
- Reason: likely touches backend, frontend, data validation, and tests.
- Suggested action: split into parser, UI, persistence, hardening, and review phases.
```

## Safety boundary

This is an estimate only. It must not start implementation or spend Codex usage.

## Future upgrade path

- Combine repo metadata, task history, and current usage status.
- Suggest prompt split automatically when estimate is large.


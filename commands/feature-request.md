# /feature-request

## Command name

`/feature-request <idea>`

## Purpose

Document a future feature idea for the operator or a managed project.

## Input format

```text
/feature-request <idea>
```

## Example input

```text
/feature-request add weekly project digest from GitHub state
```

## Expected output

The output should include:

- feature name
- category
- priority
- dependencies
- safety level
- suggested phase

Example:

```text
Feature Request
- Name: Weekly project digest
- Category: project management
- Priority: Medium
- Dependencies: GitHub read-only integration
- Safety level: safe
- Suggested phase: Phase 2 or later
```

## Safety boundary

Phase 0 documents behavior only. Do not create GitHub issues or modify backlog files automatically.

## Future upgrade path

- Append approved ideas to a backlog file.
- Create GitHub issues only after explicit approval in a write-enabled phase.


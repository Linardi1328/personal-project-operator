# /backlog

## Command name

`/backlog`

## Purpose

List planned future features grouped by area.

## Input format

```text
/backlog
```

## Example input

```text
/backlog
```

## Expected output

Group by:

- project management
- GitHub integration
- Codex workflow
- VPS/system monitoring
- content workflow
- business automation

Example:

```text
Backlog

Project management
- Project priority scoring
- Project state freshness check

GitHub integration
- Read-only repo summary
- Read-only PR summary

Codex workflow
- Prompt generator
- Task splitter
```

## Safety boundary

Read-only planning output. Do not create issues, edit project boards, or change repo files unless a future approved write action allows it.

## Future upgrade path

- Read from a structured backlog file.
- Filter by priority, project, or phase.
- Create approved GitHub issues in Phase 5.


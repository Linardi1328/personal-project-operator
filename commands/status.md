# /status

## Command name

`/status`

## Purpose

Show all active projects and their current next action in a phone-friendly summary.

## Input format

```text
/status
```

## Example input

```text
/status
```

## Expected output

For each active project:

- project name
- repo
- current phase
- last known status
- next action
- whether Codex is needed

Example:

```text
Project Status

KHLIM Assist
- Repo: Linardi1328/khlim-assist
- Current phase: Phase 0 documentation
- Last known status: connected candidate
- Next action: prepare read-only GitHub summary
- Codex needed: not yet
```

## Safety boundary

Phase 0 uses documented project state only. Future versions may read GitHub metadata but must not write to GitHub or modify repos.

## Future upgrade path

- Read project state from local docs.
- Add GitHub read-only repo and PR summaries.
- Add stale-project detection.
- Add Codex usage-aware next action recommendations.


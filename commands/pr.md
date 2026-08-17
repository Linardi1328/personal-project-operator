# /pr

## Command name

`/ppo pr <project>`

## Purpose

Summarize latest pull request state for a project.

## Input format

```text
/ppo pr <project>
```

## Example input

```text
/ppo pr ledgerpilot-ai
```

## Expected output

Phase 2B implements a compact GitHub read-only subset:

- source marker
- repository full name
- open PR count
- PR number
- title
- head branch
- base branch
- draft status
- updated timestamp

Example:

```text
PR Summary: LedgerPilot AI
Source: GitHub read-only
Repo: Linardi1328/ledgerpilot-ai
Open PRs: 1
- #12 Add reconciliation checks [feature/reconcile -> main, draft] updated 2026-08-16T15:00:00Z
```

## Safety boundary

Read-only only. This command must not approve, close, merge, retarget, label, or comment on PRs. Phase 2B uses only the approved Phase 2A open-pulls endpoint family.

## Future upgrade path

- Summarize changed files and test status.
- Generate review or hardening prompts for Codex.
- Add review, comment, CI/check, diff, or recommendation details only after separate approval.

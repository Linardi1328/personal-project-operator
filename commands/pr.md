# /pr

## Command name

`/pr <project>`

## Purpose

Summarize latest pull request state for a project.

## Input format

```text
/pr <project>
```

## Example input

```text
/pr ledgerpilot-ai
```

## Expected output

Phase 0 documents the format only. Future read-only output should include:

- open PRs
- latest branch
- changed files
- CI/check status if available
- whether review or hardening is needed

Example:

```text
PR Summary: LedgerPilot AI
- Open PRs: future read-only GitHub data
- Latest branch: future read-only GitHub data
- Checks: future read-only GitHub data
- Review needed: future recommendation
```

## Safety boundary

Read-only only. This command must not approve, close, merge, retarget, label, or comment on PRs in Phase 0.

## Future upgrade path

- Add read-only GitHub PR fetch.
- Summarize changed files and test status.
- Generate review or hardening prompts for Codex.


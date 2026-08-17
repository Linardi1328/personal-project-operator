# /repo

## Command name

`/ppo repo <project>`

## Purpose

Summarize a project repository.

## Input format

```text
/ppo repo <project>
```

## Example input

```text
/ppo repo khlim-assist
```

## Expected output

Phase 2B implements a compact GitHub read-only subset:

- source marker
- repository full name
- default branch
- visibility
- description when available
- last updated time
- pushed time
- recent commits, bounded by the Phase 2A read-only client

Example:

```text
Repo Summary: KHLIM Assist
Source: GitHub read-only
Repo: Linardi1328/khlim-assist
Default branch: main
Visibility: private
Description: Admin workflow assistant
Updated: 2026-08-16T10:00:00Z
Pushed: 2026-08-16T11:00:00Z
Recent commits:
- abc1234 Add reporting view (Richie, 2026-08-16T12:00:00Z)
```

## Safety boundary

Read-only only. This command must never push, pull with mutation, create branches, edit files, or trigger CI. Phase 2B uses only the approved Phase 2A repo metadata and commits endpoint families.

## Future upgrade path

- Summarize README and repo structure.
- Detect important project files such as config, tests, migrations, and app entrypoints.
- Add branches, languages, releases, or workflow details only after separate approval.

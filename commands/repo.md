# /repo

## Command name

`/repo <project>`

## Purpose

Summarize a project repository.

## Input format

```text
/repo <project>
```

## Example input

```text
/repo khlim-assist
```

## Expected output

Phase 0 documents the format only. Future read-only output should include:

- default branch
- latest commit
- active branch if known
- README summary
- last updated time
- important files

Example:

```text
Repo Summary: KHLIM Assist
- Repo: Linardi1328/khlim-assist
- Default branch: future read-only GitHub data
- Latest commit: future read-only GitHub data
- README summary: future generated summary
- Important files: future detected list
```

## Safety boundary

Read-only only. This command must never push, pull with mutation, create branches, edit files, or trigger CI.

## Future upgrade path

- Add GitHub API read-only metadata.
- Summarize README and repo structure.
- Detect important project files such as config, tests, migrations, and app entrypoints.


# /status

## Command name

`/ppo status`

## Purpose

Show all active projects and their current next action in a phone-friendly summary.

## Input format

```text
/ppo status
```

## Example input

```text
/ppo status
```

## Expected output

Phase 2C implements a compact GitHub read-only project status summary for the connected projects in the fixed registry.

For each project:

- project name
- repository full name
- default branch
- latest returned recent commit
- bounded open PR count
- conservative bounded open issue count
- repository updated timestamp

Example:

```text
Project Status
Source: GitHub read-only

KHLIM Assist
- Repo: Linardi1328/khlim-assist
- Default: main
- Latest: 1dd9e08 Merge pull request #5
- Open PRs: none
- Open issues: none
- Updated: 2026-08-16T19:09:45Z
```

## Safety boundary

Phase 2C uses only approved GitHub read-only endpoint families through the local Phase 2A client. It must not write to GitHub, modify repos, trigger workflows, or add new endpoint families.

Issue counts are exact only when the bounded GitHub issues page is not saturated. If the raw page limit is hit, `/ppo status` uses a conservative `+` label or `unknown (page limit hit)` after pull requests are filtered out.

## Future upgrade path

- Add stale-project detection.
- Add Codex usage-aware next action recommendations.
- Add priority or urgency ranking.
- Add richer read-only repo or PR details only after separate approval.

# /update-usage

## Command name

`/update-usage <provider> <status>`

## Purpose

Allow manual updates to tracked usage status.

## Input format

```text
/update-usage <provider> <status>
```

## Example input

```text
/update-usage codex available
/update-usage codex near-limit
/update-usage codex limit-reached
/update-usage credits 12.50
```

## Expected output

Example:

```text
Usage Updated
- Provider: codex
- Status: near-limit
- Last updated: manually supplied timestamp
- Recommended task size: Small
- Suggested action: split large tasks before using Codex.
```

## Safety boundary

Phase 0 documents behavior only. Future implementations may update a local usage state file after explicit approval, but must not scrape accounts or call billing APIs by default.

## Future upgrade path

- Store updates in a local state file.
- Add provider-specific status validation.
- Feed current status into `/codex-budget`, `/next`, and `/codex`.


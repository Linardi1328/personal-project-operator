# /codex-usage

## Command name

`/codex-usage`

## Purpose

Show the current manually tracked Codex usage status.

## Input format

```text
/codex-usage
```

## Example input

```text
/codex-usage
```

## Expected output

```text
Codex Usage Status
- Status: available / near-limit / limit-reached / unknown
- Last updated:
- Remaining credits/tokens if manually provided:
- Recommended task size:
- Suggested action:
```

## Safety boundary

Manual-first only. Do not claim that Codex remaining tokens, credits, or limits can always be retrieved automatically. Do not scrape usage screens or call paid APIs in Phase 0.

## Future upgrade path

- Store manually supplied status in a local state file.
- Add usage-aware task recommendations.
- Add optional provider-specific integrations only if reliable and approved.


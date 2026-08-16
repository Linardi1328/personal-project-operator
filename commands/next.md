# /next

## Command name

`/next`

## Purpose

Rank which project should receive attention first.

## Input format

```text
/next
```

## Example input

```text
/next
```

## Expected output

Rank projects by:

- blocked status
- open PR waiting for review
- current business or project urgency
- Codex usage availability
- whether the task can be done safely from a phone

Example:

```text
Next Recommended Focus
1. KHLIM Assist - highest operational value, safe to inspect from phone.
2. LedgerPilot AI - important, but likely needs larger Codex budget.
3. Portfolio Website - suitable for small polish tasks.
```

## Safety boundary

The command recommends attention only. It must not start implementation, open PRs, merge code, deploy, or contact users.

## Future upgrade path

- Combine manual priorities with read-only GitHub state.
- Consider Codex usage status.
- Add manual override tags such as `urgent`, `blocked`, or `paused`.


# /safe-mode

## Command name

`/safe-mode`

## Purpose

Show blocked actions and the current safety posture.

## Input format

```text
/safe-mode
```

## Example input

```text
/safe-mode
```

## Expected output

Blocked by default:

- merge PRs
- push code
- delete branches
- deploy production changes
- send customer messages
- expose secrets
- change credentials
- execute trades
- make paid API calls without approval

Example:

```text
Safe Mode
- Status: enabled
- Default access: read-only
- Write actions: disabled in Phase 0
- Dangerous actions: blocked
```

## Safety boundary

This command describes safety rules only. It must not toggle dangerous behavior in Phase 0.

## Future upgrade path

- Show current permission configuration.
- Add explicit approval gates.
- Add audit log for approved write actions.


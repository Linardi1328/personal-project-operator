# /split-task

## Command name

`/split-task <task>`

## Purpose

Break a large development task into smaller Codex phases.

## Input format

```text
/split-task <task>
```

## Example input

```text
/split-task add GitHub integration, Telegram bot, Codex prompt generator, and VPS deployment
```

## Expected output

```text
Recommended split:
1. Phase A
2. Phase B
3. Hardening
4. Review
```

Example:

```text
Recommended split:
1. Phase A - document command behavior and state files.
2. Phase B - implement read-only GitHub metadata fetch.
3. Hardening - add error handling, rate-limit behavior, and tests.
4. Review - inspect security boundaries and output quality.
```

## Safety boundary

Planning only. Do not start implementation, deployment, or external API setup.

## Future upgrade path

- Combine with `/codex-budget`.
- Generate one compact Codex prompt per phase.
- Track phase completion in project state docs.


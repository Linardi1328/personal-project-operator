# split-task

## Command name

`split-task <task>`

## Purpose

Produce a deterministic local split for broad development work.

Phase 3B introduced the terminal command:

```bash
node local-operator/ppo-command.mjs split-task <task>
```

Phase 3C routes the same deterministic text command through:

```text
/ppo split-task <task>
```

## Example input

```bash
node local-operator/ppo-command.mjs split-task "add GitHub integration, Telegram bot, Codex prompt generator, VPS deployment, and write actions"
```

## Expected output

The output includes:

- original inert task text
- the same deterministic task-size estimate used by `codex`
- a split-not-required workflow for small tasks
- an optional short workflow for medium tasks
- focused domain phases for large or too-large tasks
- hardening and review phases where appropriate

Detected domains use a fixed order:

- documentation
- GitHub/repository
- Telegram/OpenClaw/routing
- Codex/prompt tooling
- frontend/UI
- backend/API
- database/schema/migration
- deployment/VPS/production
- write actions/mutations/permissions
- tests/hardening/security

The split is bounded to eight phases.

## Write-action boundary

If the task mentions write actions, mutations, merges, pushes, issue creation, or other external writes, the output labels that work as permission-gated design. It does not authorize implementation. Separate explicit approval is required for any write outside the Phase 5A/5B controlled issue creation paths.

## Safety boundary

This command plans only. It must not invoke Codex, call OpenAI APIs, call another model, execute generated plans, mutate repositories, create branches, commit, push, create issues, open or merge PRs, deploy services, or edit OpenClaw configuration.

The task string is data only. Shell-looking punctuation, `$()`, backticks, and paths are not executed or interpreted.

## Future upgrade path

- Generate per-phase Codex prompts only after separate approval.
- Keep richer arbitrary text workflows behind later review.

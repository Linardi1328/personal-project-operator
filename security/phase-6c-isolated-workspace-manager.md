# Phase 6C Isolated Workspace Manager Safety Boundary

Phase 6C adds one local workspace manager foundation:

```text
local-operator/development-workspace-manager.mjs
```

It prepares exactly one isolated implementation branch/worktree for a Phase 6A run that is already `planned`.

## Allowed

Phase 6C may:

- resolve project ids through the existing five-project registry only
- read one Phase 6A run record from `${PPO_WRITE_DATA_DIR}/development-runs`
- require exact expected-version optimistic concurrency
- read source repository facts through bounded local Git argv calls
- create one deterministic branch from exactly `run.baseSha`
- create one worktree under a PPO-managed workspace root
- remove a branch/worktree only during definite cleanup
- transition `planned -> implementation_in_progress` after workspace verification
- attach metadata-only SHA-pinned implementation evidence
- inspect a recorded workspace read-only for restart recovery

## Blocked

Phase 6C must not:

- accept repository paths from user text, task text, planner output, or project Markdown
- operate on repos outside the configured project workspace registry
- operate when the source repo is missing, unsafe, not Git, dirty, or identity-mismatched
- use shell interpolation for Git
- develop in `main`, `master`, or a default branch worktree
- store credentials, raw Git output, raw failures, arbitrary user-controlled paths, or unbounded logs
- invoke Codex, OpenAI, or another model
- edit implementation files
- run automated tests
- call GitHub writes
- push, merge, rebase, reset, cherry-pick, or create commits
- deploy, restart services, or roll back
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

Errors must be deterministic and safe. Ambiguous mutation outcomes must fail closed and require reconciliation before retry.
